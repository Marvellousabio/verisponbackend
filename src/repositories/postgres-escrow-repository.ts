import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { assertBalanced } from '../domain/ledger.js';
import type { LedgerLeg } from '../domain/ledger.js';
import type { TransactionState } from '../domain/escrow.js';
import { requirePool } from '../db/pool.js';
import { beginIdempotentTransaction, type IdempotencyContext } from '../db/idempotency.js';
import type { EscrowRepository, EscrowTransaction, EscrowUnitOfWork } from './escrow-repository.js';

interface TransactionRow extends QueryResultRow {
  id: string;
  reference: string;
  state: TransactionState;
  buyer_account_id: string;
  seller_account_id: string;
  amount_kobo: string;
  buyer_fee_kobo: string;
  seller_fee_kobo: string;
  refunded_kobo: string;
  auto_release_at: Date | null;
  photos_enabled: boolean;
}

function mapTransaction(row: TransactionRow): EscrowTransaction {
  return {
    id: row.id,
    reference: row.reference,
    state: row.state,
    buyerAccountId: row.buyer_account_id,
    sellerAccountId: row.seller_account_id,
    amountKobo: BigInt(row.amount_kobo),
    buyerFeeKobo: BigInt(row.buyer_fee_kobo),
    sellerFeeKobo: BigInt(row.seller_fee_kobo),
    refundedKobo: BigInt(row.refunded_kobo),
    autoReleaseAt: row.auto_release_at,
    photosEnabled: row.photos_enabled,
  };
}

class PostgresEscrowUnitOfWork implements EscrowUnitOfWork {
  constructor(private readonly client: PoolClient) {}

  async findTransactionForUpdate(id: string): Promise<EscrowTransaction | null> {
    const result = await this.client.query<TransactionRow>(
      'select id, reference, state, buyer_account_id, seller_account_id, amount_kobo, buyer_fee_kobo, seller_fee_kobo, refunded_kobo, auto_release_at, photos_enabled from transactions where id = $1 for update',
      [id],
    );
    return result.rows[0] ? mapTransaction(result.rows[0]) : null;
  }

  async hasDispute(transactionId: string): Promise<boolean> {
    const result = await this.client.query('select 1 from disputes where transaction_id = $1 limit 1', [transactionId]);
    return result.rowCount !== 0;
  }

  async hasOpenDispute(transactionId: string): Promise<boolean> {
    const result = await this.client.query(
      `select 1 from disputes where transaction_id = $1 and status in ('OPEN', 'UNDER_REVIEW') limit 1`,
      [transactionId],
    );
    return result.rowCount !== 0;
  }

  async hasPayoutDestination(sellerAccountId: string): Promise<boolean> {
    const result = await this.client.query('select 1 from account_payout_destinations where account_id = $1', [sellerAccountId]);
    return result.rowCount !== 0;
  }

  async hasEvidence(transactionId: string, type: string): Promise<boolean> {
    const result = await this.client.query('select 1 from evidence where transaction_id = $1::uuid and type = $2::evidence_type limit 1', [transactionId, type]);
    return result.rowCount !== 0;
  }

  async escrowCashBalance(transactionId: string): Promise<bigint> {
    const result = await this.client.query<{ balance: string }>(
      `select coalesce(sum(case when direction = 'C' then amount_kobo else -amount_kobo end), 0)::text as balance
         from ledger_entries where transaction_id = $1::uuid and account = 'escrow_cash'`, [transactionId],
    );
    return BigInt(result.rows[0]?.balance ?? '0');
  }

  async updateState(
    transaction: EscrowTransaction,
    to: TransactionState,
    actorAccountId: string | null,
    options: { refundedKobo?: bigint; payoutAuthorised?: boolean; cancellationReason?: string; autoReleaseHours?: number } = {},
  ): Promise<void> {
    // Every parameter is cast explicitly. node-pg sends every value as text,
    // and PostgreSQL resolves an uncast parameter from context: `$2` used
    // both as `state = $2` (transaction_state) and as `$2 = 'CANCELLED'`
    // resolves to text, which then fails against the enum with
    // "text versus transaction_state". A cast removes the ambiguity.
    await this.client.query(
      `update transactions
       set previous_state = state,
           state = $2::transaction_state,
           payout_authorised_at = case when $3::boolean then now() else payout_authorised_at end,
           refunded_kobo = coalesce($4::bigint, refunded_kobo),
           auto_release_at = case when $7::integer is null then auto_release_at else now() + ($7::integer * interval '1 hour') end,
           cancelled_at = case when $2::transaction_state = 'CANCELLED' then now() else cancelled_at end,
           cancellation_reason = coalesce($5::text, cancellation_reason),
           updated_at = now()
       where id = $1::uuid and state = $6::transaction_state`,
      [transaction.id, to, options.payoutAuthorised ?? false, options.refundedKobo?.toString() ?? null,
        options.cancellationReason ?? null, transaction.state, options.autoReleaseHours ?? null],
    );
    void actorAccountId;
  }

  async writePosting(transactionId: string, actor: string, legs: readonly LedgerLeg[]): Promise<void> {
    assertBalanced(legs);
    const groupId = randomUUID();
    for (const leg of legs) {
      await this.client.query(
        'insert into ledger_entries (group_id, transaction_id, account, direction, amount_kobo, memo, actor) values ($1::uuid, $2::uuid, $3::ledger_account, $4::"char", $5::bigint, $6::text, $7::text)',
        [groupId, transactionId, leg.account, leg.direction, leg.amountKobo.toString(), leg.memo, actor],
      );
    }
  }

  async appendEvent(transactionId: string, state: TransactionState, actor: string, actorAccountId: string | null, note?: string): Promise<void> {
    await this.client.query(
      'insert into transaction_events (transaction_id, state, actor, actor_account_id, note) values ($1::uuid, $2::transaction_state, $3::text, $4::uuid, $5::text)',
      [transactionId, state, actor, actorAccountId, note ?? null],
    );
  }

  async enqueue(topic: string, transactionId: string, payload: Record<string, unknown>): Promise<void> {
    await this.client.query(
      'insert into outbox_events (topic, transaction_id, payload) values ($1::text, $2::uuid, $3::jsonb)',
      [topic, transactionId, JSON.stringify(payload)],
    );
  }

  async createDispute(transactionId: string, openedBy: string, reason: string, summary: string): Promise<void> {
    await this.client.query(
      `insert into disputes (transaction_id, reason, summary, opened_by, opened_by_role)
       values ($1::uuid, $2::dispute_reason, $3::text, $4::uuid, 'buyer')`,
      [transactionId, reason, summary, openedBy],
    );
  }

  async createDisputeResponse(transactionId: string, authorId: string, summary: string): Promise<void> {
    await this.client.query(
      `insert into dispute_responses (dispute_id, author_id, summary)
       select id, $2, $3 from disputes where transaction_id = $1 and status in ('OPEN', 'UNDER_REVIEW')`,
      [transactionId, authorId, summary],
    );
  }

  async resolveDispute(transactionId: string, resolvedBy: string, status: string, resolution: string, refundKobo: bigint | null): Promise<void> {
    await this.client.query(
      `update disputes set status = $2::dispute_status, resolution = $3::text, refund_kobo = $4::bigint, resolved_at = now(), resolved_by = $5::uuid
       where transaction_id = $1::uuid`,
      [transactionId, status, resolution, refundKobo?.toString() ?? null, resolvedBy],
    );
  }

  async writeAudit(actorId: string, action: string, targetId: string, before: Record<string, unknown>, after: Record<string, unknown>): Promise<void> {
    await this.client.query(
      `insert into audit_log (actor_id, actor_role, action, target_type, target_id, before, after)
       values ($1::uuid, 'ADMIN', $2::text, 'transaction', $3::text, $4::jsonb, $5::jsonb)`,
      [actorId, action, targetId, JSON.stringify(before), JSON.stringify(after)],
    );
  }

  async claimProviderEvent(provider: string, eventId: string): Promise<boolean> {
    const result = await this.client.query(
      `insert into provider_webhook_events (provider, event_id) values ($1, $2)
       on conflict do nothing returning event_id`, [provider, eventId],
    );
    return result.rowCount === 1;
  }

  async markPaymentIntentPaid(orderReference: string, providerTransactionId: string, providerEventId: string): Promise<void> {
    await this.client.query(
      `update payment_intents set status = 'PAID', provider_transaction_id = $2, updated_at = now()
       where provider_order_reference = $1`, [orderReference, providerTransactionId],
    );
    await this.client.query(
      `update provider_webhook_events set processed_at = now()
      where provider = 'nomba' and event_id = $1`, [providerEventId],
    );
  }
}

export class PostgresEscrowRepository implements EscrowRepository {
  async transaction<T>(work: (unit: EscrowUnitOfWork) => Promise<T>, idempotency?: IdempotencyContext): Promise<T> {
    const client = await requirePool().connect();
    try {
      await client.query('begin');
      const unit = new PostgresEscrowUnitOfWork(client);
      let result: T;
      if (idempotency) {
        const execution = await beginIdempotentTransaction(client, idempotency, () => work(unit));
        result = execution.result;
      } else {
        result = await work(unit);
      }
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async findDueAutoReleases(limit: number): Promise<string[]> {
    const result = await requirePool().query<{ id: string }>(
      `select t.id from transactions t
       where t.state = 'BUYER_INSPECTION' and t.auto_release_at <= now()
         and not exists (select 1 from disputes d where d.transaction_id = t.id and d.status in ('OPEN', 'UNDER_REVIEW'))
       order by t.auto_release_at asc limit $1`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }
}