import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { checkoutAvailability } from '../domain/checkout.js';
import { TERMINAL_STATES, type TransactionState } from '../domain/escrow.js';
import type { IdempotencyContext } from '../db/idempotency.js';
import type { Account } from '../repositories/account-repository.js';
import {
  AuthorizationError,
  ConflictError,
  ResourceNotFoundError,
  ValidationError,
  type EscrowService,
} from './escrow-service.js';
import { RateLimitError, type AuthService } from './auth-service.js';
import type { PostgresTransactionRepository, TransactionListItem } from '../repositories/transaction-repository.js';
import {
  isTransactionState,
  type WhatsAppReplyData,
  type WhatsAppTransactionView,
  WhatsAppReplyService,
} from './whatsapp-reply-service.js';
import { IdempotencyConflictError } from '../db/idempotency.js';

export type WhatsAppIntent =
  | { type: 'help' }
  | { type: 'list' }
  | { type: 'status' | 'fee' | 'link'; reference: string }
  | { type: 'confirm'; reference: string }
  | { type: 'dispute'; reference: string; reason: string; summary: string }
  | { type: 'start' | 'stop' }
  | { type: 'unknown' };

export interface WhatsAppInboundMessage {
  id: string;
  from: string;
  type?: string;
  timestamp?: string;
  text?: string;
  caption?: string;
  interactiveId?: string;
  location?: { latitude: number; longitude: number };
}

const REFERENCE = 'VSP-\\d{6}';
const interactiveCommands = new Map<string, WhatsAppIntent>([
  ['HELP', { type: 'help' }],
  ['LIST', { type: 'list' }],
]);

export function parseWhatsAppIntent(text: string): WhatsAppIntent {
  const normalized = text.trim();
  const command = normalized.toUpperCase();
  if (command === 'HELP') return { type: 'help' };
  if (command === 'LIST') return { type: 'list' };
  if (command === 'START') return { type: 'start' };
  if (command === 'STOP' || command === 'UNSUBSCRIBE') return { type: 'stop' };

  const simple = new RegExp(`^(STATUS|FEE|LINK|CONFIRM)\\s+(${REFERENCE})$`, 'i').exec(normalized);
  if (simple) {
    const type = simple[1]!.toLowerCase() as 'status' | 'fee' | 'link' | 'confirm';
    return { type, reference: simple[2]!.toUpperCase() } as WhatsAppIntent;
  }

  const dispute = new RegExp(`^DISPUTE\\s+(${REFERENCE})\\s+([A-Z_]+)\\s*\\|\\s*([\\s\\S]{20,2000})$`, 'i').exec(normalized);
  if (dispute) {
    return {
      type: 'dispute',
      reference: dispute[1]!.toUpperCase(),
      reason: dispute[2]!.toUpperCase(),
      summary: dispute[3]!.trim(),
    };
  }
  return { type: 'unknown' };
}

function readTransaction(value: Record<string, unknown>): WhatsAppTransactionView {
  const checkoutValue = value.checkout;
  const checkout = checkoutValue && typeof checkoutValue === 'object'
    ? checkoutValue as Record<string, unknown>
    : null;
  const role = value.role;
  if (
    typeof value.id !== 'string'
    || typeof value.reference !== 'string'
    || typeof value.title !== 'string'
    || !isTransactionState(value.state)
    || (role !== 'buyer' && role !== 'seller')
    || typeof value.amount_kobo !== 'number'
    || !Number.isSafeInteger(value.amount_kobo)
    || typeof value.photos_enabled !== 'boolean'
  ) {
    throw new Error('Transaction API returned an invalid detail response');
  }
  const actionsValue = Array.isArray(value.actions) ? value.actions : [];
  const fees = value.fees && typeof value.fees === 'object'
    ? value.fees as Record<string, unknown>
    : {};
  const checkoutUrl = typeof checkout?.url === 'string' ? checkout.url : null;
  const validCheckoutUrl = checkoutUrl && /^\/checkout\/[0-9a-f]{32}$/.test(checkoutUrl)
    ? checkoutUrl
    : null;
  return {
    id: value.id,
    reference: value.reference,
    title: value.title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60),
    state: value.state,
    role,
    amount_kobo: value.amount_kobo,
    photos_enabled: value.photos_enabled,
    fees,
    checkout: checkout
      && validCheckoutUrl
      ? {
          url: validCheckoutUrl,
          expires_at: typeof checkout.expires_at === 'string' ? checkout.expires_at : null,
        }
      : null,
    actions: actionsValue.flatMap((action) => {
      if (!action || typeof action !== 'object') return [];
      const candidate = action as Record<string, unknown>;
      return typeof candidate.to === 'string' && typeof candidate.label === 'string'
        ? [{ to: candidate.to, label: candidate.label }]
        : [];
    }),
  };
}

function openTransactions(items: TransactionListItem[]): TransactionListItem[] {
  return items.filter((item) => !TERMINAL_STATES.has(item.state));
}

export class WhatsAppCommandService {
  private readonly replies = new WhatsAppReplyService();
  private readonly limitedSenders = new Map<string, number>();

  constructor(
    private readonly auth: Pick<AuthService, 'accountByPhone' | 'setWhatsAppPreference'>
      & Partial<Pick<AuthService, 'recordWhatsAppInbound'>>
      & Partial<Pick<AuthService, 'enforceWhatsAppRateLimit'>>,
    private readonly transactions: Pick<PostgresTransactionRepository, 'list' | 'detail' | 'findIdByReferenceForParty'>,
    private readonly escrow: Pick<EscrowService, 'transition' | 'openDispute'>,
    private readonly enqueue: (
      phone: string,
      text: string,
      accountId?: string,
      allowOptOutConfirmation?: boolean,
      serviceWindowExpiresAt?: string,
    ) => Promise<void>,
  ) {}

  async handle(message: WhatsAppInboundMessage): Promise<void> {
    const receivedAt = this.receivedAt(message.timestamp);
    const serviceWindowExpiresAt = new Date(receivedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const intent: WhatsAppIntent = message.interactiveId
      ? parseInteractiveCommand(message.interactiveId) ?? { type: 'unknown' }
      : message.type === undefined || message.type === 'text'
        ? parseWhatsAppIntent(message.text ?? '')
        : { type: 'unknown' };
    const now = Date.now();
    if (
      intent.type !== 'start'
      && intent.type !== 'stop'
      && (this.limitedSenders.get(message.from) ?? 0) > now
    ) return;
    const account = await this.auth.accountByPhone(message.from);

    if (account && intent.type === 'stop') {
      await this.auth.setWhatsAppPreference(account.id, false);
      await this.auth.recordWhatsAppInbound?.(account.id, receivedAt);
      await this.enqueueReply(
        message.from,
        { kind: 'notice', notice: 'stopped' },
        account.id,
        true,
        serviceWindowExpiresAt,
      );
      return;
    }
    if (account && intent.type === 'start') {
      await this.auth.setWhatsAppPreference(account.id, true);
      await this.auth.recordWhatsAppInbound?.(account.id, receivedAt);
      await this.enqueueReply(message.from, { kind: 'notice', notice: 'started' }, account.id, false, serviceWindowExpiresAt);
      return;
    }
    if (account) {
      await this.auth.recordWhatsAppInbound?.(account.id, receivedAt);
      if (account.whatsappOptedOutAt) return;
    }
    try {
      await this.auth.enforceWhatsAppRateLimit?.(message.from);
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      this.limitedSenders.set(message.from, now + 15 * 60_000);
      if (this.limitedSenders.size > 10_000) {
        for (const [sender, expiry] of this.limitedSenders) {
          if (expiry <= now) this.limitedSenders.delete(sender);
        }
        if (this.limitedSenders.size > 10_000) {
          const oldest = this.limitedSenders.keys().next().value;
          if (oldest) this.limitedSenders.delete(oldest);
        }
      }
      await this.enqueueReply(
        message.from,
        { kind: 'notice', notice: 'rate_limited' },
        account?.id,
        false,
        serviceWindowExpiresAt,
      );
      return;
    }
    if (!account) {
      await this.enqueueReply(message.from, { kind: 'notice', notice: 'unlinked' }, undefined, false, serviceWindowExpiresAt);
      return;
    }

    if (message.location) {
      await this.enqueueReply(message.from, { kind: 'location', ...message.location }, account.id, false, serviceWindowExpiresAt);
      return;
    }
    if (message.type === 'image' || message.type === 'document' || message.type === 'audio' || message.type === 'video') {
      const reply = await this.mediaReply(account, message.caption);
      await this.enqueueReply(message.from, reply, account.id, false, serviceWindowExpiresAt);
      return;
    }
    if (message.interactiveId) {
      if (intent.type === 'unknown') {
        await this.enqueueReply(message.from, { kind: 'notice', notice: 'unknown' }, account.id, false, serviceWindowExpiresAt);
        return;
      }
    } else if (message.type !== undefined && message.type !== 'text') {
      await this.enqueueReply(message.from, { kind: 'notice', notice: 'unsupported' }, account.id, false, serviceWindowExpiresAt);
      return;
    }

    const text = message.text?.trim() ?? message.interactiveId ?? '';
    const idempotency = (endpoint: string): IdempotencyContext => ({
      key: message.id,
      accountId: account.id,
      endpoint: `whatsapp.${endpoint}`,
      requestHash: createHash('sha256').update(text).digest('hex'),
    });

    try {
      const result = await this.dispatch(intent, account, idempotency);
      await this.enqueueReply(message.from, result, account.id, false, serviceWindowExpiresAt);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return;
      if (error instanceof ResourceNotFoundError) {
        await this.enqueueReply(message.from, { kind: 'error', text: 'That transaction could not be found for your account.' }, account.id, false, serviceWindowExpiresAt);
        return;
      }
      if (error instanceof AuthorizationError) {
        await this.enqueueReply(message.from, { kind: 'error', text: error.message }, account.id, false, serviceWindowExpiresAt);
        return;
      }
      if (error instanceof ValidationError || error instanceof ConflictError) {
        await this.enqueueReply(message.from, { kind: 'error', text: error.message }, account.id, false, serviceWindowExpiresAt);
        return;
      }
      throw error;
    }
  }

  private async enqueueReply(
    phone: string,
    reply: WhatsAppReplyData,
    accountId?: string,
    allowOptOutConfirmation = false,
    serviceWindowExpiresAt?: string,
  ): Promise<void> {
    await this.enqueue(
      phone,
      this.replies.render(reply),
      accountId,
      allowOptOutConfirmation,
      serviceWindowExpiresAt,
    );
  }

  private receivedAt(timestamp?: string): Date {
    if (!timestamp || !/^\d+$/.test(timestamp)) return new Date();
    const seconds = Number(timestamp);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return new Date();
    const receivedAt = new Date(seconds * 1000);
    return receivedAt.getTime() > Date.now() ? new Date() : receivedAt;
  }

  private async mediaReply(account: Account, caption?: string): Promise<WhatsAppReplyData> {
    const match = caption ? new RegExp(REFERENCE, 'i').exec(caption) : null;
    if (!match) {
      return { kind: 'media' };
    }
    const transactionId = await this.transactions.findIdByReferenceForParty(match[0]!.toUpperCase(), account.id);
    if (!transactionId) return { kind: 'error', text: 'That transaction could not be found for your account.' };
    const rawDetail = await this.transactions.detail(account.id, transactionId);
    if (!rawDetail) return { kind: 'error', text: 'That transaction could not be found for your account.' };
    const transaction = readTransaction(rawDetail);
    const evidenceType = transaction.photos_enabled
      && (transaction.state === 'CREATED' || transaction.state === 'AWAITING_BUYER_VERIFICATION')
      ? 'ITEM_BEFORE_TRANSACTION'
      : transaction.state === 'BUYER_INSPECTION'
        ? 'ITEM_RECEIVED'
        : null;
    return {
      kind: 'media',
      reference: transaction.reference,
      ...(evidenceType ? { evidenceType } : {}),
    };
  }

  private async dispatch(
    intent: WhatsAppIntent,
    account: Account,
    idempotency: (endpoint: string) => IdempotencyContext,
  ): Promise<WhatsAppReplyData> {
    if (intent.type === 'unknown') {
      return { kind: 'notice', notice: 'unknown' };
    }
    if (intent.type === 'stop' || intent.type === 'start') {
      return { kind: 'notice', notice: 'unknown' };
    }
    if (intent.type === 'help') {
      const result = await this.transactions.list(account.id, { states: [], limit: 100, offset: 0 });
      const open = openTransactions(result.transactions).map((transaction) => transaction.reference).slice(0, 5);
      return { kind: 'help', openReferences: open };
    }
    if (intent.type === 'list') {
      const result = await this.transactions.list(account.id, { states: [], limit: 100, offset: 0 });
      const items = openTransactions(result.transactions).slice(0, 2);
      const views = await Promise.all(items.map(async (item) => {
        const detail = await this.transactions.detail(account.id, item.id);
        if (!detail) return null;
        return readTransaction(detail);
      }));
      return { kind: 'list', transactions: views.filter((item): item is WhatsAppTransactionView => item !== null) };
    }
    if (!('reference' in intent)) {
      return { kind: 'notice', notice: 'unknown' };
    }

    const transactionId = await this.transactions.findIdByReferenceForParty(intent.reference, account.id);
    if (!transactionId) throw new ResourceNotFoundError();
    if (intent.type === 'confirm') {
      const transition = await this.escrow.transition(
        transactionId,
        account.id,
        'RELEASED',
        'Confirmed through WhatsApp',
        idempotency('confirm'),
      );
      const detail = await this.transactions.detail(account.id, transition.transaction_id);
      if (!detail) throw new ResourceNotFoundError();
      const transaction = readTransaction(detail);
      return { kind: 'transition', reference: transaction.reference, state: transaction.state };
    }
    if (intent.type === 'dispute') {
      await this.escrow.openDispute(
        transactionId,
        { accountId: account.id, kind: 'buyer' },
        intent.reason,
        intent.summary,
        idempotency('dispute'),
      );
      const detail = await this.transactions.detail(account.id, transactionId);
      if (!detail) throw new ResourceNotFoundError();
      const transaction = readTransaction(detail);
      return { kind: 'transition', reference: transaction.reference, state: transaction.state };
    }

    const rawDetail = await this.transactions.detail(account.id, transactionId);
    if (!rawDetail) throw new ResourceNotFoundError();
    const transaction = readTransaction(rawDetail);
    if (intent.type === 'status') return { kind: 'status', transaction };
    if (intent.type === 'fee') {
      const ownFee = transaction.role === 'buyer'
        ? transaction.fees.buyer_fee_kobo
        : transaction.fees.seller_fee_kobo;
      if (typeof ownFee !== 'number' || !Number.isSafeInteger(ownFee)) {
        throw new Error('Transaction API omitted the caller fee');
      }
      return { kind: 'fee', transaction, amountKobo: ownFee };
    }
    if (intent.type === 'link') {
      const availability = checkoutAvailability(
        transaction.checkout?.url && transaction.checkout.expires_at
          ? {
              token: transaction.checkout.url.split('/').at(-1) ?? '',
              expiresAt: transaction.checkout.expires_at,
            }
          : null,
        transaction.state,
      );
      const url = transaction.checkout?.url
        ? new URL(transaction.checkout.url, config.API_ORIGIN ?? config.WEB_ORIGIN).toString()
        : '';
      return { kind: 'link', transaction, availability, url };
    }
    return { kind: 'notice', notice: 'unknown' };
  }
}

export function parseInteractiveCommand(id: string): WhatsAppIntent | null {
  const intent = interactiveCommands.get(id);
  return intent ?? null;
}
