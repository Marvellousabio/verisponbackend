import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const account = {
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

async function createHarness(duplicate = false, knownAccount = account, appSecret: string | null = 'test-meta-secret') {
  vi.resetModules();
  vi.stubEnv('META_APP_SECRET', appSecret ?? '');
  vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'test-verify-token');
  const [{ createWhatsAppRouter }, { config }] = await Promise.all([
    import('../src/routes/whatsapp-routes.js'),
    import('../src/config.js'),
  ]);

  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('insert into provider_webhook_events')) {
        return { rowCount: duplicate ? 0 : 1, rows: duplicate ? [] : [{ event_id: 'wamid.1' }] };
      }
      return { rowCount: 1, rows: [] };
    }),
  };
  const auth = {
    accountByPhone: vi.fn().mockResolvedValue(knownAccount),
    setWhatsAppPreference: vi.fn().mockResolvedValue(undefined),
    recordWhatsAppInbound: vi.fn().mockResolvedValue(undefined),
    enforceWhatsAppRateLimit: vi.fn().mockResolvedValue(undefined),
  };
  const transactions = {
    list: vi.fn().mockResolvedValue({ transactions: [], total: 0 }),
    detail: vi.fn(),
    findIdByReferenceForParty: vi.fn(),
  };
  const escrow = { transition: vi.fn(), openDispute: vi.fn() };
  const app = express();
  app.use(express.json({
    verify: (req, _res, body) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(body);
    },
  }));
  app.use('/api/whatsapp', createWhatsAppRouter(
    pool as never,
    auth as never,
    transactions as never,
    escrow as never,
  ));
  const sign = (body: string) => 'sha256=' + createHmac('sha256', config.META_APP_SECRET!)
    .update(body)
    .digest('hex');
  return { app, pool, auth, transactions, sign };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('WhatsApp webhook route', () => {
  it('verifies the signature against the exact raw request body', async () => {
    const harness = await createHarness();
    const body = '{ "entry": [{"changes":[{"value":{"messages":[{"id":"wamid.1","from":"2348000000000","type":"text","text":{"body":"HELP"}}]}}]}]}';
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('x-hub-signature-256', harness.sign(body))
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBe(200);
    expect(harness.auth.accountByPhone).toHaveBeenCalledWith('2348000000000');
    const replyQuery = harness.pool.query.mock.calls.find(([sql]) => sql.includes("values ('whatsapp.reply'"));
    expect(replyQuery?.[1]?.[0]).toContain('"text":"You have no open transactions.');
  });

  it('rejects a missing or invalid signature without database or API side effects', async () => {
    const harness = await createHarness();
    const body = JSON.stringify({ entry: [] });
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('x-hub-signature-256', 'sha256=bad')
      .send(body);

    expect(response.status).toBe(401);
    expect(harness.pool.query).not.toHaveBeenCalled();
    expect(harness.auth.accountByPhone).not.toHaveBeenCalled();
  });

  it('fails closed when the Meta app secret is missing', async () => {
    const harness = await createHarness(false, account, null);
    const body = JSON.stringify({ entry: [] });
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBe(401);
    expect(harness.pool.query).not.toHaveBeenCalled();
  });

  it('does not accept a signature over re-serialized JSON bytes', async () => {
    const harness = await createHarness();
    const body = '{ "entry": [] }';
    const signature = harness.sign(JSON.stringify(JSON.parse(body)));
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('x-hub-signature-256', signature)
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBe(401);
    expect(harness.pool.query).not.toHaveBeenCalled();
  });

  it('echoes the Meta handshake challenge and rejects a wrong verification token', async () => {
    const harness = await createHarness();
    const valid = await request(harness.app)
      .get('/api/whatsapp/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-verify-token',
        'hub.challenge': 'challenge-value',
      });
    const invalid = await request(harness.app)
      .get('/api/whatsapp/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'challenge-value',
      });

    expect(valid.status).toBe(200);
    expect(valid.text).toBe('challenge-value');
    expect(invalid.status).toBe(403);
  });

  it('does not process a replayed wamid twice', async () => {
    const harness = await createHarness(true);
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{
        id: 'wamid.1',
        from: '2348000000000',
        type: 'text',
        text: { body: 'LIST' },
      }] } }] }],
    });
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('x-hub-signature-256', harness.sign(body))
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBe(200);
    expect(harness.auth.accountByPhone).not.toHaveBeenCalled();
    expect(harness.transactions.list).not.toHaveBeenCalled();
    expect(harness.pool.query).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a structurally invalid signed payload without retrying it', async () => {
    const harness = await createHarness();
    const body = JSON.stringify({ entry: 'not-an-array' });
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('x-hub-signature-256', harness.sign(body))
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBe(200);
    expect(harness.pool.query).not.toHaveBeenCalled();
  });

  it('acknowledges inbound media without pretending it was uploaded', async () => {
    const harness = await createHarness();
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{
        id: 'wamid.photo',
        from: '2348000000000',
        type: 'image',
        image: { id: 'media-id' },
      }] } }] }],
    });
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('x-hub-signature-256', harness.sign(body))
      .set('content-type', 'application/json')
      .send(body);
    const replyQuery = harness.pool.query.mock.calls.find(([sql]) => sql.includes('insert into outbox_events'));

    expect(response.status).toBe(200);
    expect(replyQuery?.[1]?.[0]).toContain('WhatsApp cannot add this file as evidence yet');
    expect(replyQuery?.[1]?.[0]).not.toContain('evidence recorded');
  });

  it('does not guess a transaction for an unlinked phone', async () => {
    const harness = await createHarness(false, null);
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{
        id: 'wamid.unlinked',
        from: '2348999999999',
        type: 'text',
        text: { body: 'STATUS VSP-123456' },
      }] } }] }],
    });
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('x-hub-signature-256', harness.sign(body))
      .set('content-type', 'application/json')
      .send(body);
    const replyQuery = harness.pool.query.mock.calls.find(([sql]) => sql.includes("values ('whatsapp.reply'"));

    expect(response.status).toBe(200);
    expect(harness.transactions.findIdByReferenceForParty).not.toHaveBeenCalled();
    expect(replyQuery?.[1]?.[0]).toContain('This phone number is not linked to a verified Verispon account.');
  });

  it('acknowledges a location but does not write it to a transaction', async () => {
    const harness = await createHarness();
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{
        id: 'wamid.location',
        from: '2348000000000',
        type: 'location',
        location: { latitude: 6.5244, longitude: 3.3792 },
      }] } }] }],
    });
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('x-hub-signature-256', harness.sign(body))
      .set('content-type', 'application/json')
      .send(body);
    const replyQuery = harness.pool.query.mock.calls.find(([sql]) => sql.includes("values ('whatsapp.reply'"));
    const payload = JSON.parse(replyQuery?.[1]?.[0] as string) as { text: string };

    expect(response.status).toBe(200);
    expect(payload.text).toContain('6.52440, 3.37920');
    expect(payload.text).toContain('Nothing was saved');
    expect(harness.transactions.findIdByReferenceForParty).not.toHaveBeenCalled();
  });

  it('acknowledges unsupported message types with a helpful reply', async () => {
    const harness = await createHarness();
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{
        id: 'wamid.sticker',
        from: '2348000000000',
        type: 'sticker',
        sticker: { id: 'media-id' },
      }] } }] }],
    });
    const response = await request(harness.app)
      .post('/api/whatsapp/webhook')
      .set('x-hub-signature-256', harness.sign(body))
      .set('content-type', 'application/json')
      .send(body);
    const replyQuery = harness.pool.query.mock.calls.find(([sql]) => sql.includes("values ('whatsapp.reply'"));
    const payload = JSON.parse(replyQuery?.[1]?.[0] as string) as { text: string };

    expect(response.status).toBe(200);
    expect(payload.text).toContain('Reply HELP');
  });
});
