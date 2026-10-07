create type admin_capability as enum (
  'disputes.read',
  'disputes.resolve',
  'transactions.read_all',
  'accounts.read',
  'accounts.roles.grant',
  'accounts.freeze',
  'audit.read',
  'refunds.reconcile'
);

create table account_admin_capabilities (
  account_id uuid not null references accounts(id),
  capability admin_capability not null,
  granted_by uuid references accounts(id),
  created_at timestamptz not null default now(),
  primary key (account_id, capability)
);
create index account_admin_capabilities_account_idx on account_admin_capabilities (account_id);