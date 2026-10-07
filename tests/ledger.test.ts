import { describe, expect, it } from 'vitest';
import {
  assertBalanced,
  fundingPosting,
  payoutDispatchPosting,
  payoutReturnPosting,
  payoutSettlementPosting,
  refundPosting,
  releasePosting,
} from '../src/domain/ledger.js';

describe('ledger postings', () => {
  it('balances funding, release, refund, and settlement groups', () => {
    const groups = [
      fundingPosting(500_000n, 10_000n),
      releasePosting(500_000n, 5_000n),
      refundPosting(500_000n),
      payoutDispatchPosting(495_000n, 'seller'),
      payoutDispatchPosting(500_000n, 'buyer'),
      payoutSettlementPosting(495_000n, 'seller'),
      payoutSettlementPosting(500_000n, 'buyer'),
      payoutReturnPosting(495_000n),
    ];

    for (const group of groups) expect(() => assertBalanced(group)).not.toThrow();
  });

  it('returns the principal and reclassifies the retained buyer fee into equity', () => {
    // The fee was earned at funding, so cancelling does not earn it back. It
    // has to land somewhere that is not an obligation, which is exactly what
    // platform_equity is for.
    expect(refundPosting(100n, 2n)).toEqual([
      { account: 'escrow_cash', direction: 'D', amountKobo: 100n, memo: 'Escrow principal refunded' },
      { account: 'refund_payable', direction: 'C', amountKobo: 100n, memo: 'Refund payable to buyer' },
      { account: 'buyer_fee_revenue', direction: 'D', amountKobo: 2n, memo: 'Buyer fee earned at funding is retained' },
      { account: 'platform_equity', direction: 'C', amountKobo: 2n, memo: 'Retained buyer fee recognised as platform equity' },
    ]);
  });

  it('omits the fee legs when nothing was retained', () => {
    expect(refundPosting(100n)).toEqual([
      { account: 'escrow_cash', direction: 'D', amountKobo: 100n, memo: 'Escrow principal refunded' },
      { account: 'refund_payable', direction: 'C', amountKobo: 100n, memo: 'Refund payable to buyer' },
    ]);
  });

  it('refuses a refund that moves no money or retains a negative fee', () => {
    expect(() => refundPosting(0n)).toThrow(RangeError);
    expect(() => refundPosting(100n, -1n)).toThrow(RangeError);
  });

  it('rejects an unbalanced posting', () => {
    expect(() => assertBalanced([
      { account: 'escrow_cash', direction: 'D', amountKobo: 1n, memo: 'debit' },
      { account: 'seller_payable', direction: 'C', amountKobo: 2n, memo: 'credit' },
    ])).toThrow(RangeError);
  });
});