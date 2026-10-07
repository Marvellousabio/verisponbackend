import { randomBytes } from 'node:crypto';
import { FUNDS_HELD_STATES, type TransactionState } from './escrow.js';

/**
 * A payment link lives one day. The deadline is fixed at creation and never
 * extended: a link that can be revived is a link that never expired, and a
 * seller who keeps re-sending one is teaching buyers that the deadline is
 * decorative.
 */
export const CHECKOUT_LIFETIME_HOURS = 24;

export const CHECKOUT_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export type CheckoutAvailability = 'open' | 'expired' | 'paid' | 'closed';

export interface CheckoutLink {
  token: string;
  expiresAt: string;
  openedAt?: string;
}

/**
 * States that have already moved money out of the caller's reach. A link to
 * these is `closed` even before the deadline passes, because there is nothing
 * left to pay for.
 */
const CLOSED_STATES = new Set<TransactionState>([
  'CANCELLED', 'REFUNDED', 'COMPLETED', 'DISPUTED', 'UNDER_REVIEW',
]);

/**
 * States at or past funding. The seller is already holding the money, so the
 * page says "already paid" rather than "expired" — telling a buyer who has
 * already sent the cash to chase a new link is the worse lie.
 */
const PAID_STATES = new Set<TransactionState>([...FUNDS_HELD_STATES, 'RELEASED']);

export function newCheckoutToken(): string {
  return randomBytes(16).toString('hex');
}

export function checkoutExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + CHECKOUT_LIFETIME_HOURS * 60 * 60 * 1000);
}

export function isCheckoutToken(value: unknown): value is string {
  return typeof value === 'string' && CHECKOUT_TOKEN_PATTERN.test(value);
}

/**
 * The state of the transaction outranks the clock. Availability is computed in
 * that order deliberately: a buyer whose money has arrived must never be told
 * to ask the seller for a fresh link, and a record with no link at all is
 * `closed` rather than open by default.
 *
 * A malformed `expiresAt` is `closed`, never open forever — an unparseable
 * deadline is a broken row, and treating it as "no deadline" would keep a link
 * live that nobody can meaningfully bound.
 */
export function checkoutAvailability(
  link: { token: string; expiresAt: string } | null | undefined,
  state: TransactionState,
  now: Date = new Date(),
): CheckoutAvailability {
  if (!link?.token || !link.expiresAt) return 'closed';
  const deadline = new Date(link.expiresAt);
  if (Number.isNaN(deadline.getTime())) return 'closed';
  if (CLOSED_STATES.has(state)) return 'closed';
  if (PAID_STATES.has(state)) return 'paid';
  return now.getTime() >= deadline.getTime() ? 'expired' : 'open';
}
