export const FEE_CAP_KOBO = 1_000_000n;
export const MAX_AMOUNT_KOBO = BigInt(Number.MAX_SAFE_INTEGER);

export interface FeeQuote {
  amountKobo: bigint;
  buyerFeeKobo: bigint;
  sellerFeeKobo: bigint;
  buyerTotalKobo: bigint;
  sellerNetKobo: bigint;
}

function roundedRate(amountKobo: bigint, numerator: bigint, denominator: bigint): bigint {
  return (amountKobo * numerator + denominator / 2n) / denominator;
}

export function calculateFees(amountKobo: bigint): FeeQuote {
  if (amountKobo <= 0n || amountKobo > MAX_AMOUNT_KOBO) {
    throw new RangeError('Amount must be a positive safe integer number of kobo');
  }

  const buyerFeeKobo = roundedRate(amountKobo, 2n, 100n);
  const sellerFeeKobo = roundedRate(amountKobo, 1n, 100n);
  const cappedBuyerFeeKobo = buyerFeeKobo > FEE_CAP_KOBO ? FEE_CAP_KOBO : buyerFeeKobo;
  const cappedSellerFeeKobo = sellerFeeKobo > FEE_CAP_KOBO ? FEE_CAP_KOBO : sellerFeeKobo;

  return {
    amountKobo,
    buyerFeeKobo: cappedBuyerFeeKobo,
    sellerFeeKobo: cappedSellerFeeKobo,
    buyerTotalKobo: amountKobo + cappedBuyerFeeKobo,
    sellerNetKobo: amountKobo - cappedSellerFeeKobo,
  };
}

export function parseKobo(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('amount_kobo must be a positive safe integer');
  }
  return BigInt(value);
}

export function koboToJson(value: bigint): number {
  if (value > MAX_AMOUNT_KOBO || value < -MAX_AMOUNT_KOBO) {
    throw new RangeError('Money amount exceeds the JSON safe integer range');
  }
  return Number(value);
}