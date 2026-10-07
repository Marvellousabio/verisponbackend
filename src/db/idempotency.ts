import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient } from 'pg';

export interface IdempotencyContext {
  key: string;
  accountId: string;
  endpoint: string;
  requestHash: string;
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency key was reused with a different request') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * A missing or malformed Idempotency-Key is a malformed request, not a
 * conflict with an earlier request, so it is reported separately from a
 * genuine key-reuse conflict.
 */
export class IdempotencyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyKeyError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function idempotencyContext(request: Request, accountId: string, endpoint: string): IdempotencyContext {
  const key = request.header('Idempotency-Key');
  if (!key || key.length > 255) throw new IdempotencyKeyError('A valid Idempotency-Key header is required');
  const requestHash = createHash('sha256').update(JSON.stringify(canonicalize(request.body ?? {}))).digest('hex');
  return { key, accountId, endpoint, requestHash };
}

export async function claimIdempotency<T>(client: PoolClient, context: IdempotencyContext): Promise<T | null> {
  const insert = await client.query(
    `insert into idempotency_keys (key, account_id, endpoint, request_hash, status)
     values ($1, $2, $3, $4, 'IN_FLIGHT') on conflict do nothing`,
    [context.key, context.accountId, context.endpoint, context.requestHash],
  );
  if (insert.rowCount === 1) return null;

  const existing = await client.query<{ request_hash: string; response: T | null; status: string }>(
    'select request_hash, response, status from idempotency_keys where key = $1 and account_id = $2 and endpoint = $3 for update',
    [context.key, context.accountId, context.endpoint],
  );
  const row = existing.rows[0];
  if (!row || row.request_hash !== context.requestHash) throw new IdempotencyConflictError();
  if (row.status !== 'COMPLETED' || row.response === null) throw new IdempotencyConflictError('Request with this idempotency key is already in progress');
  return row.response;
}

export async function completeIdempotency(client: PoolClient, context: IdempotencyContext, response: unknown): Promise<void> {
  await client.query(
    `update idempotency_keys set response = $4::jsonb, status = 'COMPLETED'
     where key = $1 and account_id = $2 and endpoint = $3`,
    [context.key, context.accountId, context.endpoint, JSON.stringify(response)],
  );
}

export async function beginIdempotentTransaction<T>(
  client: PoolClient,
  context: IdempotencyContext,
  work: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const replay = await claimIdempotency<T>(client, context);
  if (replay !== null) return { result: replay, replayed: true };
  const result = await work();
  await completeIdempotency(client, context, result);
  return { result, replayed: false };
}