import type { Pool, QueryResultRow } from 'pg';
import { checkoutAvailability, isCheckoutToken } from '../domain/checkout.js';

interface CheckoutRow extends QueryResultRow {
  id: string;
  reference: string;
  title: string;
  description: string | null;
  state: string;
  amount_kobo: string;
  buyer_fee_kobo: string;
  buyer_total_kobo: string;
  checkout_expires_at: Date | null;
  checkout_opened_at: Date | null;
  delivery_method: string | null;
  pickup_address: string | null;
  destination_address: string | null;
  delivery_window: string | null;
}

export interface CheckoutView {
  reference: string;
  title: string;
  description: string | null;
  availability: ReturnType<typeof checkoutAvailability>;
  expires_at: string | null;
  amount_kobo: number;
  buyer_fee_kobo: number;
  buyer_total_kobo: number;
  delivery: { method: string; pickup_address: string | null; destination_address: string; delivery_window: string | null } | null;
}

/**
 * Public, token-scoped reads for the payment page.
 *
 * The token is the entire authorisation, so this deliberately sits on the pool
 * rather than on the escrow repository: it must not be reachable with a
 * session, and it must not join the account-scoped queries that shape the rest
 * of the API. Nothing here may return a counterparty name, reference, phone or
 * address of either party — a stranger with a link gets the deal and the price,
 * never the people.
 */
export class PostgresCheckoutRepository {
  constructor(private readonly pool: Pool) {}

  async findByToken(token: string): Promise<CheckoutRow | null> {
    const result = await this.pool.query<CheckoutRow>(
      `select id, reference, title, description, state, amount_kobo, buyer_fee_kobo, buyer_total_kobo,
              checkout_expires_at, checkout_opened_at, delivery_method, pickup_address,
              destination_address, delivery_window
       from transactions where checkout_token = $1`,
      [token],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Stamped on the first successful render so a seller can tell a buyer who
   * never looked from one who looked and walked away. `coalesce` keeps the
   * first render authoritative, and nothing here touches the state machine.
   */
  async stampOpened(id: string): Promise<void> {
    await this.pool.query(
      'update transactions set checkout_opened_at = coalesce(checkout_opened_at, now()) where id = $1',
      [id],
    );
  }
}

export class CheckoutService {
  constructor(private readonly repository: PostgresCheckoutRepository) {}

  /**
   * A malformed token is a 404, never a 500 and never a lookup. Anything that
   * is not exactly 32 lowercase hex characters is not a token we ever issued,
   * so refusing it before the database keeps a garbage string from becoming a
   * query plan.
   */
  async view(token: unknown, now: Date = new Date()): Promise<CheckoutView | null> {
    if (!isCheckoutToken(token)) return null;
    const row = await this.repository.findByToken(token);
    if (!row) return null;

    await this.repository.stampOpened(row.id);

    const destination = row.destination_address;
    return {
      reference: row.reference,
      title: row.title,
      description: row.description,
      availability: checkoutAvailability(
        row.checkout_expires_at ? { token, expiresAt: row.checkout_expires_at.toISOString() } : null,
        row.state as Parameters<typeof checkoutAvailability>[1],
        now,
      ),
      expires_at: row.checkout_expires_at ? row.checkout_expires_at.toISOString() : null,
      amount_kobo: Number(row.amount_kobo),
      buyer_fee_kobo: Number(row.buyer_fee_kobo),
      buyer_total_kobo: Number(row.buyer_total_kobo),
      delivery: destination ? {
        method: row.delivery_method ?? 'SELLER_RIDER',
        pickup_address: row.pickup_address,
        destination_address: destination,
        delivery_window: row.delivery_window,
      } : null,
    };
  }
}
