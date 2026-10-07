import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

export function requireSameOrigin(request: Request, response: Response, next: NextFunction): void {
  const origin = request.get('origin');
  if (origin !== config.WEB_ORIGIN) {
    response.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed' } });
    return;
  }
  next();
}