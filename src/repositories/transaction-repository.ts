import { randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { calculateFees, koboToJson, parseKobo } from '../domain/money.js';
import { allowedTransitions, ENGINE_ONLY_STATES, type TransactionState } from '../domain/escrow.js';
import { checkoutExpiresAt, newCheckoutToken } from '../domain/checkout.js';
import { beginIdempotentTransaction, type IdempotencyContext } from '../db/idempotency.js';

export interface TransactionListItem {
  id: string;
  reference: string;
  title: string;
  state: TransactionState;
  role: 'buyer' | 'seller';
  counterparty_name: string;
  amount_kobo: number;
  updated_at: string;
}

interface TransactionRow extends QueryResultRow {
  id: string;
  reference: string;
  title: string;
  description: string | null;
  buyer_account_id: string;
  buyer_name: string;
  buyer_reference: string;
  buyer_verified: boolean;
  seller_account_id: string;
  seller_name: string;
  seller_reference: string;
  seller_verified: boolean;
  amount_kobo: string;
  buyer_fee_kobo: string;
  seller_fee_kobo: string;
  buyer_total_kobo: string;
  seller_net_kobo: string;
  state: TransactionState;
  delivery_method: string | null;
  rider_verified_at: Date | null;
  delivery_fees_kobo: string | null;
  refunded_kobo: string;
  photos_enabled: boolean;
  checkout_token: string | null;
  checkout_expires_at: Date | null;
  checkout_opened_at: Date | null;
  created_at: Date;
  updated_at: Date;
  payment_checkout_url?: string | null;
  payment_status?: string | null;
}

function accountRole(row: TransactionRow, accountId: string): 'buyer' | 'seller' | null {
  if (row.buyer_account_id === accountId) return 'buyer';
  if (row.seller_account_id === accountId) return 'seller';
  return null;
}

function safeKobo(value: string): number {
  return koboToJson(BigInt(value));
}

export class PostgresTransactionRepository {
  constructor(private readonly pool: Pool) {}

  async create(sellerAccountId: string, input: { title: string; description?: string; amountKobo: number; counterpartyReference: string; photosEnabled?: boolean }, idempotency: IdempotencyContext): Promise<Record<string, unknown>> {
    const amountKobo = parseKobo(input.amountKobo);
    const fees = calculateFees(amountKobo);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const execution = await beginIdempotentTransaction(client, idempotency, async () => {
        const seller = await client.query<QueryResultRow & { id: string; name: string; reference: string; roles: string[] }>(
          'select id, name, reference, roles from accounts where id = $1 and deleted_at is null and frozen_at is null for update',
          [sellerAccountId],
        );
        if (!seller.rows[0] || !seller.rows[0].roles.includes('SELLER')) throw new Error('SELLER_ROLE_REQUIRED');
        const buyer = await client.query<QueryResultRow & { id: string; name: string; reference: string; roles: string[] }>(
          `select id, name, reference, roles from accounts
           where reference = $1 and deleted_at is null
             and roles && array['BUYER', 'SELLER']::account_role[]
             and (email_verified_at is not null or phone_verified_at is not null)
           limit 1`,
          [input.counterpartyReference],
        );
        if (!buyer.rows[0] || buyer.rows[0].id === sellerAccountId) throw new Error('COUNTERPARTY_NOT_FOUND');

        const id = randomUUID();
        const reference = `VSP-${randomInt(100_000, 1_000_000)}`;
        // Every transaction gets a payment link at creation, not on request.
        // A buyer who has to ask for one is a buyer who never pays, and the
        // token is issued once and never rotated so a link already sitting in a
        // WhatsApp thread keeps working.
        const checkoutToken = newCheckoutToken();
        const checkoutDeadline = checkoutExpiresAt();
        const created = await client.query<{ created_at: Date }>(
          `insert into transactions (
             id, reference, title, description, buyer_account_id, buyer_name, buyer_reference,
             seller_account_id, seller_name, seller_reference, amount_kobo, buyer_fee_kobo, seller_fee_kobo,
             photos_enabled, checkout_token, checkout_expires_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           returning created_at`,
          [id, reference, input.title.trim(), input.description?.trim() ?? null,
            buyer.rows[0].id, buyer.rows[0].name, buyer.rows[0].reference,
            seller.rows[0].id, seller.rows[0].name, seller.rows[0].reference,
            amountKobo.toString(), fees.buyerFeeKobo.toString(), fees.sellerFeeKobo.toString(),
            input.photosEnabled ?? false, checkoutToken, checkoutDeadline.toISOString()],
        );
        await client.query(
          `insert into transaction_events (transaction_id, state, actor, actor_account_id, note)
           values ($1, 'CREATED', 'seller', $2, 'Transaction created')`,
          [id, sellerAccountId],
        );
        await client.query(
          `insert into outbox_events (topic, transaction_id, payload)
           values ('transaction.created', $1, $2)`,
          [id, JSON.stringify({ reference, buyer_account_id: buyer.rows[0].id, seller_account_id: sellerAccountId })],
        );
        return {
          id, reference, title: input.title.trim(), description: input.description?.trim() ?? null,
          state: 'CREATED', amount_kobo: koboToJson(amountKobo),
          photos_enabled: input.photosEnabled ?? false,
          checkout: { token: checkoutToken, expires_at: checkoutDeadline.toISOString() },
          fees: { buyer_fee_kobo: koboToJson(fees.buyerFeeKobo), seller_fee_kobo: koboToJson(fees.sellerFeeKobo), buyer_total_kobo: koboToJson(fees.buyerTotalKobo), seller_net_kobo: koboToJson(fees.sellerNetKobo) },
          created_at: created.rows[0]!.created_at.toISOString(),
        };
      });
      await client.query('commit');
      return execution.result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(accountId: string, options: { states: TransactionState[]; search?: string; limit: number; offset: number }): Promise<{ transactions: TransactionListItem[]; total: number }> {
    const params: unknown[] = [accountId];
    let filters = '(t.buyer_account_id = $1 or t.seller_account_id = $1)';
    if (options.states.length) {
      params.push(options.states);
      filters += ` and t.state = any($${params.length}::transaction_state[])`;
    }
    if (options.search?.trim()) {
      params.push(`%${options.search.trim()}%`);
      filters += ` and (t.title ilike $${params.length} or t.reference ilike $${params.length})`;
    }
    const count = await this.pool.query<{ total: string }>(`select count(*)::text as total from transactions t where ${filters}`, params);
    const pageParams = [...params, options.limit, options.offset];
    const rows = await this.pool.query<TransactionRow>(
      `select t.*, (t.buyer_account_id = $1) as is_buyer
       from transactions t where ${filters}
       order by t.updated_at desc limit $${pageParams.length - 1} offset $${pageParams.length}`,
      pageParams,
    );
    const transactions = rows.rows.map((row) => {
      const role = row.buyer_account_id === accountId ? 'buyer' : 'seller';
      return {
        id: row.id,
        reference: row.reference,
        title: row.title,
        state: row.state,
        role,
        counterparty_name: role === 'buyer' ? row.seller_name : row.buyer_name,
        amount_kobo: safeKobo(row.amount_kobo),
        updated_at: row.updated_at.toISOString(),
      } satisfies TransactionListItem;
    });
    return { transactions, total: Number(count.rows[0]!.total) };
  }

  async detail(accountId: string, id: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<TransactionRow>(
      `select t.*, p.checkout_url as payment_checkout_url, p.status as payment_status,
         (buyer.email_verified_at is not null or buyer.phone_verified_at is not null) as buyer_verified,
         (seller.email_verified_at is not null or seller.phone_verified_at is not null) as seller_verified
       from transactions t
       join accounts buyer on buyer.id = t.buyer_account_id
       join accounts seller on seller.id = t.seller_account_id
      left join payment_intents p on p.transaction_id = t.id
       where t.id = $1 and (t.buyer_account_id = $2 or t.seller_account_id = $2)`,
      [id, accountId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const role = accountRole(row, accountId);
    if (!role) return null;
    const counterparty = role === 'buyer'
      ? { id: row.seller_account_id, reference: row.seller_reference, name: row.seller_name, verified: row.seller_verified }
      : { id: row.buyer_account_id, reference: row.buyer_reference, name: row.buyer_name, verified: row.buyer_verified };
    const [evidence, dispute, disputeResponses, timeline, delivery] = await Promise.all([
      this.pool.query<QueryResultRow>(
        `select id, type, stage, uploader_name, content_type, bytes, description, created_at
         from evidence where transaction_id = $1 order by created_at`, [id]),
      this.pool.query<QueryResultRow>(
        // id and opened_by are part of the contract: a client needs the dispute
        // id to reference it and the opening party to attribute it. Omitting
        // them makes the dispute unusable to a UI that renders who opened it.
        `select id, reason, summary, status, resolution, refund_kobo, opened_by, opened_at, resolved_at
         from disputes where transaction_id = $1`, [id]),
      this.pool.query<QueryResultRow>(
        `select author_id, summary, created_at from dispute_responses
         where dispute_id = (select id from disputes where transaction_id = $1)
         order by created_at`, [id]),
      this.pool.query<QueryResultRow>(
        `select state, actor, note, at from transaction_events where transaction_id = $1 order by at`, [id]),
      this.pool.query<QueryResultRow>(
        `select type, at from delivery_events where transaction_id = $1 order by at desc limit 1`, [id]),
    ]);

    const ownFee = role === 'buyer'
      ? { buyer_fee_kobo: safeKobo(row.buyer_fee_kobo), buyer_total_kobo: safeKobo(row.buyer_total_kobo) }
      : { seller_fee_kobo: safeKobo(row.seller_fee_kobo), seller_net_kobo: safeKobo(row.seller_net_kobo) };
    const actions: Array<{ id: string; to: TransactionState; label: string }> = allowedTransitions(row.state)
      .filter((state) => !ENGINE_ONLY_STATES.has(state) && (role === 'buyer'
        ? ['AWAITING_PAYMENT', 'BUYER_INSPECTION', 'RELEASED', 'CANCELLED'].includes(state)
        : ['AWAITING_BUYER_VERIFICATION', 'SELLER_PROCESSING', 'SHIPPED', 'DELIVERY_FAILED', 'CANCELLED'].includes(state)))
      .map((state) => ({ id: state, to: state, label: state.replaceAll('_', ' ').toLowerCase() }));
    if (role === 'buyer' && dispute.rows.length === 0 && allowedTransitions(row.state).includes('DISPUTED')) {
      actions.push({ id: 'RAISE_DISPUTE', to: 'DISPUTED', label: 'raise dispute' });
    }

    return {
      id: row.id,
      reference: row.reference,
      title: row.title,
      description: row.description,
      state: row.state,
      counterparty: counterparty,
      role,
      amount_kobo: safeKobo(row.amount_kobo),
      photos_enabled: row.photos_enabled,
      // The token is a capability, so it is reachable only because the query
      // above already proved party membership. It is issued once, never rotated
      // and never extended — a rotated token is a link in an old WhatsApp
      // message that now 404s, and there is no way to tell the seller which.
      // It deliberately does not appear in the list projection above.
      checkout: row.checkout_token ? {
        token: row.checkout_token,
        url: `/checkout/${row.checkout_token}`,
        expires_at: row.checkout_expires_at ? row.checkout_expires_at.toISOString() : null,
        opened_at: row.checkout_opened_at ? row.checkout_opened_at.toISOString() : null,
      } : null,
      fees: ownFee,
      payment: role === 'buyer' && row.state === 'AWAITING_PAYMENT'
        ? { checkout_url: row.payment_checkout_url ?? null, status: row.payment_status ?? 'PENDING' }
        : null,
      delivery: {
        method: row.delivery_method,
        rider_verified: row.rider_verified_at !== null,
        delivery_fees_kobo: row.delivery_fees_kobo === null ? null : safeKobo(row.delivery_fees_kobo),
        latest_event: delivery.rows[0] ? { type: delivery.rows[0].type, at: (delivery.rows[0].at as Date).toISOString() } : null,
      },
      evidence: evidence.rows.map((item) => ({
        id: item.id,
        type: item.type,
        stage: item.stage,
        uploader_name: item.uploader_name,
        content_type: item.content_type,
        bytes: item.bytes,
        description: item.description,
        created_at: (item.created_at as Date).toISOString(),
        url: `/api/evidence/${row.id}/${item.id}`,
      })),
      dispute: dispute.rows[0] ? {
        ...dispute.rows[0],
        refund_kobo: dispute.rows[0].refund_kobo === null ? null : safeKobo(String(dispute.rows[0].refund_kobo)),
        responses: disputeResponses.rows.map((response) => ({
          author_id: response.author_id,
          summary: response.summary,
          created_at: (response.created_at as Date).toISOString(),
        })),
      } : null,
      timeline: timeline.rows.map((event) => ({ state: event.state, actor: event.actor, note: event.note, at: (event.at as Date).toISOString() })),
      actions,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  async findIdByReferenceForParty(reference: string, accountId: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `select id from transactions where reference = $1
       and (buyer_account_id = $2 or seller_account_id = $2)`,
      [reference.toUpperCase(), accountId],
    );
    return result.rows[0]?.id ?? null;
  }
}