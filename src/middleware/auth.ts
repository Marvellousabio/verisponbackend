import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE, verifySession } from '../auth/session.js';
import { AuthService } from '../services/auth-service.js';

declare global {
  namespace Express {
    interface Request {
      account?: { id: string; roles: string[]; capabilities: string[] };
    }
  }
}

export function requireAuth(authService: AuthService) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const session = verifySession(request.cookies?.[SESSION_COOKIE]);
    if (!session) {
      response.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      return;
    }
    const account = await authService.accountById(session.accountId);
    if (!account || account.frozenAt) {
      response.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      return;
    }
    request.account = { id: account.id, roles: account.roles, capabilities: account.capabilities };
    next();
  };
}