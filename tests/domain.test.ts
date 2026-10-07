import { describe, expect, it } from 'vitest';
import { calculateFees } from '../src/domain/money.js';
import { assertClientTransition, assertTransition, canTransition } from '../src/domain/escrow.js';

describe('fee schedule', () => {
  it('calculates the published example in integer kobo', () => {
    expect(calculateFees(500_000n)).toEqual({
      amountKobo: 500_000n,
      buyerFeeKobo: 10_000n,
      sellerFeeKobo: 5_000n,
      buyerTotalKobo: 510_000n,
      sellerNetKobo: 495_000n,
    });
  });

  it('caps each fee independently', () => {
    const quote = calculateFees(100_000_000n);
    expect(quote.buyerFeeKobo).toBe(1_000_000n);
    expect(quote.sellerFeeKobo).toBe(1_000_000n);
  });

  it('rejects unsafe or non-positive transaction amounts', () => {
    expect(() => calculateFees(0n)).toThrow(RangeError);
    expect(() => calculateFees(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });
});

describe('escrow transitions', () => {
  it('allows the happy path and refuses a repeated state', () => {
    expect(canTransition('BUYER_INSPECTION', 'RELEASED')).toBe(true);
    expect(canTransition('RELEASED', 'RELEASED')).toBe(false);
    expect(() => assertTransition('RELEASED', 'RELEASED')).toThrow();
  });

  it('keeps funding engine-only', () => {
    expect(() => assertClientTransition('FUNDED')).toThrow();
  });
});