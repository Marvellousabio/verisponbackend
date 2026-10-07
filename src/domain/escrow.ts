export const TRANSACTION_STATES = [
  'CREATED', 'AWAITING_BUYER_VERIFICATION', 'AWAITING_PAYMENT', 'FUNDED',
  'SELLER_PROCESSING', 'SHIPPED', 'DELIVERED', 'BUYER_INSPECTION', 'RELEASED',
  'COMPLETED', 'CANCELLED', 'DELIVERY_FAILED', 'RETURN_IN_PROGRESS', 'DISPUTED',
  'UNDER_REVIEW', 'REFUNDED', 'PARTIALLY_REFUNDED',
] as const;

export type TransactionState = typeof TRANSACTION_STATES[number];
export type ActorKind = 'buyer' | 'seller' | 'system' | 'admin';

export const ENGINE_ONLY_STATES = new Set<TransactionState>([
  'FUNDED', 'DELIVERED', 'COMPLETED', 'UNDER_REVIEW', 'REFUNDED', 'PARTIALLY_REFUNDED',
  'RETURN_IN_PROGRESS',
]);

export const TERMINAL_STATES = new Set<TransactionState>([
  'COMPLETED', 'CANCELLED', 'REFUNDED',
]);

export const FUNDS_HELD_STATES = new Set<TransactionState>([
  'FUNDED', 'SELLER_PROCESSING', 'SHIPPED', 'DELIVERED', 'BUYER_INSPECTION',
  'DELIVERY_FAILED', 'RETURN_IN_PROGRESS', 'DISPUTED', 'UNDER_REVIEW',
]);

const transitions: Record<TransactionState, readonly TransactionState[]> = {
  CREATED: ['AWAITING_BUYER_VERIFICATION', 'CANCELLED'],
  AWAITING_BUYER_VERIFICATION: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['FUNDED', 'CANCELLED'],
  // Cancellation stops being a cancellation once money has arrived and becomes
  // a refund, which is why it is offered here and nowhere further along. Past
  // FUNDED the seller is holding the goods, so a buyer who backs out is
  // disputing, not cancelling.
  FUNDED: ['SELLER_PROCESSING', 'DELIVERY_FAILED', 'DISPUTED', 'CANCELLED'],
  SELLER_PROCESSING: ['SHIPPED', 'DELIVERY_FAILED', 'DISPUTED'],
  SHIPPED: ['DELIVERED', 'DELIVERY_FAILED', 'DISPUTED'],
  DELIVERED: ['BUYER_INSPECTION', 'DELIVERY_FAILED', 'DISPUTED'],
  BUYER_INSPECTION: ['RELEASED', 'DISPUTED'],
  RELEASED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  DELIVERY_FAILED: ['SELLER_PROCESSING', 'RETURN_IN_PROGRESS', 'DISPUTED'],
  RETURN_IN_PROGRESS: ['DELIVERY_FAILED', 'DISPUTED', 'REFUNDED'],
  DISPUTED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['RELEASED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  REFUNDED: [],
  PARTIALLY_REFUNDED: ['RELEASED'],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: TransactionState, readonly to: TransactionState) {
    super(`Cannot transition transaction from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class EngineOnlyTransitionError extends Error {
  constructor(readonly to: TransactionState) {
    super(`Transition to ${to} is reserved for the transaction engine`);
    this.name = 'EngineOnlyTransitionError';
  }
}

export function canTransition(from: TransactionState, to: TransactionState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: TransactionState, to: TransactionState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function assertClientTransition(to: TransactionState): void {
  if (ENGINE_ONLY_STATES.has(to)) {
    throw new EngineOnlyTransitionError(to);
  }
}

export function allowedTransitions(from: TransactionState): readonly TransactionState[] {
  return transitions[from];
}