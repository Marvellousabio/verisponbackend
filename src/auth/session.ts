import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { APPLICATION_SECRET, config, SESSION_SAME_SITE } from '../config.js';

export const SESSION_COOKIE = 'verispon_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SessionPayload {
  accountId: string;
  issuedAt: number;
}

/**
 * `SameSite=None` is only honoured by browsers alongside `Secure`, so the
 * attribute cannot be configured independently of the transport.
 */
const COOKIE_SECURE = config.NODE_ENV === 'production' || SESSION_SAME_SITE === 'none';

function sessionSecret(): string {
  if (config.NODE_ENV === 'production' && !config.SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be configured before issuing sessions');
  }
  return APPLICATION_SECRET;
}

function signature(payload: string): Buffer {
  return createHmac('sha256', sessionSecret()).update(payload).digest();
}

export function issueSession(response: Response, accountId: string): void {
  const payload = Buffer.from(JSON.stringify({ accountId, issuedAt: Date.now() } satisfies SessionPayload)).toString('base64url');
  const token = `${payload}.${signature(payload).toString('base64url')}`;
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: SESSION_SAME_SITE,
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearSession(response: Response): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: SESSION_SAME_SITE,
    secure: COOKIE_SECURE,
    path: '/',
  });
}

export function verifySession(token: unknown): SessionPayload | null {
  if (typeof token !== 'string') return null;
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra) return null;
  try {
    const actual = Buffer.from(encodedSignature, 'base64url');
    const expected = signature(payload);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (typeof parsed.accountId !== 'string' || typeof parsed.issuedAt !== 'number') return null;
    if (parsed.issuedAt > Date.now() || Date.now() - parsed.issuedAt > SESSION_TTL_SECONDS * 1000) return null;
    return { accountId: parsed.accountId, issuedAt: parsed.issuedAt };
  } catch {
    return null;
  }
}