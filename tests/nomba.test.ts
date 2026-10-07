import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  nombaAmountToKobo,
  nombaAmountToNairaNumber,
  verifyNombaSignature,
  type NombaWebhook,
} from '../src/adapters/nomba.js';
import { matchNombaPaymentIntent, NombaPaymentIdentityError } from '../src/domain/nomba-payment.js';

describe('Nomba adapter', () => {
  it('validates the documented webhook signature field order', () => {
    const payload: NombaWebhook = {
      event_type: 'payment_success',
      requestId: 'request-1',
      data: {
        merchant: { userId: 'user-1', walletId: 'wallet-1' },
        transaction: { transactionId: 'transaction-1', type: 'online_checkout', time: '2026-10-02T10:00:00Z', responseCode: '' },
      },
    };
    const timestamp = '2026-10-02T10:00:01Z';
    const material = [payload.event_type, payload.requestId, 'user-1', 'wallet-1', 'transaction-1', 'online_checkout', '2026-10-02T10:00:00Z', '', timestamp].join(':');
    const signature = createHmac('sha256', 'webhook-secret').update(material).digest('base64');

    expect(verifyNombaSignature(payload, 'webhook-secret', signature, timestamp)).toBe(true);
    expect(verifyNombaSignature(payload, 'webhook-secret', signature, '2026-10-02T10:01:00Z')).toBe(false);
  });

  it('converts provider decimal NGN to integer kobo exactly', () => {
    expect(nombaAmountToKobo('100.05')).toBe(10_005n);
    expect(nombaAmountToKobo(100)).toBe(10_000n);
    expect(() => nombaAmountToKobo('1.001')).toThrow(RangeError);
  });

  it('refuses transfer amounts that JavaScript numbers would round', () => {
    expect(nombaAmountToNairaNumber(10_005n)).toBe(100.05);
    expect(() => nombaAmountToNairaNumber(9_007_199_254_740_991n)).toThrow(
      'Nomba transfer amount cannot be represented exactly as a decimal number',
    );
  });
});

describe('Nomba payment intent matching', () => {
  const payment = {
    transaction_id: 'transaction-1',
    provider_order_reference: 'VSP-123456',
    provider_order_id: 'order-1',
    amount_kobo: '10000',
  };

  it('accepts identifiers that all point to the same payment intent', () => {
    expect(matchNombaPaymentIntent(
      [payment],
      payment.transaction_id,
      [payment.provider_order_reference, payment.provider_order_id!],
    )).toEqual(payment);
  });

  it('rejects conflicting metadata and order references', () => {
    expect(() => matchNombaPaymentIntent(
      [payment],
      'transaction-2',
      [payment.provider_order_reference],
    )).toThrow(NombaPaymentIdentityError);
    expect(() => matchNombaPaymentIntent(
      [payment],
      payment.transaction_id,
      [payment.provider_order_reference, 'another-order'],
    )).toThrow(NombaPaymentIdentityError);
  });

  it('rejects ambiguous matches and leaves unknown intents uncredited', () => {
    expect(() => matchNombaPaymentIntent([payment, { ...payment, transaction_id: 'transaction-2' }], undefined, [
      payment.provider_order_reference,
    ])).toThrow(NombaPaymentIdentityError);
    expect(matchNombaPaymentIntent([], undefined, ['unknown-order'])).toBeNull();
  });
});