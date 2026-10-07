import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { WhatsAppCloudAdapter } from '../adapters/notifications.js';
import type { AuthService } from '../services/auth-service.js';
import { IdempotencyConflictError } from '../db/idempotency.js';
import { EscrowService } from '../services/escrow-service.js';
import { PostgresTransactionRepository } from '../repositories/transaction-repository.js';
import {
  WhatsAppCommandService,
  type WhatsAppInboundMessage,
} from '../services/whatsapp-command-service.js';

declare module 'express-serve-static-core' {
  interface Request {
    rawBody?: Buffer;
  }
}

const inboundMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  type: z.string().min(1),
  timestamp: z.string().regex(/^\d+$/).optional(),
  text: z.object({ body: z.string() }).optional(),
  image: z.object({ caption: z.string().optional() }).optional(),
  document: z.object({ caption: z.string().optional() }).optional(),
  video: z.object({ caption: z.string().optional() }).optional(),
  audio: z.object({}).passthrough().optional(),
  location: z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  }).optional(),
  interactive: z.object({
    button_reply: z.object({ id: z.string().min(1) }).optional(),
    list_reply: z.object({ id: z.string().min(1) }).optional(),
  }).optional(),
}).passthrough();

const valueSchema = z.object({
  messages: z.array(z.unknown()).optional(),
}).passthrough();

const payloadSchema = z.object({
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: valueSchema,
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

function secureStringEquals(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createWhatsAppRouter(
  pool: Pool,
  auth: AuthService,
  transactions: PostgresTransactionRepository,
  escrow: EscrowService,
) {
  const router = Router();
  const whatsapp = new WhatsAppCloudAdapter();
  const commands = new WhatsAppCommandService(auth, transactions, escrow, async (
    phone,
    text,
    accountId,
    allowOptOutConfirmation,
    serviceWindowExpiresAt,
  ) => {
    await pool.query(
      `insert into outbox_events (topic, payload) values ('whatsapp.reply', $1)`,
      [JSON.stringify({
        phone,
        text,
        ...(accountId ? { account_id: accountId } : {}),
        ...(allowOptOutConfirmation ? { allow_opt_out_confirmation: true } : {}),
        ...(serviceWindowExpiresAt ? { service_window_expires_at: serviceWindowExpiresAt } : {}),
      })],
    );
  });

  router.get('/webhook', (request, response) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];
    if (
      mode === 'subscribe'
      && typeof token === 'string'
      && secureStringEquals(token, config.META_WEBHOOK_VERIFY_TOKEN)
      && typeof challenge === 'string'
    ) {
      response.status(200).type('text/plain').send(challenge);
      return;
    }
    response.status(403).end();
  });

  router.post('/webhook', async (request, response, next) => {
    try {
      if (!request.rawBody || !whatsapp.verifySignature(request.rawBody, request.get('x-hub-signature-256'))) {
        response.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed' } });
        return;
      }

      const parsedPayload = payloadSchema.safeParse(request.body);
      if (!parsedPayload.success) {
        console.warn('Ignoring an invalid WhatsApp webhook payload');
        response.status(200).json({ received: true });
        return;
      }

      const unparsedMessages = parsedPayload.data.entry?.flatMap((entry) =>
        entry.changes?.flatMap((change) => change.value.messages ?? []) ?? [],
      ) ?? [];
      for (const unparsedMessage of unparsedMessages) {
        const parsedMessage = inboundMessageSchema.safeParse(unparsedMessage);
        if (!parsedMessage.success) {
          console.warn('Ignoring an unsupported WhatsApp message payload');
          continue;
        }
        const message = parsedMessage.data;
        const media = message.type === 'image' ? message.image
          : message.type === 'document' ? message.document
            : message.type === 'video' ? message.video
              : undefined;
        const interactiveId = message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;
        await processMessage(pool, commands, {
          id: message.id,
          from: message.from,
          type: message.type,
          ...(message.timestamp ? { timestamp: message.timestamp } : {}),
          ...(message.text ? { text: message.text.body } : {}),
          ...(media?.caption ? { caption: media.caption } : {}),
          ...(interactiveId !== undefined ? { interactiveId } : {}),
          ...(message.location ? { location: message.location } : {}),
        });
      }
      response.status(200).json({ received: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function processMessage(
  pool: Pool,
  commands: WhatsAppCommandService,
  message: WhatsAppInboundMessage,
): Promise<void> {
  const claim = await pool.query(
    `insert into provider_webhook_events (provider, event_id)
     values ('meta_whatsapp', $1) on conflict do nothing returning event_id`,
    [message.id],
  );
  if (claim.rowCount === 0) return;

  try {
    await commands.handle(message);
    await pool.query(
      `update provider_webhook_events set processed_at = now()
       where provider = 'meta_whatsapp' and event_id = $1`,
      [message.id],
    );
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      await pool.query(
        `update provider_webhook_events set processed_at = now()
         where provider = 'meta_whatsapp' and event_id = $1`,
        [message.id],
      );
      return;
    }
    await pool.query(
      `delete from provider_webhook_events
       where provider = 'meta_whatsapp' and event_id = $1`,
      [message.id],
    );
    throw error;
  }
}
