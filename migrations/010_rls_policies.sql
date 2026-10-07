-- Authorisation for this service is enforced in the service layer
-- (docs/BACKEND.md section 7.4). The API connects as a single application
-- role that also owns these tables, and that role is the only writer.
--
-- Migration 009 enabled row level security on every table without creating a
-- single policy. That is safe only for as long as the connecting role happens
-- to be the table owner, because RLS is not enforced against the owner. A
-- non-owner or non-BYPASSRLS connection - a pooler identity, a read replica
-- user, a future read-only service role - would receive zero rows from every
-- query, and the failure mode is silent: empty dashboards and empty
-- transaction lists rather than an error.
--
-- These policies make the boundary explicit instead of accidental. RLS stays
-- enabled, but the application role has a named, permissive policy on every
-- table, so table ownership no longer changes runtime behaviour. The
-- privilege-level restriction that does carry weight is retained below:
-- audit_log is append-only for the application role.

do $$
declare
  target text;
begin
  foreach target in array array[
    'accounts', 'transactions', 'transaction_events', 'evidence', 'delivery_events',
    'disputes', 'dispute_responses', 'ledger_accounts', 'ledger_entries',
    'idempotency_keys', 'outbox_events', 'audit_log', 'rate_limit_buckets',
    'recovery_challenges', 'provider_webhook_events', 'account_admin_capabilities',
    'payment_intents', 'account_payout_destinations', 'payout_transfers',
    'account_verification_challenges', 'refund_attempts', 'schema_migrations'
  ]
  loop
    -- Dropped first so a partially applied earlier run cannot abort the deploy
    -- on a duplicate policy name.
    execute format('drop policy if exists %I on %I', target || '_service_access', target);
    execute format('create policy %I on %I for all to public using (true) with check (true)', target || '_service_access', target);
  end loop;
end;
$$;

revoke update, delete on audit_log from public;
