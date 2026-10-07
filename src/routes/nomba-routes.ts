import { Router } from 'express';
import type { Pool } from 'pg';
import { NombaAdapter, nombaAmountToKobo, type NombaWebhook } from '../adapters/nomba.js';
import type { EscrowService } from '../services/escrow-service.js';
import { PayoutService } from '../services/payout-service.js';
import { matchNombaPaymentIntent, NombaPaymentIdentityError } from '../domain/nomba-payment.js';

export function createNombaRouter(pool: Pool, escrow: EscrowService) {
  const router = Router();
  const nomba = new NombaAdapter();
  const payouts = new PayoutService(pool);

  router.post('/webhook', async (request, response, next) => {
    try {
      const payload = request.body as NombaWebhook;
      const signature = request.get('nomba-signature') ?? request.get('nomba-sig-value');
      const timestamp = request.get('nomba-timestamp');
      if (!nomba.verifyWebhook(payload, signature, timestamp)) {
        response.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed' } });
        return;
      }
      if (payload.event_type === 'payout_success' || payload.event_type === 'payout_refund') {
        const merchantTxRef = payload.data.transaction?.merchantTxRef;
        const providerTransactionId = payload.data.transaction?.transactionId;
        if (!payload.requestId || !merchantTxRef || !providerTransactionId) {
          response.status(400).json({ error: { code: 'INVALID_WEBHOOK', message: 'Payout webhook is missing identifiers' } });
          return;
        }
        await payouts.processWebhook({
          merchantTxRef,
          eventId: payload.requestId,
          providerTransactionId,
          status: payload.event_type === 'payout_success' ? 'SUCCESS' : 'REFUND',
        });
        response.status(200).json({ received: true });
        return;
      }
      if (payload.event_type !== 'payment_success') {
        response.status(200).json({ received: true });
        return;
      }
      if (!payload.requestId || !payload.data.transaction?.transactionId) {
        response.status(400).json({ error: { code: 'INVALID_WEBHOOK', message: 'Payment webhook is missing identifiers' } });
        return;
      }

      const references = [payload.data.order?.orderReference, payload.data.transaction.merchantTxRef].filter((value): value is string => Boolean(value));
      const transactionId = payload.data.order?.orderMetaData?.transaction_id;
      if (transactionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId)) {
        response.status(400).json({ error: { code: 'INVALID_WEBHOOK', message: 'Payment webhook has invalid transaction metadata' } });
        return;
      }
      const intent = await pool.query<{
        transaction_id: string;
        provider_order_reference: string;
        provider_order_id: string | null;
        amount_kobo: string;
      }>(
        `select p.transaction_id, p.provider_order_reference, p.provider_order_id, p.amount_kobo
         from payment_intents p join transactions t on t.id = p.transaction_id
         where ($1::uuid is not null and p.transaction_id = $1)
            or p.provider_order_reference = any($2::text[])
            or p.provider_order_id = any($2::text[])`,
        [transactionId ?? null, references],
      );
      let payment: ReturnType<typeof matchNombaPaymentIntent>;
      try {
        payment = matchNombaPaymentIntent(intent.rows, transactionId, references);
      } catch (error) {
        if (!(error instanceof NombaPaymentIdentityError)) throw error;
        response.status(422).json({ error: { code: 'PAYMENT_IDENTITY_MISMATCH', message: error.message } });
        return;
      }
      if (!payment) {
        response.status(200).json({ received: true });
        return;
      }

      const verified = await nomba.verifyTransaction(payment.provider_order_reference);
      if (verified.status !== 'SUCCESS') {
        response.status(503).json({ error: { code: 'PAYMENT_NOT_VERIFIED', message: 'Provider has not confirmed successful settlement' } });
        return;
      }
      const verifiedAmount = nombaAmountToKobo(verified.onlineCheckoutAmount ?? verified.amount);
      if (verifiedAmount !== BigInt(payment.amount_kobo)) {
        response.status(422).json({ error: { code: 'PAYMENT_AMOUNT_MISMATCH', message: 'Verified provider amount does not match the transaction total' } });
        return;
      }

      const applied = await escrow.confirmFunding(
        payment.transaction_id,
        verifiedAmount,
        payload.requestId,
        payload.data.transaction.transactionId,
        payment.provider_order_reference,
      );
      response.status(200).json({ received: true, applied });
    } catch (error) { next(error); }
  });

  return router;
}