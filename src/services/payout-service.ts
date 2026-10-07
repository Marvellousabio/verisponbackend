import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { NombaAdapter, type NombaVerifiedTransaction } from '../adapters/nomba.js';
import { decryptSecret } from '../auth/secret-payload.js';
import { APPLICATION_SECRET } from '../config.js';
import { payoutDispatchPosting, payoutReturnPosting, payoutSettlementPosting, assertBalanced } from '../domain/ledger.js';

interface PreparedTransfer {
  transactionId: string;
  transactionReference: string;
  amountKobo: bigint;
  merchantTxRef: string;
  accountNumber: string;
  accountName: string;
  bankCode: string;
  existingStatus: 'PREPARED' | 'PENDING' | 'SUCCEEDED' | 'RETURNED';
}

interface LockedTransaction extends QueryResultRow {
  id: string;
  reference: string;
  state: string;
  amount_kobo: string;
  seller_fee_kobo: string;
  refunded_kobo: string;
  seller_account_id: string;
  seller_name: string;
}

export class PayoutDestinationMissingError extends Error {
  constructor() {
    super('Seller payout destination is not configured');
    this.name = 'PayoutDestinationMissingError';
  }
}

export class PayoutService {
  private readonly nomba = new NombaAdapter();

  constructor(private readonly pool: Pool) {}

  async dispatch(transactionId: string): Promise<void> {
    const prepared = await this.prepare(transactionId);
    if (!prepared || prepared.existingStatus !== 'PREPARED') return;

    let result: NombaVerifiedTransaction;
    try {
      const initiated = await this.nomba.transferToBank({
        amountKobo: prepared.amountKobo,
        accountNumber: prepared.accountNumber,
        accountName: prepared.accountName,
        bankCode: prepared.bankCode,
        merchantTxRef: prepared.merchantTxRef,
        narration: `Verispon payout ${prepared.transactionReference}`,
      });
      if (initiated.status === 'SUCCESS') {
        result = await this.nomba.verifyTransfer(prepared.merchantTxRef);
      } else {
        await this.markPending(prepared, initiated.id);
        return;
      }
    } catch (error) {
      try {
        result = await this.nomba.verifyTransfer(prepared.merchantTxRef);
      } catch {
        throw error;
      }
    }

    const providerTransactionId = result.id ?? prepared.merchantTxRef;
    if (result.status === 'SUCCESS') {
      await this.settle(prepared.merchantTxRef, `api:${prepared.merchantTxRef}`, providerTransactionId);
    } else if (result.status === 'REFUND') {
      await this.returnFunds(prepared.merchantTxRef, `api-refund:${prepared.merchantTxRef}`);
    } else {
      await this.markPending(prepared, providerTransactionId);
    }
  }

  async processWebhook(input: { merchantTxRef: string; eventId: string; providerTransactionId: string; status: string }): Promise<void> {
    if (input.status === 'SUCCESS') {
      const verified = await this.nomba.verifyTransfer(input.merchantTxRef);
      if (verified.status !== 'SUCCESS') throw new Error('Nomba payout has not reached successful settlement');
      await this.settle(input.merchantTxRef, input.eventId, verified.id ?? input.providerTransactionId);
    } else if (input.status === 'REFUND') {
      const verified = await this.nomba.verifyTransfer(input.merchantTxRef);
      if (verified.status !== 'REFUND') throw new Error('Nomba has not confirmed that payout funds returned');
      await this.returnFunds(input.merchantTxRef, input.eventId);
    }
  }

  private async prepare(transactionId: string): Promise<PreparedTransfer | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const selected = await client.query<LockedTransaction>(
        `select t.id, t.reference, t.state, t.amount_kobo, t.seller_fee_kobo, t.refunded_kobo,
                t.seller_account_id, t.seller_name
         from transactions t where t.id = $1 for update`, [transactionId],
      );
      const transaction = selected.rows[0];
      if (!transaction || transaction.state !== 'RELEASED') {
        await client.query('commit');
        return null;
      }
      const existing = await client.query<QueryResultRow & {
        merchant_tx_ref: string; amount_kobo: string; status: PreparedTransfer['existingStatus'];
      }>(
        `select merchant_tx_ref, amount_kobo, status from payout_transfers
         where transaction_id = $1 and status in ('PREPARED', 'PENDING', 'SUCCEEDED')
         order by created_at desc limit 1 for update`, [transactionId],
      );
      const destinationResult = await client.query<QueryResultRow & {
        bank_code: string; verified_account_name: string; encrypted_destination: string;
      }>(
        `select bank_code, verified_account_name, encrypted_destination
         from account_payout_destinations where account_id = $1`, [transaction.seller_account_id],
      );
      const destination = destinationResult.rows[0];
      if (!destination) throw new PayoutDestinationMissingError();
      const destinationData = JSON.parse(decryptSecret(destination.encrypted_destination, APPLICATION_SECRET)) as { accountNumber: string };

      if (existing.rows[0]) {
        await client.query('commit');
        return {
          transactionId,
          transactionReference: transaction.reference,
          amountKobo: BigInt(existing.rows[0].amount_kobo),
          merchantTxRef: existing.rows[0].merchant_tx_ref,
          accountNumber: destinationData.accountNumber,
          accountName: destination.verified_account_name,
          bankCode: destination.bank_code,
          existingStatus: existing.rows[0].status,
        };
      }

      const amountKobo = BigInt(transaction.amount_kobo) - BigInt(transaction.refunded_kobo) - BigInt(transaction.seller_fee_kobo);
      if (amountKobo <= 0n) throw new Error('Seller payout amount must be positive');
      const priorCount = await client.query<{ count: string }>('select count(*)::text as count from payout_transfers where transaction_id = $1', [transactionId]);
      const attempt = Number(priorCount.rows[0]!.count) + 1;
      const merchantTxRef = `VSP-PAY-${transaction.reference}-${attempt}`;
      await client.query(
        `insert into payout_transfers (transaction_id, merchant_tx_ref, amount_kobo, status)
         values ($1, $2, $3, 'PREPARED')`, [transactionId, merchantTxRef, amountKobo.toString()],
      );
      await this.writePosting(client, transactionId, 'system', payoutDispatchPosting(amountKobo, 'seller'));
      await client.query('update transactions set payout_reference = $2, updated_at = now() where id = $1', [transactionId, merchantTxRef]);
      await client.query('commit');
      return {
        transactionId,
        transactionReference: transaction.reference,
        amountKobo,
        merchantTxRef,
        accountNumber: destinationData.accountNumber,
        accountName: destination.verified_account_name,
        bankCode: destination.bank_code,
        existingStatus: 'PREPARED',
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async markPending(transfer: PreparedTransfer, providerTransactionId: string): Promise<void> {
    await this.pool.query(
      `update payout_transfers set status = 'PENDING', provider_transaction_id = $2, updated_at = now()
       where merchant_tx_ref = $1 and status = 'PREPARED'`, [transfer.merchantTxRef, providerTransactionId],
    );
    await this.pool.query(
      `insert into transaction_events (transaction_id, state, actor, note)
       values ($1, 'RELEASED', 'system', 'Payout submitted; awaiting provider settlement')`, [transfer.transactionId],
    );
  }

  private async settle(merchantTxRef: string, eventId: string, providerTransactionId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const claimed = await client.query(
        `insert into provider_webhook_events (provider, event_id) values ('nomba', $1)
         on conflict do nothing returning event_id`, [eventId],
      );
      if (claimed.rowCount === 0) {
        await client.query('commit');
        return;
      }
      const result = await client.query<QueryResultRow & { transaction_id: string; amount_kobo: string; status: string }>(
        `select transaction_id, amount_kobo, status from payout_transfers where merchant_tx_ref = $1 for update`, [merchantTxRef],
      );
      const transfer = result.rows[0];
      if (!transfer) throw new Error('Payout transfer not found');
      const tx = await client.query<{ state: string }>('select state from transactions where id = $1 for update', [transfer.transaction_id]);
      if (transfer.status === 'SUCCEEDED') {
        await client.query("update provider_webhook_events set processed_at = now() where provider = 'nomba' and event_id = $1", [eventId]);
        await client.query('commit');
        return;
      }
      if (tx.rows[0]?.state !== 'RELEASED') throw new Error('Transaction is not awaiting payout settlement');
      await this.writePosting(client, transfer.transaction_id, 'system', payoutSettlementPosting(BigInt(transfer.amount_kobo), 'seller'));
      await client.query(
        `update transactions set state = 'COMPLETED', previous_state = 'RELEASED', updated_at = now()
         where id = $1`, [transfer.transaction_id],
      );
      await client.query(
        `update payout_transfers set status = 'SUCCEEDED', provider_transaction_id = $2, updated_at = now()
         where merchant_tx_ref = $1`, [merchantTxRef, providerTransactionId],
      );
      await client.query(
        `insert into transaction_events (transaction_id, state, actor, note)
         values ($1, 'COMPLETED', 'system', 'Seller payout settled by Nomba')`, [transfer.transaction_id],
      );
      await client.query(
        `insert into outbox_events (topic, transaction_id, payload)
         values ('transaction.state_changed', $1, $2)`,
        [transfer.transaction_id, JSON.stringify({ from: 'RELEASED', to: 'COMPLETED' })],
      );
      await client.query("update provider_webhook_events set processed_at = now() where provider = 'nomba' and event_id = $1", [eventId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async returnFunds(merchantTxRef: string, eventId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const claimed = await client.query(
        `insert into provider_webhook_events (provider, event_id) values ('nomba', $1)
         on conflict do nothing returning event_id`, [eventId],
      );
      if (claimed.rowCount === 0) {
        await client.query('commit');
        return;
      }
      const result = await client.query<QueryResultRow & { transaction_id: string; amount_kobo: string; status: string }>(
        `select transaction_id, amount_kobo, status from payout_transfers where merchant_tx_ref = $1 for update`, [merchantTxRef],
      );
      const transfer = result.rows[0];
      if (!transfer) throw new Error('Payout transfer not found');
      if (transfer.status !== 'RETURNED' && transfer.status !== 'SUCCEEDED') {
        await this.writePosting(client, transfer.transaction_id, 'system', payoutReturnPosting(BigInt(transfer.amount_kobo)));
        await client.query(
          `update payout_transfers set status = 'RETURNED', updated_at = now() where merchant_tx_ref = $1`, [merchantTxRef],
        );
        await client.query(
          `insert into transaction_events (transaction_id, state, actor, note)
           values ($1, 'RELEASED', 'system', 'Payout returned to the platform wallet; seller payable remains outstanding')`, [transfer.transaction_id],
        );
        await client.query(
          `insert into outbox_events (topic, transaction_id, payload)
           values ('payout.returned', $1, $2)`,
          [transfer.transaction_id, JSON.stringify({ merchant_tx_ref: merchantTxRef })],
        );
      }
      await client.query("update provider_webhook_events set processed_at = now() where provider = 'nomba' and event_id = $1", [eventId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async writePosting(client: PoolClient, transactionId: string, actor: string, legs: ReturnType<typeof payoutDispatchPosting>): Promise<void> {
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