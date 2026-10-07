export type LedgerAccount =
  | 'escrow_cash'
  | 'buyer_fee_revenue'
  | 'seller_fee_revenue'
  | 'seller_payable'
  | 'refund_payable'
  | 'platform_equity'
  | 'external_cash'
  | 'payout_clearing'
  | 'verispon_escrow_bank';

export interface LedgerLeg {
  account: LedgerAccount;
  direction: 'D' | 'C';
  amountKobo: bigint;
  memo: string;
}

export function assertBalanced(legs: readonly LedgerLeg[]): void {
  if (legs.length < 2 || legs.some((leg) => leg.amountKobo <= 0n)) {
    throw new RangeError('A posting requires at least two positive ledger legs');
  }

  const debits = legs
    .filter((leg) => leg.direction === 'D')
    .reduce((total, leg) => total + leg.amountKobo, 0n);
  const credits = legs
    .filter((leg) => leg.direction === 'C')
    .reduce((total, leg) => total + leg.amountKobo, 0n);

  if (debits !== credits) {
    throw new RangeError('Ledger posting debits must equal credits');
  }
}

export function fundingPosting(amountKobo: bigint, buyerFeeKobo: bigint): LedgerLeg[] {
  const legs: LedgerLeg[] = [
    { account: 'external_cash', direction: 'D', amountKobo: amountKobo + buyerFeeKobo, memo: 'Buyer payment received' },
    { account: 'escrow_cash', direction: 'C', amountKobo, memo: 'Principal held in escrow' },
  ];
  if (buyerFeeKobo > 0n) {
    legs.push({ account: 'buyer_fee_revenue', direction: 'C', amountKobo: buyerFeeKobo, memo: 'Buyer fee recognised at funding' });
  }
  assertBalanced(legs);
  return legs;
}

export function releasePosting(principalKobo: bigint, sellerFeeKobo: bigint): LedgerLeg[] {
  const sellerNetKobo = principalKobo - sellerFeeKobo;
  if (principalKobo <= 0n || sellerNetKobo <= 0n) {
    throw new RangeError('Release principal must exceed the seller fee');
  }
  const legs: LedgerLeg[] = [
    { account: 'escrow_cash', direction: 'D', amountKobo: principalKobo, memo: 'Escrow released to seller' },
    { account: 'seller_payable', direction: 'C', amountKobo: sellerNetKobo, memo: 'Seller payout authorised' },
  ];
  if (sellerFeeKobo > 0n) {
    legs.push({ account: 'seller_fee_revenue', direction: 'C', amountKobo: sellerFeeKobo, memo: 'Seller fee recognised on release' });
  }
  assertBalanced(legs);
  return legs;
}

/**
 * Returning the principal is only half of a refund. The buyer fee was earned
 * at the moment the money arrived, so cancelling does not earn it back — and
 * leaving it sitting in `buyer_fee_revenue` would report it as an obligation
 * that is never discharged. It is reclassified into `platform_equity` in the
 * same posting, so the refund is a single balanced entry and the ledger has one
 * answer about where the fee ended up.
 */
export function refundPosting(refundKobo: bigint, retainedBuyerFeeKobo: bigint = 0n): LedgerLeg[] {
  if (refundKobo <= 0n) {
    throw new RangeError('A refund must move a positive amount');
  }
  if (retainedBuyerFeeKobo < 0n) {
    throw new RangeError('A retained fee cannot be negative');
  }
  const legs: LedgerLeg[] = [
    { account: 'escrow_cash', direction: 'D', amountKobo: refundKobo, memo: 'Escrow principal refunded' },
    { account: 'refund_payable', direction: 'C', amountKobo: refundKobo, memo: 'Refund payable to buyer' },
  ];
  if (retainedBuyerFeeKobo > 0n) {
    legs.push({ account: 'buyer_fee_revenue', direction: 'D', amountKobo: retainedBuyerFeeKobo, memo: 'Buyer fee earned at funding is retained' });
    legs.push({ account: 'platform_equity', direction: 'C', amountKobo: retainedBuyerFeeKobo, memo: 'Retained buyer fee recognised as platform equity' });
  }
  assertBalanced(legs);
  return legs;
}

export function payoutDispatchPosting(amountKobo: bigint, beneficiary: 'seller' | 'buyer'): LedgerLeg[] {
  void beneficiary;
  const legs: LedgerLeg[] = [
    { account: 'payout_clearing', direction: 'D', amountKobo, memo: `${beneficiary} transfer in flight` },
    { account: 'external_cash', direction: 'C', amountKobo, memo: 'Funds submitted to provider' },
  ];
  assertBalanced(legs);
  return legs;
}

export function payoutSettlementPosting(amountKobo: bigint, beneficiary: 'seller' | 'buyer'): LedgerLeg[] {
  const payableAccount = beneficiary === 'seller' ? 'seller_payable' : 'refund_payable';
  const legs: LedgerLeg[] = [
    { account: payableAccount, direction: 'D', amountKobo, memo: `${beneficiary} payable settled` },
    { account: 'payout_clearing', direction: 'C', amountKobo, memo: 'Provider transfer settled' },
  ];
  assertBalanced(legs);
  return legs;
}

export function payoutReturnPosting(amountKobo: bigint): LedgerLeg[] {
  const legs: LedgerLeg[] = [
    { account: 'external_cash', direction: 'D', amountKobo, memo: 'Failed provider transfer returned to wallet' },
    { account: 'payout_clearing', direction: 'C', amountKobo, memo: 'Failed transfer removed from clearing' },
  ];
  assertBalanced(legs);
  return legs;
}