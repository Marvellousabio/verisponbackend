import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { idempotencyContext } from '../db/idempotency.js';
import { requireAuth } from '../middleware/auth.js';
import { requireSameOrigin } from '../middleware/same-origin.js';
import type { AuthService } from '../services/auth-service.js';
import { EvidenceAccessError, EvidenceService, EvidenceValidationError } from '../services/evidence-service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { files: 5, fileSize: 25 * 1024 * 1024, fields: 2, fieldSize: 2000 } });
const evidenceTypeSchema = z.enum([
  'ITEM_BEFORE_TRANSACTION', 'ITEM_PACKAGING', 'ITEM_HANDOVER', 'ITEM_SHIPMENT',
  'DELIVERY', 'ITEM_RECEIVED', 'ITEM_DAMAGED', 'RECEIPT', 'DOCUMENT', 'OTHER',
]);
const uuidSchema = z.string().uuid();

/**
 * A path parameter that is not a UUID is a malformed request, not a missing
 * resource. Letting it reach PostgreSQL raises 22P02, which the catch-all turns
 * into a 500 and would report an internal fault for what is a client mistake.
 */
function parseTransactionId(value: unknown): string {
  return uuidSchema.parse(value);
}

export function createEvidenceRouter(auth: AuthService, evidence: EvidenceService) {
  const router = Router();

  router.get('/transactions/:id/evidence', requireAuth(auth), async (request, response, next) => {
    try {
      const result = await evidence.list(parseTransactionId(request.params.id), request.account!.id);
      if (!result) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
        return;
      }
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.delete('/transactions/:id/evidence', requireSameOrigin, requireAuth(auth), async (request, response, next) => {
    try {
      await evidence.remove(
        parseTransactionId(request.params.id),
        uuidSchema.parse(request.query.evidenceId),
        request.account!.id,
      );
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.post('/transactions/:id/evidence', requireSameOrigin, requireAuth(auth), upload.array('files', 5), async (request, response, next) => {
    try {
      const transactionId = parseTransactionId(request.params.id);
      const type = evidenceTypeSchema.parse(request.body.type);
      const description = request.body.description === undefined ? undefined : z.string().max(1000).parse(request.body.description);
      const key = idempotencyContext(request, request.account!.id, `POST:/api/transactions/${transactionId}/evidence`);
      const result = await evidence.upload(
        transactionId, request.account!.id, type, description,
        (request.files ?? []) as Express.Multer.File[], key,
      );
      response.status(201).json(result);
    } catch (error) { next(error); }
  });

  router.get('/evidence/:transactionId/:file', requireAuth(auth), async (request, response, next) => {
    try {
      const result = await evidence.download(parseTransactionId(request.params.transactionId), String(request.params.file), request.account!.id);
      if (!result) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
        return;
      }
      response.setHeader('Content-Type', result.contentType);
      response.setHeader('Content-Disposition', `inline; filename="evidence-${randomUUID()}"`);
      response.setHeader('Cache-Control', 'private, no-store');
      // Piped rather than buffered: the bytes come from Cloudinary as a stream
      // and go straight to the client, so a 25 MB evidence video does not sit
      // in this process's heap on the way past.
      Readable.fromWeb(result.body).pipe(response);
    } catch (error) { next(error); }
  });

  router.use((error: unknown, _request: unknown, response: import('express').Response, next: import('express').NextFunction) => {
    if (error instanceof EvidenceAccessError && error.kind === 'NOT_FOUND') {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
      return;
    }
    if (error instanceof EvidenceAccessError || error instanceof EvidenceValidationError) {
      const status = error instanceof EvidenceAccessError
        ? (error.kind === 'NOT_FOUND' ? 404 : error.kind === 'NOT_UPLOADER' ? 403 : error.kind === 'SEALED' ? 409 : 422)
        : 422;
      response.status(status).json({ error: { code: error instanceof EvidenceAccessError ? error.kind : 'VALIDATION', message: error.message } });
      return;
    }
    if (error instanceof multer.MulterError) {
      response.status(413).json({ error: { code: 'UPLOAD_LIMIT', message: 'Evidence upload exceeds configured limits' } });
      return;
    }
    next(error);
  });
  return router;
}