import type { LedgerLeg } from '../domain/ledger.js';
import type { TransactionState } from '../domain/escrow.js';
import type { IdempotencyContext } from '../db/idempotency.js';

export interface EscrowTransaction {
  id: string;
  reference: string;
  state: TransactionState;
  buyerAccountId: string;
  sellerAccountId: string;
  amountKobo: bigint;
  buyerFeeKobo: bigint;
  sellerFeeKobo: bigint;
  refundedKobo: bigint;
  autoReleaseAt: Date | null;
  /**
   * Whether the seller agreed to a before/after condition-photo pair. When set,
   * the move into AWAITING_PAYMENT is refused until an ITEM_BEFORE_TRANSACTION
   * exists, so the flag has to be readable inside the transition transaction.
   */
  photosEnabled: boolean;
}

export interface EscrowUnitOfWork {
  findTransactionForUpdate(id: string): Promise<EscrowTransaction | null>;
  hasDispute(transactionId: string): Promise<boolean>;
  hasOpenDispute(transactionId: string): Promise<boolean>;
  hasPayoutDestination(sellerAccountId: string): Promise<boolean>;
  hasEvidence(transactionId: string, type: string): Promise<boolean>;
  /**
   * The posted escrow_cash balance for a transaction, read inside the same
   * transaction as the posting it guards. `amountKobo - refundedKobo` is only a
   * cached figure; this is the money the ledger actually holds.
   */
  escrowCashBalance(transactionId: string): Promise<bigint>;
  updateState(
    transaction: EscrowTransaction,
    to: TransactionState,
    actorAccountId: string | null,
    options?: { refundedKobo?: bigint; payoutAuthorised?: boolean; cancellationReason?: string; autoReleaseHours?: number },
  ): Promise<void>;
  writePosting(transactionId: string, actor: string, legs: readonly LedgerLeg[]): Promise<void>;
  appendEvent(transactionId: string, state: TransactionState, actor: string, actorAccountId: string | null, note?: string): Promise<void>;
  enqueue(topic: string, transactionId: string, payload: Record<string, unknown>): Promise<void>;
  createDispute(transactionId: string, openedBy: string, reason: string, summary: string): Promise<void>;
  createDisputeResponse(transactionId: string, authorId: string, summary: string): Promise<void>;
  resolveDispute(transactionId: string, resolvedBy: string, status: string, resolution: string, refundKobo: bigint | null): Promise<void>;
  writeAudit(actorId: string, action: string, targetId: string, before: Record<string, unknown>, after: Record<string, unknown>): Promise<void>;
  claimProviderEvent(provider: string, eventId: string): Promise<boolean>;
  markPaymentIntentPaid(orderReference: string, providerTransactionId: string, providerEventId: string): Promise<void>;
}

export interface EscrowRepository {
  transaction<T>(work: (unit: EscrowUnitOfWork) => Promise<T>, idempotency?: IdempotencyContext): Promise<T>;
  findDueAutoReleases(limit: number): Promise<string[]>;
}