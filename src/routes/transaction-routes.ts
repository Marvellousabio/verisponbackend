import { Router } from 'express';
import { z } from 'zod';
import { idempotencyContext } from '../db/idempotency.js';
import { TRANSACTION_STATES } from '../domain/escrow.js';
import type { AuthService } from '../services/auth-service.js';
import { AuthorizationError, ConflictError, EscrowService, ResourceNotFoundError, ValidationError } from '../services/escrow-service.js';
import { requireAuth } from '../middleware/auth.js';
import { requireSameOrigin } from '../middleware/same-origin.js';
import { PostgresTransactionRepository } from '../repositories/transaction-repository.js';

const createSchema = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().max(2000).optional(),
  amount_kobo: z.number().int().positive().safe(),
  counterparty_reference: z.string().trim().min(1).max(32),
  // Condition photos are opt-in and may be requested by either role; the flag
  // only ever turns the gate on, so a client cannot use it to relax one.
  photos_enabled: z.boolean().optional(),
});
const listSchema = z.object({
  state: z.array(z.enum(TRANSACTION_STATES)).optional(),
  search: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
const transitionSchema = z.object({ to: z.enum(TRANSACTION_STATES), note: z.string().max(1000).optional() });
const disputeSchema = z.object({
  reason: z.enum(['ITEM_NOT_AS_DESCRIBED', 'ITEM_NOT_RECEIVED', 'ITEM_DAMAGED', 'PAYMENT_PROBLEM', 'DELIVERY_PROBLEM', 'OTHER']),
  summary: z.string().trim().min(20).max(2000),
});
const disputeResponseSchema = z.object({ summary: z.string().trim().min(20).max(2000) });
const uuidSchema = z.string().uuid();

export function createTransactionRouter(auth: AuthService, transactions: PostgresTransactionRepository, escrow: EscrowService) {
  const router = Router();
  const requireAccount = requireAuth(auth);
  router.use((request, response, next) => {
    if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
      requireSameOrigin(request, response, next);
      return;
    }
    next();
  });

  router.get('/', requireAccount, async (request, response, next) => {
    try {
      const query = listSchema.parse({
        state: request.query.state === undefined ? undefined : Array.isArray(request.query.state) ? request.query.state : [request.query.state],
        search: request.query.search,
        limit: request.query.limit,
        offset: request.query.offset,
      });
      const result = await transactions.list(request.account!.id, {
        states: query.state ?? [], ...(query.search === undefined ? {} : { search: query.search }), limit: query.limit, offset: query.offset,
      });
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.post('/', requireAccount, async (request, response, next) => {
    try {
      const input = createSchema.parse(request.body);
      const key = idempotencyContext(request, request.account!.id, 'POST:/api/transactions');
      const result = await transactions.create(request.account!.id, {
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        amountKobo: input.amount_kobo,
        counterpartyReference: input.counterparty_reference,
        ...(input.photos_enabled === undefined ? {} : { photosEnabled: input.photos_enabled }),
      }, key);
      response.status(201).json(result);
    } catch (error) { next(error); }
  });

  router.get('/:id', requireAccount, async (request, response, next) => {
    try {
      const detail = await transactions.detail(request.account!.id, uuidSchema.parse(request.params.id));
      if (!detail) throw new ResourceNotFoundError();
      response.status(200).json(detail);
    } catch (error) { next(error); }
  });

  router.post('/:id/transition', requireAccount, async (request, response, next) => {
    try {
      const input = transitionSchema.parse(request.body);
      const transactionId = uuidSchema.parse(request.params.id);
      const idempotency = idempotencyContext(request, request.account!.id, `POST:/api/transactions/${transactionId}/transition`);
      // The role is resolved from the transaction row inside the engine, not
      // asserted here. A seller pressing their own button must not be refused
      // for a role the route guessed.
      const result = await escrow.transition(transactionId, request.account!.id, input.to, input.note, idempotency);
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.post('/:id/dispute', requireAccount, async (request, response, next) => {
    try {
      const input = disputeSchema.parse(request.body);
      const transactionId = uuidSchema.parse(request.params.id);
      const idempotency = idempotencyContext(request, request.account!.id, `POST:/api/transactions/${transactionId}/dispute`);
      const result = await escrow.openDispute(transactionId, { accountId: request.account!.id, kind: 'buyer' }, input.reason, input.summary, idempotency);
      response.status(201).json(result);
    } catch (error) { next(error); }
  });

  router.post('/:id/dispute/response', requireAccount, async (request, response, next) => {
    try {
      const input = disputeResponseSchema.parse(request.body);
      const transactionId = uuidSchema.parse(request.params.id);
      const idempotency = idempotencyContext(request, request.account!.id, `POST:/api/transactions/${transactionId}/dispute/response`);
      const result = await escrow.respondToDispute(transactionId, { accountId: request.account!.id, kind: 'seller' }, input.summary, idempotency);
      response.status(201).json(result);
    } catch (error) { next(error); }
  });

  router.use((error: unknown, _request: unknown, response: import('express').Response, next: import('express').NextFunction) => {
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
    if (error instanceof Error && ['SELLER_ROLE_REQUIRED', 'COUNTERPARTY_NOT_FOUND'].includes(error.message)) {
      response.status(error.message === 'COUNTERPARTY_NOT_FOUND' ? 404 : 403).json({ error: { code: error.message, message: error.message === 'COUNTERPARTY_NOT_FOUND' ? 'Resource not found' : 'A seller role is required' } });
      return;
    }
    next(error);
  });

  return router;
}