import { describe, expect, it, vi } from 'vitest';
import { parseWhatsAppIntent, WhatsAppCommandService } from '../src/services/whatsapp-command-service.js';
import { WhatsAppReplyService, formatNaira, stateGuidance } from '../src/services/whatsapp-reply-service.js';
import { TRANSACTION_STATES } from '../src/domain/escrow.js';
import type { Account } from '../src/repositories/account-repository.js';
import { AuthorizationError } from '../src/services/escrow-service.js';
import { RateLimitError } from '../src/services/auth-service.js';
import { IdempotencyConflictError } from '../src/db/idempotency.js';

const account: Account = {
  id: 'account-1',
  reference: 'VSP-123456',
  name: 'Buyer',
  email: 'buyer@example.com',
  phone: '2348000000000',
  passcodeHash: 'hash',
  roles: ['BUYER'],
  capabilities: [],
  emailVerifiedAt: null,
  phoneVerifiedAt: new Date(),
  frozenAt: null,
  whatsappConsentAt: new Date(),
  whatsappOptedOutAt: null,
};

describe('parseWhatsAppIntent', () => {
  it.each([
    ['HELP', { type: 'help' }],
    ['help', { type: 'help' }],
    ['LIST', { type: 'list' }],
    ['status vsp-123456', { type: 'status', reference: 'VSP-123456' }],
    ['FEE VSP-123456', { type: 'fee', reference: 'VSP-123456' }],
    ['LINK VSP-123456', { type: 'link', reference: 'VSP-123456' }],
    ['CONFIRM VSP-123456', { type: 'confirm', reference: 'VSP-123456' }],
    ['DISPUTE VSP-123456 ITEM_DAMAGED | The item arrived damaged and cannot be used.', {
      type: 'dispute',
      reference: 'VSP-123456',
      reason: 'ITEM_DAMAGED',
      summary: 'The item arrived damaged and cannot be used.',
    }],
    ['CONFIRM VSP-12345', { type: 'unknown' }],
    ['show VSP-123456 status?', { type: 'unknown' }],
  ] as const)('parses %s without guessing', (input, expected) => {
    expect(parseWhatsAppIntent(input)).toEqual(expected);
  });
});

describe('WhatsApp state replies', () => {
  it('has explicit next-step wording for every engine state', () => {
    for (const state of TRANSACTION_STATES) {
      expect(stateGuidance(state).trim().length).toBeGreaterThan(0);
    }
  });

  it('formats kobo as naira without leaking kobo', () => {
    expect(formatNaira(4_500_000)).toBe('₦45,000');
    expect(formatNaira('4500050')).toBe('₦45,000.50');
  });

  it('does not send an expired checkout URL', () => {
    const reply = new WhatsAppReplyService().render({
      kind: 'link',
      transaction: {
        id: 'transaction-1',
        reference: 'VSP-123456',
        title: 'Phone',
        state: 'AWAITING_PAYMENT',
        role: 'buyer',
        amount_kobo: 4_500_000,
        photos_enabled: false,
        fees: {},
        checkout: {
          url: '/checkout/0123456789abcdef0123456789abcdef',
          expires_at: '2020-01-01T00:00:00.000Z',
        },
        actions: [],
      },
      availability: 'expired',
      url: 'https://api.verispon.example/checkout/0123456789abcdef0123456789abcdef',
    });

    expect(reply).toContain('ask the seller for a new one');
    expect(reply).not.toContain('/checkout/');
  });
});

describe('WhatsAppCommandService', () => {
  it('makes no transaction calls or reply for an opted-out account', async () => {
    const auth = {
      accountByPhone: vi.fn().mockResolvedValue({ ...account, whatsappOptedOutAt: new Date() }),
      setWhatsAppPreference: vi.fn(),
    };
    const transactions = {
      list: vi.fn(),
      detail: vi.fn(),
      findIdByReferenceForParty: vi.fn(),
    };
    const escrow = {
      transition: vi.fn(),
      openDispute: vi.fn(),
    };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppCommandService(auth, transactions, escrow, enqueue);

    await service.handle({ id: 'wamid.1', from: '2348000000000', text: 'LIST' });

    expect(transactions.list).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rate-limits senders and lets STOP bypass the message limit', async () => {
    const auth = {
      accountByPhone: vi.fn().mockResolvedValue(account),
      setWhatsAppPreference: vi.fn(),
      enforceWhatsAppRateLimit: vi.fn().mockRejectedValue(new RateLimitError()),
    };
    const transactions = { list: vi.fn(), detail: vi.fn(), findIdByReferenceForParty: vi.fn() };
    const escrow = { transition: vi.fn(), openDispute: vi.fn() };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppCommandService(auth, transactions, escrow, enqueue);

    await service.handle({ id: 'wamid.limit1', from: '2348000000000', text: 'LIST' });
    await service.handle({ id: 'wamid.limit2', from: '2348000000000', text: 'LIST' });
    expect(auth.enforceWhatsAppRateLimit).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);

    await service.handle({ id: 'wamid.stop', from: '2348000000000', text: 'STOP' });
    expect(auth.setWhatsAppPreference).toHaveBeenCalledWith(account.id, false);
    expect(auth.enforceWhatsAppRateLimit).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('passes an engine refusal through unchanged', async () => {
    const auth = {
      accountByPhone: vi.fn().mockResolvedValue(account),
      setWhatsAppPreference: vi.fn(),
    };
    const transactions = {
      list: vi.fn(),
      detail: vi.fn(),
      findIdByReferenceForParty: vi.fn().mockResolvedValue('transaction-1'),
    };
    const escrow = {
      transition: vi.fn(),
      openDispute: vi.fn(),
    };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppCommandService(auth, transactions, escrow, enqueue);
    escrow.transition.mockRejectedValue(new AuthorizationError());

    await service.handle({
      id: 'wamid.2',
      from: '2348000000000',
      text: 'CONFIRM VSP-123456',
    });
    expect(enqueue).toHaveBeenCalledWith(
      '2348000000000',
      'Action is not permitted',
      account.id,
      false,
      expect.any(String),
    );
  });

  it('uses only the engine-approved RELEASED transition for receipt confirmation', async () => {
    const auth = {
      accountByPhone: vi.fn().mockResolvedValue(account),
      setWhatsAppPreference: vi.fn(),
    };
    const transactions = {
      list: vi.fn(),
      findIdByReferenceForParty: vi.fn().mockResolvedValue('transaction-1'),
      detail: vi.fn().mockResolvedValue({
        id: 'transaction-1',
        reference: 'VSP-123456',
        title: 'Phone',
        state: 'RELEASED',
        role: 'buyer',
        amount_kobo: 4_500_000,
        photos_enabled: false,
        fees: {},
        checkout: null,
        actions: [],
      }),
    };
    const escrow = {
      transition: vi.fn().mockResolvedValue({ transaction_id: 'transaction-1', state: 'RELEASED' }),
      openDispute: vi.fn(),
    };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppCommandService(auth, transactions, escrow, enqueue);

    await service.handle({ id: 'wamid.confirm', from: '2348000000000', text: 'CONFIRM VSP-123456' });

    expect(escrow.transition).toHaveBeenCalledWith(
      'transaction-1',
      account.id,
      'RELEASED',
      'Confirmed through WhatsApp',
      expect.objectContaining({ key: 'wamid.confirm', endpoint: 'whatsapp.confirm' }),
    );
    expect(transactions.detail.mock.invocationCallOrder[0]).toBeGreaterThan(
      escrow.transition.mock.invocationCallOrder[0]!,
    );
    expect(enqueue.mock.calls[0]?.[1]).toContain('VSP-123456 is now released.');
  });

  it('marks an idempotent replay as settled without sending a second reply', async () => {
    const auth = {
      accountByPhone: vi.fn().mockResolvedValue(account),
      setWhatsAppPreference: vi.fn(),
    };
    const transactions = {
      list: vi.fn(),
      findIdByReferenceForParty: vi.fn().mockResolvedValue('transaction-1'),
      detail: vi.fn(),
    };
    const escrow = {
      transition: vi.fn(),
      openDispute: vi.fn(),
    };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppCommandService(auth, transactions, escrow, enqueue);
    escrow.transition.mockRejectedValue(new IdempotencyConflictError());

    await service.handle({ id: 'wamid.replay', from: '2348000000000', text: 'CONFIRM VSP-123456' });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns the buyer fee only for a buyer', async () => {
    const auth = {
      accountByPhone: vi.fn().mockResolvedValue(account),
      setWhatsAppPreference: vi.fn(),
    };
    const transactions = {
      list: vi.fn(),
      findIdByReferenceForParty: vi.fn().mockResolvedValue('transaction-1'),
      detail: vi.fn().mockResolvedValue({
        id: 'transaction-1',
        reference: 'VSP-123456',
        title: 'Phone',
        state: 'AWAITING_PAYMENT',
        role: 'buyer',
        amount_kobo: 4_500_000,
        photos_enabled: false,
        fees: { buyer_fee_kobo: 90_000, buyer_total_kobo: 4_590_000 },
        checkout: null,
        actions: [],
      }),
    };
    const escrow = { transition: vi.fn(), openDispute: vi.fn() };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppCommandService(auth, transactions, escrow, enqueue);

    await service.handle({ id: 'wamid.fee', from: '2348000000000', text: 'FEE VSP-123456' });

    expect(enqueue).toHaveBeenCalledWith(
      '2348000000000',
      expect.stringContaining('₦900'),
      account.id,
      false,
      expect.any(String),
    );
    expect(enqueue.mock.calls[0]?.[1]).not.toContain('₦10,000');
  });

  it('resolves checkout links only for party-scoped records and includes the token path', async () => {
    const auth = {
      accountByPhone: vi.fn().mockResolvedValue(account),
      setWhatsAppPreference: vi.fn(),
    };
    const transactions = {
      list: vi.fn(),
      findIdByReferenceForParty: vi.fn().mockResolvedValue('transaction-1'),
      detail: vi.fn().mockResolvedValue({
        id: 'transaction-1',
        reference: 'VSP-123456',
        title: 'Phone',
        state: 'AWAITING_PAYMENT',
        role: 'buyer',
        amount_kobo: 4_500_000,
        photos_enabled: false,
        fees: { buyer_fee_kobo: 90_000 },
        checkout: {
          url: '/checkout/0123456789abcdef0123456789abcdef',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        actions: [],
      }),
    };
    const escrow = { transition: vi.fn(), openDispute: vi.fn() };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppCommandService(auth, transactions, escrow, enqueue);

    await service.handle({ id: 'wamid.link', from: '2348000000000', text: 'LINK VSP-123456' });

    expect(enqueue.mock.calls[0]?.[1]).toContain('/checkout/0123456789abcdef0123456789abcdef');
    expect(transactions.findIdByReferenceForParty).toHaveBeenCalledWith('VSP-123456', account.id);
  });

  it('uses the same not-found reply for absent and non-party transactions', async () => {
    const auth = {
      accountByPhone: vi.fn().mockResolvedValue(account),
      setWhatsAppPreference: vi.fn(),
    };
    const transactions = {
      list: vi.fn(),
      findIdByReferenceForParty: vi.fn().mockResolvedValue(null),
      detail: vi.fn(),
    };
    const escrow = { transition: vi.fn(), openDispute: vi.fn() };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppCommandService(auth, transactions, escrow, enqueue);

    await service.handle({ id: 'wamid.missing', from: '2348000000000', text: 'STATUS VSP-123456' });

    expect(enqueue).toHaveBeenCalledWith(
      '2348000000000',
      'That transaction could not be found for your account.',
      account.id,
      false,
      expect.any(String),
    );
  });
});
