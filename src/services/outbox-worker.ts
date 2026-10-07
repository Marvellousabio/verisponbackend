import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/with-transaction.js';
import { ResendEmailAdapter, WhatsAppCloudAdapter } from '../adapters/notifications.js';
import { PostgresEscrowRepository } from '../repositories/postgres-escrow-repository.js';
import { EscrowService } from './escrow-service.js';
import { decryptSecret } from '../auth/secret-payload.js';
import { APPLICATION_SECRET } from '../config.js';
import { NombaAdapter } from '../adapters/nomba.js';
import { PayoutService } from './payout-service.js';
import { payoutDispatchPosting, payoutSettlementPosting, assertBalanced } from '../domain/ledger.js';
import { randomUUID } from 'node:crypto';
import {
  registeredWhatsAppTemplate,
  type WhatsAppTemplate,
} from './whatsapp-template-registry.js';

interface OutboxRecord extends QueryResultRow {
  id: string;
  topic: string;
  transaction_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

interface WhatsAppSendOptions {
  accountId?: string;
  allowOptOutConfirmation?: boolean;
  serviceWindowExpiresAt?: string;
  fallbackTemplate?: WhatsAppTemplate;
}

export class OutboxWorker {
  private readonly whatsapp = new WhatsAppCloudAdapter();
  private readonly email = new ResendEmailAdapter();
  private readonly nomba = new NombaAdapter();
  private readonly payouts: PayoutService;

  constructor(private readonly pool: Pool) {
    this.payouts = new PayoutService(pool);
  }

  async drainBatch(limit = 20): Promise<number> {
    const events = await withTransaction(async (client) => {
      const claimed = await client.query<OutboxRecord>(
        `select id, topic, transaction_id, payload, attempts from outbox_events
         where delivered_at is null and available_at <= now()
         order by id asc limit $1 for update skip locked`, [limit],
      );
      if (!claimed.rows.length) return [];
      const ids = claimed.rows.map((event) => event.id);
      await client.query(
        `update outbox_events set attempts = attempts + 1, available_at = now() + interval '5 minutes'
         where id = any($1::bigint[])`, [ids],
      );
      return claimed.rows.map((event) => ({ ...event, attempts: event.attempts + 1 }));
    });

    for (const event of events) {
      try {
        await this.deliver(event);
        await this.pool.query('update outbox_events set delivered_at = now(), payload = \'{}\'::jsonb where id = $1', [event.id]);
      } catch (error) {
        const delaySeconds = Math.min(300, 2 ** Math.min(event.attempts, 8));
        await this.pool.query(
          `update outbox_events set available_at = now() + ($2 * interval '1 second') where id = $1`,
          [event.id, delaySeconds],
        );
        console.error('Outbox delivery failed', { eventId: event.id, topic: event.topic, error });
      }
    }
    return events.length;
  }

  private async sendWhatsAppIfAllowed(
    phone: string,
    text: string,
    options: WhatsAppSendOptions = {},
  ): Promise<boolean> {
    const result = options.accountId
      ? await this.pool.query<{ id: string; whatsapp_opted_out_at: Date | null; last_whatsapp_inbound_at: Date | null }>(
          'select id, whatsapp_opted_out_at, last_whatsapp_inbound_at from accounts where id = $1 and deleted_at is null',
          [options.accountId],
        )
      : await this.pool.query<{ id: string; whatsapp_opted_out_at: Date | null; last_whatsapp_inbound_at: Date | null }>(
          'select id, whatsapp_opted_out_at, last_whatsapp_inbound_at from accounts where phone = $1 and deleted_at is null limit 1',
          [phone],
        );
    const recipient = result.rows[0];
    if (options.accountId && !recipient) return false;
    if (recipient?.whatsapp_opted_out_at && !options.allowOptOutConfirmation) return false;
    if (!this.whatsapp.isConfigured()) {
      console.warn('WhatsApp outbound delivery skipped because Meta credentials are not configured');
      return false;
    }
    const lastInbound = recipient?.last_whatsapp_inbound_at?.getTime();
    const payloadExpiry = options.serviceWindowExpiresAt
      ? Date.parse(options.serviceWindowExpiresAt)
      : Number.NaN;
    const serviceWindowOpen = (lastInbound !== undefined && Date.now() - lastInbound < 24 * 60 * 60 * 1000)
      || (Number.isFinite(payloadExpiry) && payloadExpiry > Date.now());
    if (serviceWindowOpen) {
      await this.whatsapp.sendText(phone, text);
      return true;
    }
    if (!options.fallbackTemplate) return false;
    await this.whatsapp.sendTemplate(phone, options.fallbackTemplate);
    return true;
  }

  private async deliver(event: OutboxRecord): Promise<void> {
    if (event.topic === 'whatsapp.recovery_code') {
      const accountId = event.payload.account_id;
      const encryptedCode = event.payload.encrypted_code;
      if (typeof accountId !== 'string' || typeof encryptedCode !== 'string') throw new Error('Recovery message is malformed');
      const account = await this.pool.query<{ phone: string | null; whatsapp_opted_out_at: Date | null }>(
        'select phone, whatsapp_opted_out_at from accounts where id = $1', [accountId],
      );
      const phone = account.rows[0]?.phone;
      if (!phone || account.rows[0]?.whatsapp_opted_out_at) return;
      const code = decryptSecret(encryptedCode, APPLICATION_SECRET);
      await this.sendWhatsAppIfAllowed(phone, `Your Verispon recovery code is ${code}. It expires in 10 minutes.`, {
        accountId,
        fallbackTemplate: registeredWhatsAppTemplate('recovery_code', [code, '10 minutes']),
      });
      return;
    }

    if (event.topic === 'account.verification_code') {
      const accountId = event.payload.account_id;
      const channel = event.payload.channel;
      const encryptedCode = event.payload.encrypted_code;
      if (typeof accountId !== 'string' || typeof channel !== 'string' || typeof encryptedCode !== 'string') {
        throw new Error('Verification message is malformed');
      }
      const account = await this.pool.query<{ id: string; phone: string | null; email: string }>(
        'select id, phone, email::text as email from accounts where id = $1', [accountId],
      );
      const recipient = account.rows[0];
      if (!recipient) throw new Error('Verification account does not exist');
      const code = decryptSecret(encryptedCode, APPLICATION_SECRET);
      if (channel === 'PHONE') {
        if (recipient.phone) {
          await this.sendWhatsAppIfAllowed(recipient.phone, `Your Verispon verification code is ${code}. It expires in 10 minutes.`, {
            accountId: recipient.id,
            fallbackTemplate: registeredWhatsAppTemplate('verification_code', [code, '10 minutes']),
          });
        }
      } else {
        await this.email.send(recipient.email, 'Verify your Verispon email', `Your verification code is ${code}. It expires in 10 minutes.`);
      }
      return;
    }

    if (event.topic === 'whatsapp.reply') {
      const phone = event.payload.phone;
      const text = event.payload.text;
      if (typeof phone !== 'string' || typeof text !== 'string') throw new Error('WhatsApp reply is malformed');
      await this.sendWhatsAppIfAllowed(
        phone,
        text,
        {
          ...(typeof event.payload.account_id === 'string' ? { accountId: event.payload.account_id } : {}),
          allowOptOutConfirmation: event.payload.allow_opt_out_confirmation === true,
          ...(typeof event.payload.service_window_expires_at === 'string'
            ? { serviceWindowExpiresAt: event.payload.service_window_expires_at }
            : {}),
          fallbackTemplate: registeredWhatsAppTemplate(
            event.payload.allow_opt_out_confirmation === true ? 'opt_out_confirmation' : 'account_update',
          ),
        },
      );
      return;
    }

    if (event.topic === 'payment.intent_requested') {
      if (!event.transaction_id || !this.nomba.isConfigured()) throw new Error('Nomba checkout is not configured');
      const transactionResult = await this.pool.query<{
        id: string; reference: string; amount_kobo: string; buyer_fee_kobo: string; buyer_email: string; state: string;
      }>(
        `select t.id, t.reference, t.amount_kobo, t.buyer_fee_kobo, a.email::text as buyer_email, t.state
         from transactions t join accounts a on a.id = t.buyer_account_id where t.id = $1`, [event.transaction_id],
      );
      const transaction = transactionResult.rows[0];
      if (!transaction || transaction.state !== 'AWAITING_PAYMENT') return;
      // transaction.reference already carries the VSP- prefix, so prefixing it
      // again would store 'VSP-VSP-482913' as the provider order reference.
      const orderReference = transaction.reference;
      const amountKobo = BigInt(transaction.amount_kobo) + BigInt(transaction.buyer_fee_kobo);
      const existing = await this.pool.query<{ status: string }>(
        'select status from payment_intents where transaction_id = $1', [transaction.id],
      );
      // Any existing intent means checkout was already requested. Re-running
      // createCheckout would open a second provider order for the same
      // transaction on every retry of this event, so only an absent intent
      // may create one. A PENDING intent is left alone deliberately: the
      // provider call may have succeeded before the row was confirmed, and
      // re-issuing is the more expensive mistake of the two.
      if (existing.rowCount !== 0) return;
      await this.pool.query(
        `insert into payment_intents (transaction_id, provider_order_reference, amount_kobo)
         values ($1, $2, $3) on conflict (transaction_id) do nothing`,
        [transaction.id, orderReference, amountKobo.toString()],
      );
      const checkout = await this.nomba.createCheckout({
        orderReference, amountKobo, customerEmail: transaction.buyer_email, transactionId: transaction.id,
      });
      await this.pool.query(
        `update payment_intents set provider_order_id = $2, checkout_url = $3, status = 'READY', updated_at = now()
         where transaction_id = $1`,
        [transaction.id, checkout.orderReference, checkout.checkoutLink],
      );
      await this.pool.query(
        `insert into outbox_events (topic, transaction_id, payload)
         values ('transaction.payment_ready', $1, $2)`,
        [transaction.id, JSON.stringify({ checkout_url: checkout.checkoutLink })],
      );
      return;
    }

    if (event.topic === 'transaction.payment_ready') {
      if (!event.transaction_id || typeof event.payload.checkout_url !== 'string') throw new Error('Payment-ready event is malformed');
      const buyer = await this.pool.query<{ id: string; phone: string | null; email: string; consent: boolean }>(
        `select id, phone, email::text as email,
                (whatsapp_consent_at is not null and whatsapp_opted_out_at is null) as consent
         from accounts where id = (select buyer_account_id from transactions where id = $1)`, [event.transaction_id],
      );
      const recipient = buyer.rows[0];
      if (!recipient) throw new Error('Payment buyer does not exist');
      const text = `Complete your Verispon payment securely: ${event.payload.checkout_url}`;
      const delivered = recipient.consent && recipient.phone
        ? await this.sendWhatsAppIfAllowed(recipient.phone, text, {
            accountId: recipient.id,
            fallbackTemplate: registeredWhatsAppTemplate('payment_ready', [event.payload.checkout_url]),
          })
        : false;
      if (!delivered) await this.email.send(recipient.email, 'Complete your Verispon payment', text);
      return;
    }

    if (event.topic === 'payout.requested') {
      if (!event.transaction_id) throw new Error('Payout request has no transaction id');
      await this.payouts.dispatch(event.transaction_id);
      const seller = await this.pool.query<{
        id: string;
        reference: string;
        phone: string | null;
        email: string;
        consent: boolean;
      }>(
        `select a.id, t.reference, a.phone, a.email::text as email,
                (a.whatsapp_consent_at is not null and a.whatsapp_opted_out_at is null) as consent
         from transactions t join accounts a on a.id = t.seller_account_id
         where t.id = $1`,
        [event.transaction_id],
      );
      const recipient = seller.rows[0];
      if (!recipient) throw new Error('Seller account for payout request was not found');
      const text = `Payout for ${recipient.reference} has been requested and is being processed.`;
      const delivered = recipient.consent && recipient.phone
        ? await this.sendWhatsAppIfAllowed(recipient.phone, text, {
            accountId: recipient.id,
            fallbackTemplate: registeredWhatsAppTemplate('payout_requested', [recipient.reference]),
          })
        : false;
      if (!delivered) await this.email.send(recipient.email, 'Verispon payout update', text);
      return;
    }

    if (event.topic === 'payout.returned') {
      if (!event.transaction_id) throw new Error('Returned payout has no transaction id');
      const seller = await this.pool.query<{ id: string; phone: string | null; email: string; consent: boolean; reference: string }>(
        `select a.id, a.phone, a.email::text as email,
                (a.whatsapp_consent_at is not null and a.whatsapp_opted_out_at is null) as consent,
                t.reference
         from transactions t join accounts a on a.id = t.seller_account_id where t.id = $1`, [event.transaction_id],
      );
      const row = seller.rows[0];
      if (!row) throw new Error('Seller account for returned payout was not found');
      const message = `Payout for ${row.reference} returned to Verispon. The balance remains owed; update your verified payout details or contact support.`;
      const delivered = row.consent && row.phone
        ? await this.sendWhatsAppIfAllowed(row.phone, message, {
            accountId: row.id,
            fallbackTemplate: registeredWhatsAppTemplate('payout_returned', [row.reference]),
          })
        : false;
      if (!delivered) await this.email.send(row.email, 'Verispon payout requires attention', message);
      return;
    }

    if (event.topic === 'refund.requested') {
      if (!event.transaction_id || typeof event.payload.amount_kobo !== 'string') {
        throw new Error('Refund request is malformed');
      }
      const originalPayment = await this.pool.query<{ provider_transaction_id: string | null }>(
        `select provider_transaction_id from payment_intents
         where transaction_id = $1 and status = 'PAID'`, [event.transaction_id],
      );
      const providerTransactionId = originalPayment.rows[0]?.provider_transaction_id;
      if (!providerTransactionId) throw new Error('Original Nomba transaction reference is missing');

      const attempt = await withTransaction(async (client) => {
        await client.query(
          `insert into refund_attempts (outbox_event_id, transaction_id, provider_transaction_id, amount_kobo)
           values ($1, $2, $3, $4) on conflict (outbox_event_id) do nothing`,
          [event.id, event.transaction_id, providerTransactionId, event.payload.amount_kobo],
        );
        const selected = await client.query<{ id: string; status: string }>(
          'select id, status from refund_attempts where outbox_event_id = $1 for update', [event.id],
        );
        const row = selected.rows[0];
        if (!row) throw new Error('Refund attempt was not persisted');
        if (row.status !== 'PREPARED') return { id: row.id, shouldSubmit: false };
        await this.writePosting(client, event.transaction_id!, 'buyer', payoutDispatchPosting(BigInt(event.payload.amount_kobo as string), 'buyer'));
        await client.query("update refund_attempts set status = 'SUBMITTING', updated_at = now() where id = $1", [row.id]);
        return { id: row.id, shouldSubmit: true };
      });
      if (!attempt.shouldSubmit) {
        if (attempt.id) console.error('Refund attempt requires reconciliation; automatic resend suppressed', { eventId: event.id, attemptId: attempt.id });
        return;
      }

      try {
        await this.nomba.refundCheckout(providerTransactionId, BigInt(event.payload.amount_kobo));
        await withTransaction(async (client) => {
          const state = await client.query<{ status: string; transaction_id: string }>(
            'select status, transaction_id from refund_attempts where id = $1 for update', [attempt.id],
          );
          if (state.rows[0]?.status !== 'SUBMITTING') return;
          await this.writePosting(client, state.rows[0].transaction_id, 'buyer', payoutSettlementPosting(BigInt(event.payload.amount_kobo as string), 'buyer'));
          await client.query("update refund_attempts set status = 'SETTLED', updated_at = now() where id = $1", [attempt.id]);
          await client.query(
            `insert into outbox_events (topic, transaction_id, payload)
             values ('transaction.refund_update', $1, '{}'::jsonb)`,
            [state.rows[0].transaction_id],
          );
        });
      } catch (error) {
        await this.pool.query(
          `update refund_attempts set status = 'UNKNOWN', error_code = $2, updated_at = now() where id = $1`,
          [attempt.id, error instanceof Error ? error.message.slice(0, 500) : 'Unknown provider error'],
        );
        console.error('Nomba refund outcome is unknown; automatic resend suppressed', { eventId: event.id, attemptId: attempt.id, error });
      }
      return;
    }

    if ([
      'transaction.created',
      'transaction.state_changed',
      'transaction.disputed',
      'transaction.funded',
      'transaction.evidence_added',
      'transaction.dispute_response_added',
      'transaction.refund_update',
    ].includes(event.topic)) {
      if (!event.transaction_id) throw new Error('Transaction event has no transaction id');
      const transaction = await this.pool.query<{ reference: string; state: string; buyer_account_id: string; seller_account_id: string; buyer_phone: string | null; seller_phone: string | null; buyer_email: string; seller_email: string; buyer_consent: boolean; seller_consent: boolean }>(
        `select t.reference, t.state, buyer.id as buyer_account_id, seller.id as seller_account_id,
                buyer.phone as buyer_phone, seller.phone as seller_phone,
                buyer.email as buyer_email, seller.email as seller_email,
                (buyer.whatsapp_consent_at is not null and buyer.whatsapp_opted_out_at is null) as buyer_consent,
                (seller.whatsapp_consent_at is not null and seller.whatsapp_opted_out_at is null) as seller_consent
         from transactions t join accounts buyer on buyer.id = t.buyer_account_id
         join accounts seller on seller.id = t.seller_account_id where t.id = $1`,
        [event.transaction_id],
      );
      const row = transaction.rows[0];
      if (!row) throw new Error('Transaction notification target no longer exists');
      const detail = event.topic === 'transaction.disputed'
        ? 'A dispute has been opened. This pauses payout; it is not a refund.'
        : event.topic === 'transaction.funded'
          ? `The buyer has paid for ${row.reference}. Prepare the item in Verispon.`
        : event.topic === 'transaction.refund_update'
          ? `Refund request for ${row.reference} was submitted to the payment provider. Check your account for the outcome.`
        : `Transaction ${row.reference} is now ${row.state.replaceAll('_', ' ').toLowerCase()}.`;
      const allRecipients = [
        { accountId: row.buyer_account_id, phone: row.buyer_phone, email: row.buyer_email, consent: row.buyer_consent },
        { accountId: row.seller_account_id, phone: row.seller_phone, email: row.seller_email, consent: row.seller_consent },
      ];
      const recipients = event.topic === 'transaction.funded' || event.topic === 'transaction.disputed'
        ? allRecipients.filter((recipient) => recipient.accountId === row.seller_account_id)
        : event.topic === 'transaction.refund_update'
          ? allRecipients.filter((recipient) => recipient.accountId === row.buyer_account_id)
        : event.topic === 'transaction.state_changed' && event.payload.to === 'FUNDED'
          ? allRecipients.filter((recipient) => recipient.accountId === row.buyer_account_id)
        : allRecipients;
      await Promise.all(recipients.map(async (recipient) => {
        const templateKey = event.topic === 'transaction.funded' ? 'transaction_funded'
          : event.topic === 'transaction.disputed' ? 'transaction_disputed'
            : event.topic === 'transaction.refund_update' ? 'refund_update'
            : 'transaction_update';
        const templateParameters = templateKey === 'transaction_update'
          ? [row.reference, row.state.replaceAll('_', ' ').toLowerCase()]
          : [row.reference];
        const delivered = recipient.consent && recipient.phone
          ? await this.sendWhatsAppIfAllowed(recipient.phone, `Verispon: ${detail}`, {
              accountId: recipient.accountId,
              fallbackTemplate: registeredWhatsAppTemplate(templateKey, templateParameters),
            })
          : false;
        if (!delivered) await this.email.send(recipient.email, 'Verispon transaction update', detail);
      }));
      return;
    }

    throw new Error(`No provider handler configured for outbox topic: ${event.topic}`);
  }

  private async writePosting(
    client: import('pg').PoolClient,
    transactionId: string,
    actor: string,
    legs: ReturnType<typeof payoutDispatchPosting>,
  ): Promise<void> {
    assertBalanced(legs);
    const groupId = randomUUID();
    for (const leg of legs) {
      await client.query(
        `insert into ledger_entries (group_id, transaction_id, account, direction, amount_kobo, memo, actor)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [groupId, transactionId, leg.account, leg.direction, leg.amountKobo.toString(), leg.memo, actor],
      );
    }
  }
}

export async function runWorkers(pool: Pool): Promise<void> {
  const escrow = new EscrowService(new PostgresEscrowRepository());
  const outbox = new OutboxWorker(pool);

  const drain = async () => {
    try { await outbox.drainBatch(); } catch (error) { console.error('Outbox batch failed', error); }
  };
  const autoRelease = async () => {
    try {
      if (!Number(process.env.AUTO_RELEASE_HOURS)) return;
      const repository = new PostgresEscrowRepository();
      const due = await repository.findDueAutoReleases(50);
      for (const transactionId of due) await escrow.autoRelease(transactionId);
    } catch (error) { console.error('Auto-release batch failed', error); }
  };
  const cleanup = async () => {
    try {
      await pool.query('delete from recovery_challenges where expires_at < now() - interval \'1 day\'');
      await pool.query('delete from account_verification_challenges where expires_at < now() - interval \'1 day\'');
      await pool.query('delete from rate_limit_buckets where window_started_at < now() - interval \'1 day\'');
      await pool.query('delete from idempotency_keys where expires_at < now()');
    } catch (error) { console.error('Backend data cleanup failed', error); }
  };
  const reportStaleTransactions = async () => {
    try {
      const stale = await pool.query(
        `select id, reference, state, updated_at from transactions
         where state not in ('COMPLETED', 'CANCELLED', 'REFUNDED')
           and updated_at < now() - interval '24 hours'
         order by updated_at asc limit 100`,
      );
      if (stale.rowCount) console.error('Transactions require operational review', stale.rows);
    } catch (error) { console.error('Stale-state scan failed', error); }
  };

  await drain();
  await autoRelease();
  await cleanup();
  await reportStaleTransactions();
  setInterval(() => { void drain(); }, 5_000);
  setInterval(() => { void autoRelease(); }, 60_000);
  setInterval(() => { void cleanup(); }, 5 * 60_000);
  setInterval(() => { void reportStaleTransactions(); }, 60 * 60_000);
  setInterval(() => {
    void pool.query(
      `select t.id from transactions t
       left join ledger_entries l on l.transaction_id = t.id and l.account = 'escrow_cash'
       group by t.id, t.state, t.amount_kobo, t.refunded_kobo
      having case when t.state in ('FUNDED', 'SELLER_PROCESSING', 'SHIPPED', 'DELIVERED', 'BUYER_INSPECTION',
               'DELIVERY_FAILED', 'RETURN_IN_PROGRESS', 'DISPUTED', 'UNDER_REVIEW', 'PARTIALLY_REFUNDED')
             then t.amount_kobo - t.refunded_kobo else 0 end
         <> coalesce(sum(case when l.direction = 'C' then l.amount_kobo when l.direction = 'D' then -l.amount_kobo else 0 end), 0)`,
    ).then((result) => {
      if (result.rowCount) console.error('Ledger reconciliation mismatch', result.rows);
    }).catch((error: unknown) => console.error('Ledger reconciliation failed', error));
  }, 60 * 60_000);
}