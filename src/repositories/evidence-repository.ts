import type { Pool, QueryResultRow } from 'pg';
import { beginIdempotentTransaction, type IdempotencyContext } from '../db/idempotency.js';
import { withTransaction } from '../db/with-transaction.js';
import { TERMINAL_STATES, type TransactionState } from '../domain/escrow.js';

export interface EvidenceItem {
  id: string;
  type: string;
  stage: string;
  uploader_name: string;
  storage_key: string;
  content_type: string;
  bytes: number;
  checksum: string;
  description: string | null;
  created_at: string;
}

/**
 * States in which the evidence set is frozen. COMPLETED is terminal anyway; it
 * is named explicitly because a seal is a claim about the past, and the past
 * does not get edited by a late upload.
 */
const SEALED_EVIDENCE_STATES = new Set<TransactionState>(['RELEASED', 'COMPLETED']);

export class EvidenceAccessError extends Error {
  constructor(readonly kind: 'NOT_FOUND' | 'TERMINAL' | 'SEALED' | 'NOT_UPLOADER') {
    super(
      kind === 'NOT_FOUND' ? 'Resource not found'
        : kind === 'TERMINAL' ? 'Evidence cannot be uploaded after transaction completion'
        : kind === 'SEALED' ? 'Evidence cannot be removed once the money has moved'
        : 'Only the uploader can remove their own evidence',
    );
    this.name = 'EvidenceAccessError';
  }
}

export class PostgresEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async createBatch(
    transactionId: string,
    uploaderId: string,
    items: EvidenceItem[],
    idempotency: IdempotencyContext,
  ): Promise<{ evidence: Array<{ id: string; url: string }> }> {
    return withTransaction(async (client) => {
      const execution = await beginIdempotentTransaction(client, idempotency, async () => {
        const result = await client.query<QueryResultRow & {
          state: TransactionState; buyer_account_id: string; seller_account_id: string;
          buyer_name: string; seller_name: string;
        }>(
          `select state, buyer_account_id, seller_account_id, buyer_name, seller_name
           from transactions where id = $1 for update`, [transactionId],
        );
        const transaction = result.rows[0];
        if (!transaction || (transaction.buyer_account_id !== uploaderId && transaction.seller_account_id !== uploaderId)) {
          throw new EvidenceAccessError('NOT_FOUND');
        }
        if (TERMINAL_STATES.has(transaction.state)) throw new EvidenceAccessError('TERMINAL');
        const stage = this.stageForState(transaction.state);
        const uploaderName = transaction.buyer_account_id === uploaderId ? transaction.buyer_name : transaction.seller_name;
        for (const item of items) {
          await client.query(
            `insert into evidence (id, transaction_id, type, stage, uploader_id, uploader_name, storage_key, content_type, bytes, checksum, description)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [item.id, transactionId, item.type, stage, uploaderId, uploaderName, item.storage_key,
              item.content_type, item.bytes, item.checksum, item.description],
          );
        }
        await client.query(
          `insert into transaction_events (transaction_id, state, actor, actor_account_id, note)
           values ($1, $2, $3, $4, 'Evidence added')`,
          [transactionId, transaction.state, transaction.buyer_account_id === uploaderId ? 'buyer' : 'seller', uploaderId],
        );
        await client.query(
          `insert into outbox_events (topic, transaction_id, payload)
           values ('transaction.evidence_added', $1, $2)`,
          [transactionId, JSON.stringify({ count: items.length })],
        );
        return { evidence: items.map((item) => ({ id: item.id, url: `/api/evidence/${transactionId}/${item.id}` })) };
      });
      return execution.result;
    });
  }

  /**
   * Every item on a transaction, plus the stage the *current* state expects.
   * The expected stage is what lets a client prompt for the right photo
   * without hard-coding the state machine, and it is recomputed per read so it
   * cannot drift from the transaction the items actually belong to.
   */
  async listForParty(transactionId: string, accountId: string): Promise<{ evidence: EvidenceItem[]; expected_stage: string } | null> {
    const transaction = await this.pool.query<{ state: TransactionState; buyer_account_id: string; seller_account_id: string }>(
      `select state, buyer_account_id, seller_account_id from transactions
       where id = $1 and (buyer_account_id = $2 or seller_account_id = $2)`,
      [transactionId, accountId],
    );
    const row = transaction.rows[0];
    if (!row) return null;
    const result = await this.pool.query<QueryResultRow & EvidenceItem>(
      `select id, type, stage, uploader_name, storage_key, content_type, bytes, checksum, description, created_at
       from evidence where transaction_id = $1 order by created_at asc, id asc`,
      [transactionId],
    );
    return {
      evidence: result.rows.map((item) => ({ ...item, created_at: new Date(item.created_at).toISOString() })),
      expected_stage: this.stageForState(row.state),
    };
  }

  /**
   * Removes one item on behalf of the person who uploaded it.
   *
   * The row goes first and the object second, and that order is deliberate. The
   * reverse would leave a row pointing at bytes that no longer exist, which
   * fails every later read of the item. Deleting the row first can only orphan
   * an object in Cloudinary, which is inert and unservable because every read
   * path resolves the storage key through this table.
   *
   * Once money has moved, the record of what was submitted is the record of
   * what was agreed, so RELEASED and COMPLETED seal the set in both directions.
   */
  async deleteForParty(transactionId: string, evidenceId: string, accountId: string): Promise<{ storage_key: string; content_type: string } | null> {
    return withTransaction(async (client) => {
      const transaction = await client.query<{ state: TransactionState; buyer_account_id: string; seller_account_id: string }>(
        `select state, buyer_account_id, seller_account_id from transactions where id = $1 for update`,
        [transactionId],
      );
      const owner = transaction.rows[0];
      if (!owner || (owner.buyer_account_id !== accountId && owner.seller_account_id !== accountId)) {
        throw new EvidenceAccessError('NOT_FOUND');
      }
      if (SEALED_EVIDENCE_STATES.has(owner.state)) throw new EvidenceAccessError('SEALED');
      const item = await client.query<{ storage_key: string; content_type: string; uploader_id: string }>(
        'select storage_key, content_type, uploader_id from evidence where id = $1 and transaction_id = $2',
        [evidenceId, transactionId],
      );
      if (!item.rows[0]) throw new EvidenceAccessError('NOT_FOUND');
      if (item.rows[0].uploader_id !== accountId) throw new EvidenceAccessError('NOT_UPLOADER');

      await client.query('delete from evidence where id = $1 and transaction_id = $2', [evidenceId, transactionId]);
      await client.query(
        `insert into transaction_events (transaction_id, state, actor, actor_account_id, note)
         values ($1, $2, $3, $4, 'Evidence removed')`,
        [transactionId, owner.state, owner.buyer_account_id === accountId ? 'buyer' : 'seller', accountId],
      );
      await client.query(
        `insert into outbox_events (topic, transaction_id, payload)
         values ('transaction.evidence_removed', $1, $2)`,
        [transactionId, JSON.stringify({ evidence_id: evidenceId })],
      );
      return { storage_key: item.rows[0].storage_key, content_type: item.rows[0].content_type };
    });
  }

  async findForParty(transactionId: string, evidenceId: string, accountId: string): Promise<(EvidenceItem & { transaction_id: string }) | null> {
    const result = await this.pool.query<QueryResultRow & EvidenceItem & { transaction_id: string }>(
      `select e.id, e.transaction_id, e.type, e.stage, e.uploader_name, e.storage_key,
              e.content_type, e.bytes, e.checksum, e.description, e.created_at
       from evidence e join transactions t on t.id = e.transaction_id
       where e.transaction_id = $1 and e.id = $2
         and (t.buyer_account_id = $3 or t.seller_account_id = $3)`,
      [transactionId, evidenceId, accountId],
    );
    const row = result.rows[0];
    return row ? { ...row, created_at: new Date(row.created_at).toISOString() } : null;
  }

  private stageForState(state: TransactionState): string {
    if (['CREATED', 'AWAITING_BUYER_VERIFICATION'].includes(state)) return 'before_payment';
    if (state === 'AWAITING_PAYMENT') return 'payment';
    if (['FUNDED', 'SELLER_PROCESSING'].includes(state)) return 'fulfillment';
    if (state === 'SHIPPED') return 'dispatch';
    if (['DELIVERED', 'DELIVERY_FAILED', 'RETURN_IN_PROGRESS'].includes(state)) return 'delivery';
    if (state === 'BUYER_INSPECTION') return 'confirmation';
    return 'dispute';
  }
}