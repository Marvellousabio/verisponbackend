import { requirePool } from '../src/db/pool.js';

const [accountId, ...capabilities] = process.argv.slice(2);
const validCapabilities = new Set([
  'disputes.read', 'disputes.resolve', 'transactions.read_all', 'accounts.read',
  'accounts.roles.grant', 'accounts.freeze', 'audit.read',
  'refunds.reconcile',
]);

if (!accountId || capabilities.length === 0 || capabilities.some((capability) => !validCapabilities.has(capability))) {
  console.error('Usage: npm run admin:grant -- <account-uuid> <capability> [capability...]');
  process.exitCode = 1;
} else {
  const pool = requirePool();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const account = await client.query<{ id: string; roles: string[] }>(
      'select id, roles from accounts where id = $1 and deleted_at is null for update', [accountId],
    );
    if (!account.rows[0]) throw new Error('Account not found');
    if (!account.rows[0].roles.includes('ADMIN')) {
      await client.query("update accounts set roles = array_append(roles, 'ADMIN'::account_role), updated_at = now() where id = $1", [accountId]);
    }
    for (const capability of capabilities) {
      await client.query(
        `insert into account_admin_capabilities (account_id, capability)
         values ($1, $2::admin_capability) on conflict do nothing`, [accountId, capability],
      );
    }
    await client.query(
      `insert into audit_log (actor_role, action, target_type, target_id, after)
       values ('OPERATOR', 'account.admin_grant', 'account', $1, $2)`,
      [accountId, JSON.stringify({ roles: ['ADMIN'], capabilities })],
    );
    await client.query('commit');
    console.log(`Granted ADMIN to ${accountId}: ${capabilities.join(', ')}`);
  } catch (error) {
    await client.query('rollback');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}