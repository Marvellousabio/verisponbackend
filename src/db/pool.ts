import { Pool } from 'pg';
import { config } from '../config.js';

export const pool = config.DATABASE_URL
  ? new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.NODE_ENV === 'production' ? true : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

export function requirePool(): Pool {
  if (!pool) {
    throw new Error('DATABASE_URL is required for this operation');
  }
  return pool;
}