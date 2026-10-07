import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { APPLICATION_SECRET, config } from './config.js';
import { pool, requirePool } from './db/pool.js';
import { AuthService } from './services/auth-service.js';
import { PostgresTransactionRepository } from './repositories/transaction-repository.js';
import { PostgresEscrowRepository } from './repositories/postgres-escrow-repository.js';
import { EscrowService, ResourceNotFoundError, AuthorizationError, ValidationError, ConflictError } from './services/escrow-service.js';
import { createAuthRouter } from './routes/auth-routes.js';
import { createTransactionRouter } from './routes/transaction-routes.js';
import { createAdminRouter } from './routes/admin-routes.js';
import { IdempotencyConflictError, IdempotencyKeyError } from './db/idempotency.js';
import { ZodError } from 'zod';
import { EngineOnlyTransitionError, InvalidTransitionError } from './domain/escrow.js';
import { CloudinaryObjectStorage } from './adapters/object-storage.js';
import { EvidenceService } from './services/evidence-service.js';
import { createEvidenceRouter } from './routes/evidence-routes.js';
import { createWhatsAppRouter } from './routes/whatsapp-routes.js';
import { createNombaRouter } from './routes/nomba-routes.js';
import { createPayoutDestinationRouter } from './routes/payout-destination-routes.js';
import { CheckoutService, PostgresCheckoutRepository } from './services/checkout-service.js';
import { createCheckoutRouter } from './routes/checkout-routes.js';

/**
 * Number of migrations that must be applied before the API can serve traffic.
 * Readiness compares the applied count against this, so adding a migration
 * without raising it would let a deployment report ready against a schema that
 * is missing the newest file.
 */
const REQUIRED_MIGRATION_COUNT = 12;

/**
 * Object storage is optional in the sense that the API still boots without it,
 * but a deployment that reaches production without it silently loses evidence
 * uploads, so readiness treats it as required rather than degrading quietly.
 */
function objectStorageConfigured(): boolean {
  return Boolean(config.CLOUDINARY_CLOUD_NAME && config.CLOUDINARY_API_KEY && config.CLOUDINARY_API_SECRET);
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-CSRF-Token'],
  }));
  app.use(express.json({
    limit: '1mb',
    verify: (request, _response, body) => {
      (request as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(body);
    },
  }));
  app.use(cookieParser());

  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.get('/health/ready', async (_request, response) => {
    if (!pool) {
      response.status(503).json({ status: 'not_ready', reason: 'database_not_configured' });
      return;
    }
    try {
      await requirePool().query('select 1');
      const migrations = await requirePool().query<{ applied: string }>('select count(*)::text as applied from schema_migrations');
      if (Number(migrations.rows[0]?.applied ?? 0) < REQUIRED_MIGRATION_COUNT) {
        response.status(503).json({ status: 'not_ready', reason: 'database_migrations_incomplete' });
        return;
      }
      if (!objectStorageConfigured()) {
        response.status(503).json({ status: 'not_ready', reason: 'object_storage_not_configured' });
        return;
      }
      response.status(200).json({ status: 'ready' });
    } catch {
      response.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
    }
  });

  if (pool) {
    const auth = new AuthService(pool, APPLICATION_SECRET);
    // Mounted outside /api and without a session: the payment link is the only
    // unauthenticated read, and it answers to the token in the path.
    app.use(createCheckoutRouter(new CheckoutService(new PostgresCheckoutRepository(pool))));
    app.use('/api/auth', createAuthRouter(auth));
    app.use('/api/transactions', createTransactionRouter(
      auth,
      new PostgresTransactionRepository(pool),
      new EscrowService(new PostgresEscrowRepository()),
    ));
    if (objectStorageConfigured()) {
      app.use('/api', createEvidenceRouter(auth, new EvidenceService(pool, new CloudinaryObjectStorage())));
    }
    app.use('/api/admin', createAdminRouter(pool, auth, new EscrowService(new PostgresEscrowRepository())));
    app.use('/api/accounts/payout-destination', createPayoutDestinationRouter(pool, auth));
    app.use('/api/whatsapp', createWhatsAppRouter(pool, auth, new PostgresTransactionRepository(pool), new EscrowService(new PostgresEscrowRepository())));
    app.use('/api/internal/nomba', createNombaRouter(pool, new EscrowService(new PostgresEscrowRepository())));
  } else {
    // Without DATABASE_URL no route above is mounted, so an /api request would
    // fall through to the catch-all 404. That reads as a routing mistake and
    // sends an operator looking for a bad path instead of a missing variable.
    app.use('/api', (_request, response) => {
      response.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'DATABASE_URL is not configured on this API instance' } });
    });
  }

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      response.status(422).json({
        error: {
          code: 'VALIDATION',
          message: 'Request validation failed',
          fields: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
      return;
    }
    if (error instanceof IdempotencyConflictError) {
      response.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: error.message } });
      return;
    }
    if (error instanceof IdempotencyKeyError) {
      response.status(400).json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: error.message } });
      return;
    }
    if (error instanceof EngineOnlyTransitionError) {
      response.status(422).json({ error: { code: 'ENGINE_ONLY_TRANSITION', message: error.message } });
      return;
    }
    if (error instanceof InvalidTransitionError) {
      response.status(409).json({ error: { code: 'INVALID_TRANSITION', message: error.message } });
      return;
    }
    if (error instanceof Error && error.message === 'REFUND_NOT_RECONCILABLE') {
      response.status(409).json({ error: { code: 'REFUND_NOT_RECONCILABLE', message: 'Refund attempt is no longer awaiting reconciliation' } });
      return;
    }
    if (error instanceof ResourceNotFoundError) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
      return;
    }
    if (error instanceof AuthorizationError) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: error.message } });
      return;
    }
    if (error instanceof ValidationError) {
      response.status(422).json({ error: { code: 'VALIDATION', message: error.message } });
      return;
    }
    if (error instanceof ConflictError) {
      response.status(409).json({ error: { code: 'CONFLICT', message: error.message } });
      return;
    }
    // RangeError is how the domain and the auth service signal a rejected
    // value (an amount that cannot be represented, a phone channel on an
    // account with no phone). It is a client mistake, not a server fault.
    if (error instanceof RangeError) {
      response.status(422).json({ error: { code: 'VALIDATION', message: error.message } });
      return;
    }
    // PostgreSQL 22P02 is a malformed uuid or numeric literal reaching the
    // database, which is always a malformed request from a client.
    if (error && typeof error === 'object' && 'code' in error && error.code === '22P02') {
      response.status(422).json({ error: { code: 'VALIDATION', message: 'A path parameter is malformed' } });
      return;
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      response.status(409).json({ error: { code: 'ALREADY_EXISTS', message: 'A record with this value already exists' } });
      return;
    }
    console.error('Unhandled API error', error);
    response.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  return app;
}