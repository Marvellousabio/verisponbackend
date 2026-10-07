import {
  assertClientTransition,
  assertTransition,
  FUNDS_HELD_STATES,
  type ActorKind,
  type TransactionState,
} from '../domain/escrow.js';
import { fundingPosting, refundPosting, releasePosting } from '../domain/ledger.js';
import type { EscrowRepository, EscrowTransaction, EscrowUnitOfWork } from '../repositories/escrow-repository.js';
import type { IdempotencyContext } from '../db/idempotency.js';
import { config } from '../config.js';

export class ResourceNotFoundError extends Error {
  constructor() {
    super('Resource not found');
    this.name = 'ResourceNotFoundError';
  }
}

export class AuthorizationError extends Error {
  constructor() {
    super('Action is not permitted');
    this.name = 'AuthorizationError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export interface Actor {
  accountId: string;
  kind: ActorKind;
}

function assertParty(transaction: EscrowTransaction, actor: Actor): void {
  if (actor.accountId !== transaction.buyerAccountId && actor.accountId !== transaction.sellerAccountId) {
    throw new ResourceNotFoundError();
  }
}

const BUYER_TRANSITIONS = new Set<TransactionState>(['AWAITING_PAYMENT', 'BUYER_INSPECTION', 'RELEASED', 'CANCELLED']);
const SELLER_TRANSITIONS = new Set<TransactionState>(['AWAITING_BUYER_VERIFICATION', 'SELLER_PROCESSING', 'SHIPPED', 'DELIVERY_FAILED', 'CANCELLED']);

/**
 * The transaction row, not the caller, decides which side of the deal the
 * actor is on. Deriving the role here means a route cannot assert a role it
 * has not established, and a mismatch between the two is a 404 rather than a
 * 403, which keeps a caller from probing party membership.
 */
function partyRole(transaction: EscrowTransaction, accountId: string): 'buyer' | 'seller' {
  if (accountId === transaction.buyerAccountId) return 'buyer';
  if (accountId === transaction.sellerAccountId) return 'seller';
  throw new ResourceNotFoundError();
}

function assertActorRole(transaction: EscrowTransaction, actor: Actor): void {
  const role = partyRole(transaction, actor.accountId);
  if (actor.kind !== role) throw new AuthorizationError();
}

function assertTransitionActor(transaction: EscrowTransaction, accountId: string, to: TransactionState): 'buyer' | 'seller' {
  const role = partyRole(transaction, accountId);
  const permitted = role === 'buyer' ? BUYER_TRANSITIONS : SELLER_TRANSITIONS;
  if (!permitted.has(to)) throw new AuthorizationError();
  return role;
}

/**
 * `docs/BACKEND.md` requires that escrow_cash never goes negative and that a
 * movement overdrawing it is refused with VALIDATION. The cached
 * `amountKobo - refundedKobo` is not that check: it agrees with the ledger
 * while every previous posting was made by this engine, and silently drifts if
 * one was not. Comparing against the posted balance turns the invariant into
 * something enforced rather than assumed.
 */
async function assertEscrowCovers(unit: EscrowUnitOfWork, transactionId: string, principalKobo: bigint): Promise<void> {
  const held = await unit.escrowCashBalance(transactionId);
  if (principalKobo > held) {
    throw new ValidationError('Escrow balance does not cover this movement');
  }
}

export class EscrowService {
  constructor(private readonly repository: EscrowRepository) {}

  async transition(transactionId: string, accountId: string, to: TransactionState, note?: string, idempotency?: IdempotencyContext): Promise<{ transaction_id: string; state: TransactionState }> {
    assertClientTransition(to);
    return this.repository.transaction(async (unit) => {
      const transaction = await unit.findTransactionForUpdate(transactionId);
      if (!transaction) throw new ResourceNotFoundError();
      const kind = assertTransitionActor(transaction, accountId, to);
      assertTransition(transaction.state, to);

      const effectiveActor: Actor = { accountId, kind };
      if (to === 'AWAITING_PAYMENT' && transaction.photosEnabled && !(await unit.hasEvidence(transaction.id, 'ITEM_BEFORE_TRANSACTION'))) {
        throw new ValidationError('Upload a photo of the item before asking the buyer to pay');
      }
      if (to === 'RELEASED') {
        if (await unit.hasOpenDispute(transaction.id)) throw new ValidationError('A disputed transaction cannot be released');
        if (!(await unit.hasPayoutDestination(transaction.sellerAccountId))) throw new ValidationError('Seller must add a verified payout destination before release');
        const principal = transaction.amountKobo - transaction.refundedKobo;
        if (principal <= transaction.sellerFeeKobo) throw new ValidationError('Remaining principal must exceed the seller fee');
        await assertEscrowCovers(unit, transaction.id, principal);
        await unit.writePosting(transaction.id, effectiveActor.kind, releasePosting(principal, transaction.sellerFeeKobo));
        await unit.updateState(transaction, to, accountId, { payoutAuthorised: true });
        await unit.enqueue('payout.requested', transaction.id, { amount_kobo: (principal - transaction.sellerFeeKobo).toString() });
      } else if (to === 'CANCELLED' && FUNDS_HELD_STATES.has(transaction.state)) {
        // Cancelling once the money has arrived is a refund, not a withdrawal
        // of an empty promise. Only the buyer gets this path: a seller who
        // could cancel a funded transaction would keep the principal without
        // ever shipping, which is the one outcome escrow exists to prevent.
        if (kind !== 'buyer') throw new AuthorizationError();
        const principal = transaction.amountKobo - transaction.refundedKobo;
        if (principal <= 0n) throw new ValidationError('There is no principal left to refund');
        await assertEscrowCovers(unit, transaction.id, principal);
        await unit.writePosting(transaction.id, effectiveActor.kind, refundPosting(principal, transaction.buyerFeeKobo));
        await unit.updateState(transaction, 'CANCELLED', accountId, {
          refundedKobo: transaction.refundedKobo + principal,
          cancellationReason: note ?? 'Cancelled by the buyer after payment',
        });
        await unit.enqueue('refund.requested', transaction.id, {
          amount_kobo: principal.toString(),
          reason: note ?? 'Cancelled by the buyer after payment',
        });
      } else {
        const stateOptions = to === 'CANCELLED' && note ? { cancellationReason: note }
          : to === 'BUYER_INSPECTION' && config.AUTO_RELEASE_HOURS ? { autoReleaseHours: config.AUTO_RELEASE_HOURS }
          : {};
        await unit.updateState(transaction, to, accountId, stateOptions);
      }

      await unit.appendEvent(transaction.id, to, effectiveActor.kind, accountId, note);
      await unit.enqueue('transaction.state_changed', transaction.id, { from: transaction.state, to });
      if (to === 'AWAITING_PAYMENT') {
        await unit.enqueue('payment.intent_requested', transaction.id, { transaction_id: transaction.id });
      }
      return { transaction_id: transaction.id, state: to };
    }, idempotency);
  }

  async autoRelease(transactionId: string): Promise<boolean> {
    return this.repository.transaction(async (unit) => {
      const transaction = await unit.findTransactionForUpdate(transactionId);
      if (!transaction || transaction.state !== 'BUYER_INSPECTION' || !transaction.autoReleaseAt) return false;
      if (transaction.autoReleaseAt.getTime() > Date.now() || await unit.hasOpenDispute(transaction.id)) return false;
      if (!(await unit.hasPayoutDestination(transaction.sellerAccountId))) return false;
      assertTransition(transaction.state, 'RELEASED');
      const principal = transaction.amountKobo - transaction.refundedKobo;
      if (principal <= transaction.sellerFeeKobo) throw new ValidationError('Remaining principal must exceed the seller fee');
      await assertEscrowCovers(unit, transaction.id, principal);
      await unit.writePosting(transaction.id, 'system', releasePosting(principal, transaction.sellerFeeKobo));
      await unit.updateState(transaction, 'RELEASED', null, { payoutAuthorised: true });
      await unit.appendEvent(transaction.id, 'RELEASED', 'system', null, 'Automatically released after inspection window');
      await unit.enqueue('payout.requested', transaction.id, { amount_kobo: (principal - transaction.sellerFeeKobo).toString() });
      await unit.enqueue('transaction.state_changed', transaction.id, { from: transaction.state, to: 'RELEASED', reason: 'auto_release' });
      return true;
    });
  }

  async openDispute(transactionId: string, actor: Actor, reason: string, summary: string, idempotency?: IdempotencyContext): Promise<{ transaction_id: string; state: 'DISPUTED' }> {
    if (summary.trim().length < 20 || summary.trim().length > 2000) {
      throw new ValidationError('Dispute summary must be between 20 and 2000 characters');
    }

    return this.repository.transaction(async (unit) => {
      const transaction = await unit.findTransactionForUpdate(transactionId);
      if (!transaction) throw new ResourceNotFoundError();
      if (actor.accountId !== transaction.buyerAccountId) throw new ResourceNotFoundError();
      assertActorRole(transaction, actor);
      if (!FUNDS_HELD_STATES.has(transaction.state)) throw new ValidationError('Disputes require funds to be held');
      if (await unit.hasDispute(transaction.id)) throw new ConflictError('A dispute already exists for this transaction');
      assertTransition(transaction.state, 'DISPUTED');

      await unit.createDispute(transaction.id, actor.accountId, reason, summary.trim());
      await unit.updateState(transaction, 'DISPUTED', actor.accountId);
      await unit.appendEvent(transaction.id, 'DISPUTED', 'buyer', actor.accountId, summary.trim());
      await unit.enqueue('transaction.disputed', transaction.id, { reason, summary: summary.trim() });
      return { transaction_id: transaction.id, state: 'DISPUTED' as const };
    }, idempotency);
  }

  async respondToDispute(transactionId: string, actor: Actor, summary: string, idempotency?: IdempotencyContext): Promise<{ transaction_id: string; response_added: true }> {
    const normalizedSummary = summary.trim();
    if (normalizedSummary.length < 20 || normalizedSummary.length > 2000) {
      throw new ValidationError('Dispute response must be between 20 and 2000 characters');
    }
    return this.repository.transaction(async (unit) => {
      const transaction = await unit.findTransactionForUpdate(transactionId);
      if (!transaction || actor.accountId !== transaction.sellerAccountId) throw new ResourceNotFoundError();
      assertActorRole(transaction, actor);
      if (!(await unit.hasOpenDispute(transaction.id))) throw new ValidationError('No open dispute exists for this transaction');
      await unit.createDisputeResponse(transaction.id, actor.accountId, normalizedSummary);
      await unit.appendEvent(transaction.id, transaction.state, 'seller', actor.accountId, 'Seller submitted a dispute response');
      await unit.enqueue('transaction.dispute_response_added', transaction.id, { response: normalizedSummary });
      return { transaction_id: transaction.id, response_added: true as const };
    }, idempotency);
  }

  async confirmFunding(transactionId: string, paidAmountKobo: bigint, providerEventId: string, providerTransactionId: string, orderReference: string): Promise<boolean> {
    return this.repository.transaction(async (unit) => {
      if (!(await unit.claimProviderEvent('nomba', providerEventId))) return false;
      const transaction = await unit.findTransactionForUpdate(transactionId);
      if (!transaction) throw new ResourceNotFoundError();
      if (transaction.state !== 'AWAITING_PAYMENT') {
        throw new ValidationError('Transaction is not awaiting payment');
      }
      const expectedAmount = transaction.amountKobo + transaction.buyerFeeKobo;
      if (paidAmountKobo !== expectedAmount) throw new ValidationError('Payment amount does not match the transaction total');

      await unit.writePosting(transaction.id, 'system', fundingPosting(transaction.amountKobo, transaction.buyerFeeKobo));
      await unit.updateState(transaction, 'FUNDED', null);
      await unit.appendEvent(transaction.id, 'FUNDED', 'system', null, 'Payment confirmed');
      await unit.enqueue('transaction.funded', transaction.id, { provider_event_id: providerEventId });
      await unit.markPaymentIntentPaid(orderReference, providerTransactionId, providerEventId);
      await unit.enqueue('transaction.state_changed', transaction.id, { from: 'AWAITING_PAYMENT', to: 'FUNDED' });
      return true;
    });
  }

  /**
   * Moves a disputed transaction into assessment. `DISPUTED -> UNDER_REVIEW` is
   * engine-only, so a client cannot trigger it and an admin route cannot post a
   * raw state. Without this the state is unreachable: nothing else writes
   * `UNDER_REVIEW`, so every resolution below would be refused and the funds
   * would stay in escrow with no path out but an operator editing the database.
   */
  async beginDisputeReview(transactionId: string, actor: Actor, idempotency?: IdempotencyContext): Promise<{ transaction_id: string; state: TransactionState }> {
    if (actor.kind !== 'admin') throw new AuthorizationError();
    return this.repository.transaction(async (unit) => {
      const transaction = await unit.findTransactionForUpdate(transactionId);
      if (!transaction) throw new ResourceNotFoundError();
      if (transaction.state === 'UNDER_REVIEW') return { transaction_id: transaction.id, state: 'UNDER_REVIEW' };
      if (transaction.state !== 'DISPUTED') {
        throw new ValidationError('Only a disputed transaction can be moved into review');
      }
      if (!(await unit.hasOpenDispute(transaction.id))) {
        throw new ValidationError('Transaction does not have an open dispute');
      }
      assertTransition(transaction.state, 'UNDER_REVIEW');
      await unit.updateState(transaction, 'UNDER_REVIEW', actor.accountId);
      await unit.appendEvent(transaction.id, 'UNDER_REVIEW', 'admin', actor.accountId, 'Dispute assessment started');
      await unit.enqueue('transaction.state_changed', transaction.id, { from: transaction.state, to: 'UNDER_REVIEW' });
      return { transaction_id: transaction.id, state: 'UNDER_REVIEW' as const };
    }, idempotency);
  }

  async resolveDispute(
    transactionId: string,
    actor: Actor,
    decision: 'RELEASE' | 'REFUND' | 'PARTIAL_REFUND',
    resolution: string,
    partialRefundKobo?: bigint,
    idempotency?: IdempotencyContext,
  ): Promise<{ transaction_id: string; state: TransactionState; refund_kobo: string | null }> {
    if (actor.kind !== 'admin') throw new AuthorizationError();
    if (resolution.trim().length < 10 || resolution.trim().length > 2000) {
      throw new ValidationError('Resolution note must be between 10 and 2000 characters');
    }

    return this.repository.transaction(async (unit) => {
      const transaction = await unit.findTransactionForUpdate(transactionId);
      if (!transaction) throw new ResourceNotFoundError();
      if (transaction.state !== 'UNDER_REVIEW' || !(await unit.hasOpenDispute(transactionId))) {
        throw new ValidationError('Transaction does not have an open dispute under review');
      }

      const remainingKobo = transaction.amountKobo - transaction.refundedKobo;
      let state: TransactionState;
      let refundKobo: bigint | null = null;
      let disputeStatus: string;
      let partialRefundState: TransactionState | null = null;
      if (decision === 'RELEASE') {
        assertTransition(transaction.state, 'RELEASED');
        if (!(await unit.hasPayoutDestination(transaction.sellerAccountId))) throw new ValidationError('Seller must add a verified payout destination before release');
        if (remainingKobo <= transaction.sellerFeeKobo) throw new ValidationError('Remaining principal must exceed the seller fee');
        await assertEscrowCovers(unit, transaction.id, remainingKobo);
        await unit.writePosting(transaction.id, 'admin', releasePosting(remainingKobo, transaction.sellerFeeKobo));
        state = 'RELEASED';
        disputeStatus = 'RESOLVED_RELEASE';
        await unit.updateState(transaction, state, actor.accountId, { payoutAuthorised: true });
        await unit.enqueue('payout.requested', transaction.id, { amount_kobo: (remainingKobo - transaction.sellerFeeKobo).toString() });
      } else {
        const refund = decision === 'REFUND' ? remainingKobo : partialRefundKobo;
        if (refund === undefined || refund <= 0n || refund > remainingKobo) {
          throw new ValidationError('Refund must be within the remaining escrow principal');
        }
        if (decision === 'PARTIAL_REFUND' && refund >= remainingKobo) {
          throw new ValidationError('Partial refund must be less than the remaining principal');
        }
        state = decision === 'REFUND' ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        assertTransition(transaction.state, state);
        if (state === 'PARTIALLY_REFUNDED' && remainingKobo - refund <= transaction.sellerFeeKobo) {
          throw new ValidationError('Partial refund must leave enough principal for the seller fee');
        }
        if (state === 'PARTIALLY_REFUNDED' && !(await unit.hasPayoutDestination(transaction.sellerAccountId))) {
          throw new ValidationError('Seller must add a verified payout destination before split settlement');
        }
        refundKobo = refund;
        disputeStatus = decision === 'REFUND' ? 'RESOLVED_REFUND' : 'RESOLVED_PARTIAL';
        await assertEscrowCovers(unit, transaction.id, refund);
        await unit.writePosting(transaction.id, 'admin', refundPosting(refund, transaction.buyerFeeKobo));
        await unit.updateState(transaction, state, actor.accountId, { refundedKobo: transaction.refundedKobo + refund });
        await unit.enqueue('refund.requested', transaction.id, { amount_kobo: refund.toString(), resolution: resolution.trim() });
        if (state === 'PARTIALLY_REFUNDED') {
          partialRefundState = state;
          await unit.appendEvent(transaction.id, state, 'admin', actor.accountId, resolution.trim());
          const releasedPrincipal = remainingKobo - refund;
          await assertEscrowCovers(unit, transaction.id, releasedPrincipal);
          await unit.writePosting(transaction.id, 'admin', releasePosting(releasedPrincipal, transaction.sellerFeeKobo));
          await unit.updateState({ ...transaction, state, refundedKobo: transaction.refundedKobo + refund }, 'RELEASED', actor.accountId, { payoutAuthorised: true });
          await unit.enqueue('payout.requested', transaction.id, { amount_kobo: (releasedPrincipal - transaction.sellerFeeKobo).toString() });
          state = 'RELEASED';
        }
      }

      await unit.resolveDispute(transactionId, actor.accountId, disputeStatus, resolution.trim(), refundKobo);
      await unit.appendEvent(transaction.id, state, 'admin', actor.accountId, resolution.trim());
      await unit.enqueue('transaction.state_changed', transaction.id, { from: transaction.state, to: state });
      await unit.writeAudit(actor.accountId, 'dispute.resolve', transaction.id,
        { state: transaction.state, refunded_kobo: transaction.refundedKobo.toString() },
        { state, refunded_kobo: refundKobo === null ? transaction.refundedKobo.toString() : (transaction.refundedKobo + refundKobo).toString(), dispute_status: disputeStatus, split_refund_released: partialRefundState !== null },
      );
      return { transaction_id: transaction.id, state, refund_kobo: refundKobo?.toString() ?? null };
    }, idempotency);
  }
}