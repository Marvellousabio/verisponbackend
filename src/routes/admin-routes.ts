import { Router } from 'express';
import { z } from 'zod';
import { idempotencyContext } from '../db/idempotency.js';
import { payoutReturnPosting, payoutSettlementPosting, assertBalanced } from '../domain/ledger.js';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import type { AuthService } from '../services/auth-service.js';
import { EscrowService } from '../services/escrow-service.js';
import type { Pool } from 'pg';
import { requireSameOrigin } from '../middleware/same-origin.js';
import { beginIdempotentTransaction } from '../db/idempotency.js';
import { withTransaction } from '../db/with-transaction.js';

const resolveSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('RELEASE'), resolution: z.string().trim().min(10).max(2000) }),
  z.object({ decision: z.literal('REFUND'), resolution: z.string().trim().min(10).max(2000) }),
  z.object({ decision: z.literal('PARTIAL_REFUND'), refund_kobo: z.number().int().positive().safe(), resolution: z.string().trim().min(10).max(2000) }),
]);
const freezeSchema = z.object({ reason: z.string().trim().min(10).max(1000) });
const refundReconcileSchema = z.object({ outcome: z.enum(['SETTLED', 'FAILED']), note: z.string().trim().min(10).max(1000) });

/**
 * Dispute routes are keyed by dispute id, but the escrow engine locks and
 * updates the transaction row. Resolving one from the other here keeps the
 * route from having to know that the two identifiers differ, and keeps a
 * dispute id from being passed to the engine as though it were a transaction
 * id, which would silently match nothing.
 */
async function transactionIdForDispute(pool: Pool, disputeId: string): Promise<string | null> {
  const result = await pool.query<{ transaction_id: string }>(
    'select transaction_id from disputes where id = $1', [disputeId],
  );
  return result.rows[0]?.transaction_id ?? null;
}

export function createAdminRouter(pool: Pool, auth: AuthService, escrow: EscrowService) {
  const router = Router();
  router.use(requireAuth(auth));
  router.use((request, response, next) => {
    if (!request.account?.roles.includes('ADMIN')) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin capability required' } });
      return;
    }
    next();
  });
  router.use((request, response, next) => {
    if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
      requireSameOrigin(request, response, next);
      return;
    }
    next();
  });

  router.use('/disputes', (request, response, next) => {
    const capability = request.method === 'POST' ? 'disputes.resolve' : 'disputes.read';
    if (!request.account?.capabilities.includes(capability)) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: `${capability} capability required` } });
      return;
    }
    next();
  });

  router.get('/disputes', async (_request, response, next) => {
    try {
      const result = await pool.query(
        `select d.id, d.transaction_id, d.reason, d.summary, d.status, d.opened_at,
                t.reference, t.title, t.state, t.amount_kobo, t.buyer_name, t.seller_name
         from disputes d join transactions t on t.id = d.transaction_id
         where d.status in ('OPEN', 'UNDER_REVIEW') order by d.opened_at asc`,
      );
      response.status(200).json({ disputes: result.rows.map((row) => ({ ...row, amount_kobo: Number(row.amount_kobo) })) });
    } catch (error) { next(error); }
  });

  router.get('/transactions', async (request, response, next) => {
    if (!request.account?.capabilities.includes('transactions.read_all')) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'transactions.read_all capability required' } });
      return;
    }
    try {
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
      const result = await pool.query(
        `select id, reference, title, state, amount_kobo, buyer_name, buyer_reference,
                seller_name, seller_reference, created_at, updated_at
         from transactions order by updated_at desc limit $1`, [limit],
      );
      response.status(200).json({ transactions: result.rows.map((row) => ({ ...row, amount_kobo: Number(row.amount_kobo) })) });
    } catch (error) { next(error); }
  });

  router.get('/accounts', async (request, response, next) => {
    if (!request.account?.capabilities.includes('accounts.read')) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'accounts.read capability required' } });
      return;
    }
    try {
      const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
      const result = await pool.query(
        `select id, reference, name, email::text, phone, roles, email_verified_at, phone_verified_at,
                frozen_at, created_at
         from accounts where deleted_at is null and ($1 = '' or reference ilike $2 or email::text ilike $2 or name ilike $2)
         order by created_at desc limit 100`, [search, `%${search}%`],
      );
      response.status(200).json({ accounts: result.rows });
    } catch (error) { next(error); }
  });

  router.post('/accounts/:id/freeze', async (request, response, next) => {
    if (!request.account?.capabilities.includes('accounts.freeze')) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'accounts.freeze capability required' } });
      return;
    }
    try {
      const input = freezeSchema.parse(request.body);
      const targetId = z.string().uuid().parse(request.params.id);
      const context = idempotencyContext(request, request.account.id, `POST:/api/admin/accounts/${targetId}/freeze`);
      const result = await withTransaction(async (client) => {
        const execution = await beginIdempotentTransaction(client, context, async () => {
          const beforeResult = await client.query<{ frozen_at: Date | null; roles: string[] }>(
            'select frozen_at, roles from accounts where id = $1 and deleted_at is null for update', [targetId],
          );
          const before = beforeResult.rows[0];
          if (!before) return { missing: true };
          await client.query('update accounts set frozen_at = now(), updated_at = now() where id = $1', [targetId]);
          await client.query(
            `insert into audit_log (actor_id, actor_role, action, target_type, target_id, before, after, ip, user_agent)
             values ($1, 'ADMIN', 'account.freeze', 'account', $2, $3, $4, $5, $6)`,
            [request.account!.id, targetId, JSON.stringify({ frozen_at: before.frozen_at }),
              JSON.stringify({ frozen: true, reason: input.reason }), request.ip ?? null, request.get('user-agent') ?? null],
          );
          return { missing: false, frozen: true };
        });
        return execution.result;
      });
      if (result.missing) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
        return;
      }
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.post('/accounts/:id/unfreeze', async (request, response, next) => {
    if (!request.account?.capabilities.includes('accounts.freeze')) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'accounts.freeze capability required' } });
      return;
    }
    try {
      const input = freezeSchema.parse(request.body);
      const targetId = z.string().uuid().parse(request.params.id);
      const context = idempotencyContext(request, request.account.id, `POST:/api/admin/accounts/${targetId}/unfreeze`);
      const result = await withTransaction(async (client) => {
        const execution = await beginIdempotentTransaction(client, context, async () => {
          const beforeResult = await client.query<{ frozen_at: Date | null }>(
            'select frozen_at from accounts where id = $1 and deleted_at is null for update', [targetId],
          );
          const before = beforeResult.rows[0];
          if (!before) return { missing: true };
          await client.query('update accounts set frozen_at = null, updated_at = now() where id = $1', [targetId]);
          await client.query(
            `insert into audit_log (actor_id, actor_role, action, target_type, target_id, before, after, ip, user_agent)
             values ($1, 'ADMIN', 'account.unfreeze', 'account', $2, $3, $4, $5, $6)`,
            [request.account!.id, targetId, JSON.stringify({ frozen_at: before.frozen_at }),
              JSON.stringify({ frozen: false, reason: input.reason }), request.ip ?? null, request.get('user-agent') ?? null],
          );
          return { missing: false, frozen: false };
        });
        return execution.result;
      });
      if (result.missing) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
        return;
      }
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.post('/disputes/:id/review', async (request, response, next) => {
    if (!request.account?.capabilities.includes('disputes.resolve')) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'disputes.resolve capability required' } });
      return;
    }
    try {
      const disputeId = z.string().uuid().parse(request.params.id);
      const idem = idempotencyContext(request, request.account.id, `POST:/api/admin/disputes/${disputeId}/review`);
      const transactionId = await transactionIdForDispute(pool, disputeId);
      if (!transactionId) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
        return;
      }
      const result = await escrow.beginDisputeReview(transactionId, { accountId: request.account.id, kind: 'admin' }, idem);
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.post('/disputes/:id/resolve', async (request, response, next) => {
    try {
      const input = resolveSchema.parse(request.body);
      const disputeId = z.string().uuid().parse(request.params.id);
      const idem = idempotencyContext(request, request.account!.id, `POST:/api/admin/disputes/${disputeId}/resolve`);
      const actor = { accountId: request.account!.id, kind: 'admin' as const };
      const transactionId = await transactionIdForDispute(pool, disputeId);
      if (!transactionId) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
        return;
      }
      const result = input.decision === 'PARTIAL_REFUND'
        ? await escrow.resolveDispute(transactionId, actor, input.decision, input.resolution, BigInt(input.refund_kobo), idem)
        : await escrow.resolveDispute(transactionId, actor, input.decision, input.resolution, undefined, idem);
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.get('/audit', async (request, response, next) => {
    if (!request.account?.capabilities.includes('audit.read')) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'audit.read capability required' } });
      return;
    }
    try {
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
      const result = await pool.query(
        `select id, actor_id, actor_role, action, target_type, target_id, before, after, at
         from audit_log order by at desc limit $1`, [limit],
      );
      response.status(200).json({ entries: result.rows });
    } catch (error) { next(error); }
  });

  router.post('/refunds/:id/reconcile', async (request, response, next) => {
    if (!request.account?.capabilities.includes('refunds.reconcile')) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'refunds.reconcile capability required' } });
      return;
    }
    try {
      const input = refundReconcileSchema.parse(request.body);
      const attemptId = z.string().uuid().parse(request.params.id);
      const idem = idempotencyContext(request, request.account.id, `POST:/api/admin/refunds/${attemptId}/reconcile`);
      const result = await withTransaction(async (client) => {
        const execution = await beginIdempotentTransaction(client, idem, async () => {
          const selected = await client.query<{
            id: string; transaction_id: string; amount_kobo: string; status: string; provider_transaction_id: string;
          }>(
            `select id, transaction_id, amount_kobo, status, provider_transaction_id
             from refund_attempts where id = $1 for update`, [attemptId],
          );
          const attempt = selected.rows[0];
          if (!attempt) return { missing: true };
          if (!['UNKNOWN', 'SUBMITTING'].includes(attempt.status)) throw new Error('REFUND_NOT_RECONCILABLE');
          const legs = input.outcome === 'SETTLED'
            ? payoutSettlementPosting(BigInt(attempt.amount_kobo), 'buyer')
            : payoutReturnPosting(BigInt(attempt.amount_kobo));
          assertBalanced(legs);
          const groupId = randomUUID();
          for (const leg of legs) {
            await client.query(
              `insert into ledger_entries (group_id, transaction_id, account, direction, amount_kobo, memo, actor)
               values ($1, $2, $3, $4, $5, $6, 'admin')`,
              [groupId, attempt.transaction_id, leg.account, leg.direction, leg.amountKobo.toString(), leg.memo],
            );
          }
          const finalStatus = input.outcome === 'SETTLED' ? 'SETTLED' : 'FAILED';
          await client.query('update refund_attempts set status = $2, updated_at = now() where id = $1', [attemptId, finalStatus]);
          await client.query(
            `insert into audit_log (actor_id, actor_role, action, target_type, target_id, before, after, ip, user_agent)
             values ($1, 'ADMIN', 'refund.reconcile', 'refund_attempt', $2, $3, $4, $5, $6)`,
            [request.account!.id, attemptId, JSON.stringify({ status: attempt.status }),
              JSON.stringify({ status: finalStatus, outcome: input.outcome, note: input.note, provider_transaction_id: attempt.provider_transaction_id }),
              request.ip ?? null, request.get('user-agent') ?? null],
          );
          return { missing: false, status: finalStatus };
        });
        return execution.result;
      });
      if (result.missing) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
        return;
      }
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  return router;
}