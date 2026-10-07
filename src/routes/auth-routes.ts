import { Router } from 'express';
import { z } from 'zod';
import { clearSession, issueSession } from '../auth/session.js';
import { requireAuth } from '../middleware/auth.js';
import { requireSameOrigin } from '../middleware/same-origin.js';
import { AuthService, InvalidCredentialsError, RateLimitError } from '../services/auth-service.js';

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  phone: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/).optional(),
  passcode: z.string().regex(/^\d{6}$/),
  roles: z.array(z.enum(['BUYER', 'SELLER'])).min(1).max(2).optional(),
});
const loginSchema = z.object({ identifier: z.string().trim().min(3).max(254), passcode: z.string().regex(/^\d{6}$/) });
const recoverySchema = z.object({ identifier: z.string().trim().min(3).max(254) });
const verifyRecoverySchema = z.object({ identifier: z.string().trim().min(3).max(254), code: z.string().regex(/^\d{6}$/), new_passcode: z.string().regex(/^\d{6}$/) });
const consentSchema = z.object({ consent: z.literal(true) });
const verificationSchema = z.object({ channel: z.enum(['EMAIL', 'PHONE']) });
const verifyChannelSchema = z.object({ channel: z.enum(['EMAIL', 'PHONE']), code: z.string().regex(/^\d{6}$/) });

function safeAccount(account: { id: string; reference: string; name: string; email: string; phone: string | null; roles: string[] }) {
  return { id: account.id, reference: account.reference, name: account.name, email: account.email, phone: account.phone, roles: account.roles };
}

export function createAuthRouter(auth: AuthService) {
  const router = Router();
  router.use((request, response, next) => {
    if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
      requireSameOrigin(request, response, next);
      return;
    }
    next();
  });

  router.post('/register', async (request, response, next) => {
    try {
      const input = registerSchema.parse(request.body);
      const account = await auth.register(input);
      issueSession(response, account.id);
      response.status(201).json({ account: safeAccount(account) });
    } catch (error) { next(error); }
  });

  router.post('/login', async (request, response, next) => {
    try {
      const input = loginSchema.parse(request.body);
      const account = await auth.login(input.identifier, input.passcode, request.ip ?? 'unknown');
      issueSession(response, account.id);
      response.status(200).json({ account: safeAccount(account) });
    } catch (error) { next(error); }
  });

  router.post('/logout', (_request, response) => {
    clearSession(response);
    response.status(204).end();
  });

  router.post('/recover', async (request, response, next) => {
    try {
      const input = recoverySchema.parse(request.body);
      await auth.requestRecovery(input.identifier, request.ip ?? 'unknown');
      response.status(202).json({ message: 'If the account can be recovered, a code will be sent.' });
    } catch (error) { next(error); }
  });

  router.post('/recover/verify', async (request, response, next) => {
    try {
      const input = verifyRecoverySchema.parse(request.body);
      const account = await auth.verifyRecovery(input.identifier, input.code, input.new_passcode);
      issueSession(response, account.id);
      response.status(200).json({ account: safeAccount(account) });
    } catch (error) { next(error); }
  });

  router.post('/whatsapp-consent', requireAuth(auth), async (request, response, next) => {
    try {
      consentSchema.parse(request.body);
      await auth.setWhatsAppPreference(request.account!.id, true);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.post('/whatsapp-opt-out', requireAuth(auth), async (request, response, next) => {
    try {
      await auth.setWhatsAppPreference(request.account!.id, false);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.post('/verification/send', requireAuth(auth), async (request, response, next) => {
    try {
      const input = verificationSchema.parse(request.body);
      await auth.requestVerification(request.account!.id, input.channel);
      response.status(202).json({ message: 'If the channel is available, a verification code will be sent.' });
    } catch (error) { next(error); }
  });

  router.post('/verification/confirm', requireAuth(auth), async (request, response, next) => {
    try {
      const input = verifyChannelSchema.parse(request.body);
      await auth.verifyChannel(request.account!.id, input.channel, input.code);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.get('/me', requireAuth(auth), (request, response) => {
    response.status(200).json({ account: request.account });
  });

  router.use((error: unknown, _request: unknown, response: import('express').Response, next: import('express').NextFunction) => {
    if (error instanceof InvalidCredentialsError) {
      response.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: error.message } });
      return;
    }
    if (error instanceof RateLimitError) {
      response.status(429).json({ error: { code: 'RATE_LIMITED', message: error.message } });
      return;
    }
    next(error);
  });

  return router;
}