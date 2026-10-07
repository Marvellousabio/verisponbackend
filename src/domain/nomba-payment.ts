export interface PaymentIntentIdentity {
  transaction_id: string;
  provider_order_reference: string;
  provider_order_id: string | null;
  amount_kobo: string;
}

export class NombaPaymentIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NombaPaymentIdentityError';
  }
}

export function matchNombaPaymentIntent(
  candidates: readonly PaymentIntentIdentity[],
  transactionId: string | undefined,
  references: readonly string[],
): PaymentIntentIdentity | null {
  if (candidates.length > 1) {
    throw new NombaPaymentIdentityError('Nomba payment identifiers matched multiple payment intents');
  }
  const payment = candidates[0];
  if (!payment) return null;

  if (transactionId && transactionId !== payment.transaction_id) {
    throw new NombaPaymentIdentityError('Nomba transaction metadata does not match the payment intent');
  }
  if (references.some((reference) =>
    reference !== payment.provider_order_reference && reference !== payment.provider_order_id
  )) {
    throw new NombaPaymentIdentityError('Nomba order references do not match the payment intent');
  }
  return payment;
}
