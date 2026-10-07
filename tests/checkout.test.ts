import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_TOKEN_PATTERN,
  checkoutAvailability,
  isCheckoutToken,
  newCheckoutToken,
} from '../src/domain/checkout.js';

const HOUR = 60 * 60 * 1000;

describe('checkout link', () => {
  it('issues 32 lowercase hex characters', () => {
    const token = newCheckoutToken();
    expect(token).toMatch(CHECKOUT_TOKEN_PATTERN);
    expect(newCheckoutToken()).not.toBe(token);
  });

  it('refuses anything that is not exactly 32 lowercase hex characters', () => {
    expect(isCheckoutToken('d6a6e1cebffb33dca49fb6a0607abe11')).toBe(true);
    expect(isCheckoutToken('D6A6E1CEBFFB33DCA49FB6A0607ABE11')).toBe(false);
    expect(isCheckoutToken('d6a6e1cebffb33dca49fb6a0607abe1')).toBe(false);
    expect(isCheckoutToken('d6a6e1cebffb33dca49fb6a0607abe111')).toBe(false);
    expect(isCheckoutToken('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
    expect(isCheckoutToken(undefined)).toBe(false);
  });

  it('is open while payable and before the deadline', () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    expect(checkoutAvailability({ token: 'a'.repeat(32), expiresAt: '2026-10-04T12:00:00.000Z' }, 'CREATED', now)).toBe('open');
  });

  it('is expired once the deadline passes but the transaction is still payable', () => {
    const now = new Date('2026-10-04T13:00:00.000Z');
    expect(checkoutAvailability({ token: 'a'.repeat(32), expiresAt: '2026-10-04T12:00:00.000Z' }, 'CREATED', now)).toBe('expired');
  });

  it('lets the state outrank the clock, so a funded link is paid however late it is', () => {
    const now = new Date('2026-11-30T00:00:00.000Z');
    const link = { token: 'a'.repeat(32), expiresAt: '2026-10-04T12:00:00.000Z' };
    expect(checkoutAvailability(link, 'FUNDED', now)).toBe('paid');
    expect(checkoutAvailability(link, 'SELLER_PROCESSING', now)).toBe('paid');
    expect(checkoutAvailability(link, 'SHIPPED', now)).toBe('paid');
    expect(checkoutAvailability(link, 'BUYER_INSPECTION', now)).toBe('paid');
    expect(checkoutAvailability(link, 'RELEASED', now)).toBe('paid');
  });

  it('is closed for states where there is nothing left to pay for', () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    const link = { token: 'a'.repeat(32), expiresAt: '2026-10-04T12:00:00.000Z' };
    for (const state of ['CANCELLED', 'REFUNDED', 'COMPLETED', 'DISPUTED', 'UNDER_REVIEW'] as const) {
      expect(checkoutAvailability(link, state, now)).toBe('closed');
    }
  });

  it('treats a missing link and an unparseable deadline as closed, never open', () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    expect(checkoutAvailability(null, 'CREATED', now)).toBe('closed');
    expect(checkoutAvailability(undefined, 'CREATED', now)).toBe('closed');
    expect(checkoutAvailability({ token: 'a'.repeat(32), expiresAt: 'not-a-date' }, 'CREATED', now)).toBe('closed');
    expect(checkoutAvailability({ token: 'a'.repeat(32), expiresAt: '' }, 'CREATED', now)).toBe('closed');
  });

  it('treats the deadline as exclusive, so the link is open right up to it', () => {
    const expiresAt = new Date('2026-10-04T12:00:00.000Z');
    expect(checkoutAvailability({ token: 'a'.repeat(32), expiresAt: expiresAt.toISOString() }, 'CREATED', new Date(expiresAt.getTime() - 1))).toBe('open');
    expect(checkoutAvailability({ token: 'a'.repeat(32), expiresAt: expiresAt.toISOString() }, 'CREATED', expiresAt)).toBe('expired');
  });
});
