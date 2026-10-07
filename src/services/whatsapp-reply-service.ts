import { TRANSACTION_STATES, type TransactionState } from '../domain/escrow.js';

export interface WhatsAppTransactionView {
  id: string;
  reference: string;
  title: string;
  state: TransactionState;
  role: 'buyer' | 'seller';
  amount_kobo: number;
  photos_enabled: boolean;
  fees: Record<string, unknown>;
  checkout: {
    url: string;
    expires_at: string | null;
  } | null;
  actions: Array<{ to: string; label: string }>;
}

const stateCopy = {
  CREATED: {
    label: 'created',
    next: 'The seller should verify the buyer.',
  },
  AWAITING_BUYER_VERIFICATION: {
    label: 'waiting for buyer verification',
    next: 'The buyer should complete verification.',
  },
  AWAITING_PAYMENT: {
    label: 'waiting for payment',
    next: 'The buyer should pay using the checkout link.',
  },
  FUNDED: {
    label: 'funded',
    next: 'The seller should prepare the item.',
  },
  SELLER_PROCESSING: {
    label: 'being prepared by the seller',
    next: 'The seller should ship or update delivery.',
  },
  SHIPPED: {
    label: 'shipped',
    next: 'The delivery should continue; check tracking in the dashboard.',
  },
  DELIVERED: {
    label: 'delivered',
    next: 'The buyer should inspect the item.',
  },
  BUYER_INSPECTION: {
    label: 'waiting for buyer inspection',
    next: 'The buyer should confirm receipt or raise a dispute.',
  },
  RELEASED: {
    label: 'released',
    next: 'The payout process is underway.',
  },
  COMPLETED: {
    label: 'completed',
    next: 'No further action is needed.',
  },
  CANCELLED: {
    label: 'cancelled',
    next: 'No further transaction action is available.',
  },
  DELIVERY_FAILED: {
    label: 'delivery failed',
    next: 'The parties should arrange retry, return, or dispute in the dashboard.',
  },
  RETURN_IN_PROGRESS: {
    label: 'return in progress',
    next: 'The parties should complete the return and update the dashboard.',
  },
  DISPUTED: {
    label: 'disputed',
    next: 'The seller should respond; Verispon will review the case.',
  },
  UNDER_REVIEW: {
    label: 'under review',
    next: 'Verispon is reviewing the dispute.',
  },
  REFUNDED: {
    label: 'refunded',
    next: 'No further transaction action is needed.',
  },
  PARTIALLY_REFUNDED: {
    label: 'partially refunded',
    next: 'The remaining settlement is handled by Verispon.',
  },
} satisfies Record<TransactionState, { label: string; next: string }>;

export function formatNaira(amountKobo: number | string): string {
  const kobo = typeof amountKobo === 'number'
    ? BigInt(amountKobo)
    : BigInt(amountKobo);
  const negative = kobo < 0n;
  const absolute = negative ? -kobo : kobo;
  const naira = absolute / 100n;
  const remainder = absolute % 100n;
  const formattedNaira = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 }).format(naira);
  const fraction = remainder === 0n ? '' : `.${remainder.toString().padStart(2, '0')}`;
  return `${negative ? '-' : ''}₦${formattedNaira}${fraction}`;
}

export type WhatsAppReplyData =
  | { kind: 'notice'; notice: 'unknown' | 'unlinked' | 'unsupported' | 'rate_limited' | 'started' | 'stopped' }
  | { kind: 'error'; text: string }
  | { kind: 'location'; latitude: number; longitude: number }
  | { kind: 'media'; reference?: string; evidenceType?: string }
  | { kind: 'help'; openReferences: string[] }
  | { kind: 'list'; transactions: WhatsAppTransactionView[] }
  | { kind: 'status'; transaction: WhatsAppTransactionView }
  | { kind: 'fee'; transaction: WhatsAppTransactionView; amountKobo: number }
  | { kind: 'link'; transaction: WhatsAppTransactionView; availability: 'open' | 'expired' | 'paid' | 'closed'; url: string }
  | { kind: 'transition'; reference: string; state: TransactionState };

export class WhatsAppReplyService {
  render(data: WhatsAppReplyData): string {
    if (data.kind === 'notice') {
      const messages = {
        unknown: 'I did not understand. Reply HELP to see the available commands.',
        unlinked: 'This phone number is not linked to a verified Verispon account.',
        unsupported: 'I can help with text commands, photos, documents, audio, video, and location pins. Reply HELP for commands.',
        rate_limited: 'Too many messages. Please wait a little before trying again.',
        started: 'WhatsApp notifications are on for this account.',
        stopped: 'WhatsApp notifications are now turned off for this account.',
      } satisfies Record<Extract<WhatsAppReplyData, { kind: 'notice' }>['notice'], string>;
      return messages[data.notice];
    }
    if (data.kind === 'error') return data.text;
    if (data.kind === 'location') {
      return `I received location ${data.latitude.toFixed(5)}, ${data.longitude.toFixed(5)}. Nothing was saved; confirm it in the dashboard if needed.`;
    }
    if (data.kind === 'media') {
      if (!data.reference) {
        return 'WhatsApp cannot add this file as evidence yet. Open the transaction in your dashboard to upload it and see the expected evidence type.';
      }
      const expected = data.evidenceType
        ? `Expected evidence type: ${data.evidenceType}.`
        : 'Check the expected evidence type in the dashboard.';
      return `${data.reference}: WhatsApp has not uploaded this file.\n${expected} Use the dashboard to add it.`;
    }
    if (data.kind === 'help') {
      const open = data.openReferences.length
        ? `Open: ${data.openReferences.slice(0, 3).join(', ')}.`
        : 'You have no open transactions.';
      return `${open}\nSTATUS/LINK/FEE VSP-123456; LIST.\nCONFIRM VSP-123456; DISPUTE VSP-123456 REASON | details; START/STOP.`;
    }
    if (data.kind === 'list') {
      if (!data.transactions.length) return 'You have no open transactions.';
      const visible = data.transactions.slice(0, 2);
      const entries = visible.map((transaction) =>
        `${transaction.reference} · ${transaction.title} · ${formatNaira(transaction.amount_kobo)} · ${transaction.state.replaceAll('_', ' ').toLowerCase()}`,
      );
      return `Open transactions (showing up to 2):\n${entries.join('\n')}`;
    }
    if (data.kind === 'status') {
      const transaction = data.transaction;
      const state = stateCopy[transaction.state];
      const actions = transaction.actions.map((action) => action.label).slice(0, 2);
      const userAction = actions.length ? ` You can: ${actions.join(' or ')}.` : '';
      return `${transaction.reference}: ${formatNaira(transaction.amount_kobo)}, ${state.label} (${transaction.role}).\n${state.next}${userAction}`;
    }
    if (data.kind === 'fee') {
      return `${data.transaction.reference}: your fee is ${formatNaira(data.amountKobo)}.\nThis is your fee only; see the dashboard for the full breakdown.`;
    }
    if (data.kind === 'link') {
      if (data.availability === 'open') {
        return `${data.transaction.reference}: checkout is open until ${data.transaction.checkout?.expires_at ?? 'its expiry time'}.\n${data.url}`;
      }
      if (data.availability === 'expired') {
        return `${data.transaction.reference}: this checkout link has expired.\nask the seller for a new one.`;
      }
      if (data.availability === 'paid') {
        return `${data.transaction.reference}: this transaction is already paid.\n${stateCopy[data.transaction.state].next}`;
      }
      return `${data.transaction.reference}: checkout is no longer available.\nCheck the transaction status in your dashboard.`;
    }
    return `${data.reference} is now ${stateCopy[data.state].label}.\n${stateCopy[data.state].next}`;
  }
}

export function isTransactionState(value: unknown): value is TransactionState {
  return typeof value === 'string' && TRANSACTION_STATES.some((state) => state === value);
}

export function stateGuidance(state: TransactionState): string {
  return stateCopy[state].next;
}
