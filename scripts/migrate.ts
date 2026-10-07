import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirePool } from '../src/db/pool.js';
import { config } from '../src/config.js';

/**
 * `pg_advisory_lock` is session scoped, so it only serialises this run while
 * the same server session holds it across every statement below. A
 * transaction-mode pooler such as Supabase's port 6543 endpoint returns the
 * server connection to the pool as soon as each implicit transaction commits.
 * The lock is therefore taken on one backend and dropped before the first
 * migration file is applied: the call still returns, so the guard looks like it
 * worked while two concurrent release steps could apply the same file.
 *
 * Migrations therefore have to run over the direct connection. The pooler is
 * for runtime traffic, which is the part that needs the connection budget.
 */
function assertDirectConnection(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname.toLowerCase();
  if (host.endsWith('pooler.supabase.com') || host.includes('.pooler.')) {
    throw new Error(
      `DATABASE_URL points at the connection pooler (${host}). Run migrations against the ` +
      'direct connection string instead. The advisory lock that stops two deploys applying ' +
      'the same migration is session scoped, and the pooler releases the session between ' +
      'statements, so the lock would silently not be held.',
    );
  }
}

const databaseUrl = config.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations');

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
assertDirectConnection(databaseUrl);
const pool = requirePool();
const client = await pool.connect();

try {
  await client.query('select pg_advisory_lock(734219104)');
  await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const applied = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((row) => row.name));
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();

  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(join(migrationsDirectory, name), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('select pg_advisory_unlock(734219104)');
  client.release();
  await pool.end();
}