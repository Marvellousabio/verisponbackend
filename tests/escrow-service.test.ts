import { describe, expect, it } from 'vitest';
import type { TransactionState } from '../src/domain/escrow.js';
import type { LedgerLeg } from '../src/domain/ledger.js';
import type { EscrowRepository, EscrowTransaction, EscrowUnitOfWork } from '../src/repositories/escrow-repository.js';
import { AuthorizationError, ConflictError, EscrowService, ResourceNotFoundError, ValidationError } from '../src/services/escrow-service.js';

class MemoryEscrowRepository implements EscrowRepository {
  postings: LedgerLeg[][] = [];
  events: TransactionState[] = [];
  outbox: string[] = [];
  updates: Array<{ state: TransactionState; refundedKobo?: bigint; payoutAuthorised?: boolean }> = [];
  disputeResolution: string | null = null;
  disputeResponseCount = 0;
  auditActions: string[] = [];
  hasOpen = false;
  evidenceTypes = new Set<string>();
  // Posted escrow_cash balance the engine is allowed to draw down.
  postedEscrowCash = 500_000n;
  transactionRecord: EscrowTransaction = {
    id: 'tx-1', reference: 'VSP-123456', state: 'BUYER_INSPECTION',
    buyerAccountId: 'buyer-1', sellerAccountId: 'seller-1',
    amountKobo: 500_000n, buyerFeeKobo: 10_000n, sellerFeeKobo: 5_000n, refundedKobo: 0n, autoReleaseAt: null,
    photosEnabled: false,
  };

  async transaction<T>(work: (unit: EscrowUnitOfWork) => Promise<T>): Promise<T> {
    const unit: EscrowUnitOfWork = {
      findTransactionForUpdate: async () => this.transactionRecord,
      hasDispute: async () => this.hasOpen,
      hasOpenDispute: async () => this.hasOpen,
      hasPayoutDestination: async () => true,
      hasEvidence: async (_transactionId, type) => this.evidenceTypes.has(type),
      escrowCashBalance: async () => this.postedEscrowCash,
      updateState: async (_transaction, state, _actor, options) => {
        this.updates.push({ state, ...(options?.refundedKobo === undefined ? {} : { refundedKobo: options.refundedKobo }), ...(options?.payoutAuthorised === undefined ? {} : { payoutAuthorised: options.payoutAuthorised }) });
        this.transactionRecord = { ...this.transactionRecord, state, ...(options?.refundedKobo === undefined ? {} : { refundedKobo: options.refundedKobo }) };
      },
      writePosting: async (_transactionId, _actor, legs) => { this.postings.push([...legs]); },
      appendEvent: async (_transactionId, state) => { this.events.push(state); },
      enqueue: async (topic) => { this.outbox.push(topic); },
      createDispute: async () => { this.hasOpen = true; },
      createDisputeResponse: async () => { this.disputeResponseCount += 1; },
      resolveDispute: async (_transactionId, _resolvedBy, status) => { this.disputeResolution = status; this.hasOpen = false; },
      writeAudit: async (_actorId, action) => { this.auditActions.push(action); },
      claimProviderEvent: async () => true,
      markPaymentIntentPaid: async () => undefined,
    };
    return work(unit);
  }

  async findDueAutoReleases(): Promise<string[]> { return []; }
}

describe('escrow service', () => {
  it('blocks the move into AWAITING_PAYMENT until the before photo exists', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = {
      ...repository.transactionRecord,
      state: 'AWAITING_BUYER_VERIFICATION',
      photosEnabled: true,
    };
    const service = new EscrowService(repository);

    // The seller uploads the photo; the buyer is who asks for payment. The gate
    // reads the transaction row, so it does not care who is asking.
    await expect(service.transition('tx-1', 'buyer-1', 'AWAITING_PAYMENT'))
      .rejects.toBeInstanceOf(ValidationError);
    expect(repository.updates).toHaveLength(0);

    repository.evidenceTypes.add('ITEM_BEFORE_TRANSACTION');
    await expect(service.transition('tx-1', 'buyer-1', 'AWAITING_PAYMENT'))
      .resolves.toMatchObject({ state: 'AWAITING_PAYMENT' });
  });

  it('does not gate on a photo when the seller did not ask for one', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = {
      ...repository.transactionRecord,
      state: 'AWAITING_BUYER_VERIFICATION',
      photosEnabled: false,
    };
    const service = new EscrowService(repository);
    await expect(service.transition('tx-1', 'buyer-1', 'AWAITING_PAYMENT'))
      .resolves.toMatchObject({ state: 'AWAITING_PAYMENT' });
  });

  it('refunds the principal and retains the buyer fee when a funded deal is cancelled', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'FUNDED' };
    const service = new EscrowService(repository);

    await service.transition('tx-1', 'buyer-1', 'CANCELLED', 'Changed my mind');

    expect(repository.postings).toHaveLength(1);
    expect(repository.postings[0]).toEqual([
      { account: 'escrow_cash', direction: 'D', amountKobo: 500_000n, memo: 'Escrow principal refunded' },
      { account: 'refund_payable', direction: 'C', amountKobo: 500_000n, memo: 'Refund payable to buyer' },
      { account: 'buyer_fee_revenue', direction: 'D', amountKobo: 10_000n, memo: 'Buyer fee earned at funding is retained' },
      { account: 'platform_equity', direction: 'C', amountKobo: 10_000n, memo: 'Retained buyer fee recognised as platform equity' },
    ]);
    expect(repository.updates[0]).toMatchObject({ state: 'CANCELLED', refundedKobo: 500_000n });
    expect(repository.outbox).toContain('refund.requested');
  });

  it('does not let a seller cancel a funded transaction', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'FUNDED' };
    const service = new EscrowService(repository);

    await expect(service.transition('tx-1', 'seller-1', 'CANCELLED'))
      .rejects.toBeInstanceOf(AuthorizationError);
    expect(repository.postings).toHaveLength(0);
  });

  it('makes no posting when a transaction is cancelled before payment', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'AWAITING_PAYMENT' };
    const service = new EscrowService(repository);

    await service.transition('tx-1', 'buyer-1', 'CANCELLED', 'Found it cheaper');

    expect(repository.postings).toHaveLength(0);
    expect(repository.updates[0]).toMatchObject({ state: 'CANCELLED' });
    expect(repository.outbox).not.toContain('refund.requested');
  });

  it('releases funds once through the buyer-authorized path', async () => {
    const repository = new MemoryEscrowRepository();
    const service = new EscrowService(repository);

    const result = await service.transition('tx-1', 'buyer-1', 'RELEASED');

    expect(result.state).toBe('RELEASED');
    expect(repository.postings).toHaveLength(1);
    expect(repository.events).toEqual(['RELEASED']);
    expect(repository.outbox).toContain('payout.requested');
    expect(repository.updates[0]?.payoutAuthorised).toBe(true);
  });

  it('hides transactions from non-parties', async () => {
    const service = new EscrowService(new MemoryEscrowRepository());
    await expect(service.transition('tx-1', 'stranger', 'RELEASED'))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('refuses a release while a dispute is open', async () => {
    const repository = new MemoryEscrowRepository();
    repository.hasOpen = true;
    const service = new EscrowService(repository);
    await expect(service.transition('tx-1', 'buyer-1', 'RELEASED'))
      .rejects.toBeInstanceOf(ValidationError);
    expect(repository.postings).toHaveLength(0);
  });

  it('refuses a seller-only transition to the buyer and permits it to the seller', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'FUNDED' };
    const service = new EscrowService(repository);

    // The engine derives the role from the transaction row, so a buyer cannot
    // reach a seller-only state and a seller is not refused for being a seller.
    await expect(service.transition('tx-1', 'buyer-1', 'SELLER_PROCESSING'))
      .rejects.toBeInstanceOf(AuthorizationError);
    await expect(service.transition('tx-1', 'seller-1', 'SELLER_PROCESSING'))
      .resolves.toEqual({ transaction_id: 'tx-1', state: 'SELLER_PROCESSING' });
  });

  it('refuses a buyer-only transition to the seller', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'BUYER_INSPECTION' };
    const service = new EscrowService(repository);

    await expect(service.transition('tx-1', 'seller-1', 'RELEASED'))
      .rejects.toBeInstanceOf(AuthorizationError);
    expect(repository.postings).toHaveLength(0);
  });

  it('refuses a release whose principal no longer covers the seller fee', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = {
      ...repository.transactionRecord,
      state: 'BUYER_INSPECTION',
      amountKobo: 5_000n,
      sellerFeeKobo: 5_000n,
    };
    const service = new EscrowService(repository);

    await expect(service.transition('tx-1', 'buyer-1', 'RELEASED'))
      .rejects.toBeInstanceOf(ValidationError);
    expect(repository.postings).toHaveLength(0);
  });

  it('rechecks the dispute under the engine transaction before auto-release', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = {
      ...repository.transactionRecord,
      state: 'BUYER_INSPECTION',
      autoReleaseAt: new Date(Date.now() - 1_000),
    };
    repository.hasOpen = true;
    const service = new EscrowService(repository);

    await expect(service.autoRelease('tx-1')).resolves.toBe(false);
    expect(repository.postings).toHaveLength(0);
    expect(repository.events).toHaveLength(0);
  });

  it('auto-releases an expired inspection through the same posting path', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = {
      ...repository.transactionRecord,
      state: 'BUYER_INSPECTION',
      autoReleaseAt: new Date(Date.now() - 1_000),
    };
    const service = new EscrowService(repository);

    await expect(service.autoRelease('tx-1')).resolves.toBe(true);
    expect(repository.postings).toHaveLength(1);
    expect(repository.events).toEqual(['RELEASED']);
    expect(repository.outbox).toContain('payout.requested');
  });

  it('posts the refund and seller remainder as one split resolution', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'UNDER_REVIEW' };
    repository.hasOpen = true;
    const service = new EscrowService(repository);

    const result = await service.resolveDispute(
      'tx-1', { accountId: 'admin-1', kind: 'admin' }, 'PARTIAL_REFUND', 'Refund the agreed portion', 100_000n,
    );

    expect(result.state).toBe('RELEASED');
    expect(repository.postings).toHaveLength(2);
    expect(repository.events).toEqual(['PARTIALLY_REFUNDED', 'RELEASED']);
    expect(repository.disputeResolution).toBe('RESOLVED_PARTIAL');
    expect(repository.auditActions).toEqual(['dispute.resolve']);
  });

  it('allows only the transaction seller to add a response to an open dispute', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'DISPUTED' };
    repository.hasOpen = true;
    const service = new EscrowService(repository);

    await expect(service.respondToDispute('tx-1', { accountId: 'seller-1', kind: 'seller' }, 'Here is my response with the requested evidence.'))
      .resolves.toEqual({ transaction_id: 'tx-1', response_added: true });
    await expect(service.respondToDispute('tx-1', { accountId: 'buyer-1', kind: 'buyer' }, 'Here is my response with the requested evidence.'))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(repository.disputeResponseCount).toBe(1);
  });

  it('refuses a refund the posted escrow balance cannot cover', async () => {
    // The cached figure still says the full amount is held, but the ledger
    // holds nothing. Trusting the cache would post a refund into a negative
    // escrow_cash balance.
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'UNDER_REVIEW' };
    repository.postedEscrowCash = 0n;
    repository.hasOpen = true;
    const service = new EscrowService(repository);

    await expect(service.resolveDispute(
      'tx-1', { accountId: 'admin-1', kind: 'admin' }, 'REFUND', 'Refund the buyer in full',
    )).rejects.toBeInstanceOf(ValidationError);
    expect(repository.postings).toHaveLength(0);
  });

  it('refuses a release the posted escrow balance cannot cover', async () => {
    const repository = new MemoryEscrowRepository();
    repository.postedEscrowCash = 1n;
    const service = new EscrowService(repository);

    await expect(service.transition('tx-1', 'buyer-1', 'RELEASED'))
      .rejects.toBeInstanceOf(ValidationError);
    expect(repository.postings).toHaveLength(0);
  });

  it('allows a release the posted balance fully covers', async () => {
    const repository = new MemoryEscrowRepository();
    repository.postedEscrowCash = 500_000n;
    const service = new EscrowService(repository);

    await expect(service.transition('tx-1', 'buyer-1', 'RELEASED')).resolves.toMatchObject({ state: 'RELEASED' });
    expect(repository.postings).toHaveLength(1);
  });

  it('allows a refund that leaves a smaller balance still held', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'UNDER_REVIEW' };
    repository.hasOpen = true;
    repository.postedEscrowCash = 500_000n;
    const service = new EscrowService(repository);

    const result = await service.resolveDispute(
      'tx-1', { accountId: 'admin-1', kind: 'admin' }, 'PARTIAL_REFUND', 'Refund the agreed portion', 100_000n,
    );

    expect(result.state).toBe('RELEASED');
    expect(repository.postings).toHaveLength(2);
  });

  it('moves a disputed transaction into review so resolution is reachable', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'DISPUTED' };
    repository.hasOpen = true;
    const service = new EscrowService(repository);

    const result = await service.beginDisputeReview('tx-1', { accountId: 'admin-1', kind: 'admin' });

    expect(result.state).toBe('UNDER_REVIEW');
    expect(repository.updates.at(-1)?.state).toBe('UNDER_REVIEW');
    expect(repository.events).toEqual(['UNDER_REVIEW']);
    // UNDER_REVIEW holds funds and posts nothing.
    expect(repository.postings).toHaveLength(0);
  });

  it('refuses to start a review that is not an admin action', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'DISPUTED' };
    repository.hasOpen = true;
    const service = new EscrowService(repository);

    await expect(service.beginDisputeReview('tx-1', { accountId: 'buyer-1', kind: 'buyer' }))
      .rejects.toBeInstanceOf(AuthorizationError);
  });

  it('is idempotent when a dispute is already under review', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'UNDER_REVIEW' };
    repository.hasOpen = true;
    const service = new EscrowService(repository);

    await expect(service.beginDisputeReview('tx-1', { accountId: 'admin-1', kind: 'admin' }))
      .resolves.toEqual({ transaction_id: 'tx-1', state: 'UNDER_REVIEW' });
    expect(repository.updates).toHaveLength(0);
  });

  it('refuses to review a transaction that is not disputed', async () => {
    const repository = new MemoryEscrowRepository();
    const service = new EscrowService(repository);

    await expect(service.beginDisputeReview('tx-1', { accountId: 'admin-1', kind: 'admin' }))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('reports a second dispute on the same transaction as a conflict', async () => {
    const repository = new MemoryEscrowRepository();
    repository.transactionRecord = { ...repository.transactionRecord, state: 'DELIVERED' };
    repository.hasOpen = true;
    const service = new EscrowService(repository);

    await expect(service.openDispute('tx-1', { accountId: 'buyer-1', kind: 'buyer' }, 'ITEM_DAMAGED', 'The item arrived damaged on arrival.'))
      .rejects.toBeInstanceOf(ConflictError);
  });
});