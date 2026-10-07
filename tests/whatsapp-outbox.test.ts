import { afterEach, describe, expect, it, vi } from 'vitest';

async function createWorker(lastInbound: Date | null, optedOut: Date | null) {
  vi.resetModules();
  vi.stubEnv('META_WHATSAPP_TOKEN', 'test-access-token');
  vi.stubEnv('META_WHATSAPP_PHONE_NUMBER_ID', 'test-phone-id');
  const [{ OutboxWorker }, { WhatsAppCloudAdapter }] = await Promise.all([
    import('../src/services/outbox-worker.js'),
    import('../src/adapters/notifications.js'),
  ]);
  const pool = {
    query: vi.fn().mockResolvedValue({
      rows: [{
        id: 'account-1',
        whatsapp_opted_out_at: optedOut,
        last_whatsapp_inbound_at: lastInbound,
      }],
      rowCount: 1,
    }),
  };
  const text = vi.spyOn(WhatsAppCloudAdapter.prototype, 'sendText').mockResolvedValue(undefined);
  const template = vi.spyOn(WhatsAppCloudAdapter.prototype, 'sendTemplate').mockResolvedValue(undefined);
  const worker = new OutboxWorker(pool as never);
  const deliver = (worker as unknown as {
    deliver(event: {
      id: string;
      topic: string;
      transaction_id: string | null;
      payload: Record<string, unknown>;
      attempts: number;
    }): Promise<void>;
  }).deliver.bind(worker);
  return { deliver, pool, text, template };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('WhatsApp outbox delivery', () => {
  const event = (allowOptOutConfirmation = false) => ({
    id: '1',
    topic: 'whatsapp.reply',
    transaction_id: null,
    payload: {
      phone: '2348000000000',
      text: 'A reply',
      account_id: 'account-1',
      allow_opt_out_confirmation: allowOptOutConfirmation,
    },
    attempts: 1,
  });

  it('does not send to an opted-out account', async () => {
    const worker = await createWorker(null, new Date());

    await worker.deliver(event());

    expect(worker.text).not.toHaveBeenCalled();
    expect(worker.template).not.toHaveBeenCalled();
  });

  it('uses free-form text inside the recorded 24-hour window', async () => {
    const worker = await createWorker(new Date(), null);

    await worker.deliver(event());

    expect(worker.text).toHaveBeenCalledWith('2348000000000', 'A reply');
    expect(worker.template).not.toHaveBeenCalled();
  });

  it('uses the registered opt-out confirmation template outside the window', async () => {
    const worker = await createWorker(null, new Date());

    await worker.deliver(event(true));

    expect(worker.text).not.toHaveBeenCalled();
    expect(worker.template).toHaveBeenCalledWith('2348000000000', {
      name: 'verispon_opt_out_confirmation',
      language: 'en',
      parameters: [],
    });
  });
});
