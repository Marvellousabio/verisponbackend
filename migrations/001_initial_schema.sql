create extension if not exists pgcrypto;
create extension if not exists citext;

create type account_role as enum ('BUYER', 'SELLER', 'ADMIN');
create type transaction_state as enum (
  'CREATED', 'AWAITING_BUYER_VERIFICATION', 'AWAITING_PAYMENT', 'FUNDED',
  'SELLER_PROCESSING', 'SHIPPED', 'DELIVERED', 'BUYER_INSPECTION', 'RELEASED',
  'COMPLETED', 'CANCELLED', 'DELIVERY_FAILED', 'RETURN_IN_PROGRESS', 'DISPUTED',
  'UNDER_REVIEW', 'REFUNDED', 'PARTIALLY_REFUNDED'
);
create type delivery_method as enum ('SELLER_RIDER', 'INTEGRATED_COURIER', 'BUYER_ARRANGED');
create type ledger_account as enum (
  'escrow_cash', 'buyer_fee_revenue', 'seller_fee_revenue', 'seller_payable',
  'refund_payable', 'platform_equity', 'external_cash', 'payout_clearing'
);
create type evidence_type as enum (
  'ITEM_BEFORE_TRANSACTION', 'ITEM_PACKAGING', 'ITEM_HANDOVER', 'ITEM_SHIPMENT',
  'DELIVERY', 'ITEM_RECEIVED', 'ITEM_DAMAGED', 'RECEIPT', 'DOCUMENT', 'OTHER'
);
create type dispute_reason as enum (
  'ITEM_NOT_AS_DESCRIBED', 'ITEM_NOT_RECEIVED', 'ITEM_DAMAGED',
  'PAYMENT_PROBLEM', 'DELIVERY_PROBLEM', 'OTHER'
);
create type dispute_status as enum (
  'OPEN', 'UNDER_REVIEW', 'RESOLVED_RELEASE', 'RESOLVED_REFUND', 'RESOLVED_PARTIAL'
);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  name text not null,
  email citext not null unique,
  phone text unique,
  passcode_hash text not null,
  roles account_role[] not null default array['BUYER']::account_role[],
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index accounts_email_active_idx on accounts (email) where deleted_at is null;
create index accounts_phone_active_idx on accounts (phone) where deleted_at is null;

create table transactions (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  title text not null check (length(btrim(title)) between 3 and 140),
  description text check (description is null or length(description) <= 2000),
  buyer_account_id uuid not null references accounts(id),
  buyer_name text not null,
  buyer_reference text not null,
  seller_account_id uuid not null references accounts(id),
  seller_name text not null,
  seller_reference text not null,
  amount_kobo bigint not null check (amount_kobo > 0 and amount_kobo <= 9007199254740991),
  buyer_fee_kobo bigint not null check (buyer_fee_kobo >= 0),
  seller_fee_kobo bigint not null check (seller_fee_kobo >= 0),
  buyer_total_kobo bigint generated always as (amount_kobo + buyer_fee_kobo) stored,
  seller_net_kobo bigint generated always as (amount_kobo - seller_fee_kobo) stored,
  state transaction_state not null default 'CREATED',
  previous_state transaction_state,
  delivery_method delivery_method,
  rider_name text,
  rider_phone text,
  rider_reference text,
  rider_verified_at timestamptz,
  pickup_address text,
  destination_address text,
  delivery_window text,
  delivery_fees_kobo bigint check (delivery_fees_kobo is null or delivery_fees_kobo >= 0),
  delivery_outcome text check (delivery_outcome in ('DELIVERED', 'FAILED', 'RETURNED')),
  failure_reason text,
  failure_confirmed_at timestamptz,
  auto_release_at timestamptz,
  payout_authorised_at timestamptz,
  payout_reference text,
  inspection_expires_at timestamptz,
  refunded_kobo bigint not null default 0 check (refunded_kobo >= 0 and refunded_kobo <= amount_kobo),
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint buyer_is_not_seller check (buyer_account_id <> seller_account_id),
  constraint release_requires_authority check (state <> 'RELEASED' or payout_authorised_at is not null)
);
create index transactions_buyer_updated_idx on transactions (buyer_account_id, updated_at desc);
create index transactions_seller_updated_idx on transactions (seller_account_id, updated_at desc);
create index transactions_state_idx on transactions (state);
create index transactions_due_release_idx on transactions (auto_release_at) where state = 'BUYER_INSPECTION';

create table transaction_events (
  id bigserial primary key,
  transaction_id uuid not null references transactions(id),
  state transaction_state not null,
  actor text not null check (actor in ('buyer', 'seller', 'system', 'admin')),
  actor_account_id uuid references accounts(id),
  note text,
  at timestamptz not null default now()
);
create index transaction_events_tx_idx on transaction_events (transaction_id, at);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  type evidence_type not null,
  stage text not null check (stage in ('before_payment', 'payment', 'fulfillment', 'dispatch', 'delivery', 'receipt', 'confirmation', 'dispute')),
  uploader_id uuid not null references accounts(id),
  uploader_name text not null,
  storage_key text not null,
  content_type text not null,
  bytes integer not null check (bytes > 0),
  checksum text,
  description text check (description is null or length(description) <= 1000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index evidence_tx_idx on evidence (transaction_id, created_at);

create table delivery_events (
  id bigserial primary key,
  transaction_id uuid not null references transactions(id),
  type text not null check (type in ('PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'UNABLE_TO_DELIVER', 'RETURNING', 'RETURNED')),
  reason text,
  location text,
  rider_verified boolean not null default false,
  reported_by text not null check (reported_by in ('seller', 'buyer', 'rider', 'system')),
  at timestamptz not null default now()
);
create index delivery_events_tx_idx on delivery_events (transaction_id, at);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references transactions(id),
  reason dispute_reason not null,
  summary text not null check (length(summary) between 20 and 2000),
  opened_by uuid not null references accounts(id),
  opened_by_role text not null check (opened_by_role = 'buyer'),
  status dispute_status not null default 'OPEN',
  resolution text,
  refund_kobo bigint check (refund_kobo is null or refund_kobo >= 0),
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references accounts(id)
);
create index disputes_open_idx on disputes (status) where status in ('OPEN', 'UNDER_REVIEW');

create table ledger_accounts (
  account ledger_account primary key,
  currency char(3) not null default 'NGN' check (currency = 'NGN'),
  kind text not null check (kind in ('asset', 'liability', 'equity', 'revenue')),
  description text not null
);
insert into ledger_accounts (account, kind, description) values
  ('escrow_cash', 'liability', 'Funds held for active escrow transactions'),
  ('buyer_fee_revenue', 'revenue', 'Fees charged to buyers'),
  ('seller_fee_revenue', 'revenue', 'Fees charged to sellers on release'),
  ('seller_payable', 'liability', 'Funds authorised for seller payout'),
  ('refund_payable', 'liability', 'Funds authorised for buyer refund'),
  ('platform_equity', 'equity', 'Platform retained earnings and adjustments'),
  ('external_cash', 'asset', 'Settlement balance held by payment provider'),
  ('payout_clearing', 'asset', 'Transfers in flight to or from a provider');

create table ledger_entries (
  id bigserial primary key,
  group_id uuid not null,
  transaction_id uuid references transactions(id),
  account ledger_account not null references ledger_accounts(account),
  direction char(1) not null check (direction in ('D', 'C')),
  amount_kobo bigint not null check (amount_kobo > 0),
  memo text,
  actor text not null check (actor in ('buyer', 'seller', 'system', 'admin')),
  created_at timestamptz not null default now()
);
create index ledger_entries_tx_idx on ledger_entries (transaction_id);
create index ledger_entries_group_idx on ledger_entries (group_id);

create table idempotency_keys (
  key text not null,
  account_id uuid not null references accounts(id),
  endpoint text not null,
  request_hash text not null,
  response jsonb,
  status text not null check (status in ('IN_FLIGHT', 'COMPLETED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  primary key (key, account_id, endpoint)
);

create table outbox_events (
  id bigserial primary key,
  topic text not null,
  transaction_id uuid references transactions(id),
  payload jsonb not null,
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbox_pending_idx on outbox_events (available_at) where delivered_at is null;

create table audit_log (
  id bigserial primary key,
  actor_id uuid references accounts(id),
  actor_role text,
  action text not null,
  target_type text not null,
  target_id text not null,
  before jsonb,
  after jsonb,
  ip inet,
  user_agent text,
  at timestamptz not null default now()
);
create index audit_target_idx on audit_log (target_type, target_id, at desc);

create table rate_limit_buckets (
  scope text not null,
  subject_hash text not null,
  window_started_at timestamptz not null,
  attempts integer not null default 0,
  primary key (scope, subject_hash)
);

create table recovery_challenges (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index recovery_one_live_per_account_idx on recovery_challenges (account_id) where consumed_at is null;

create table provider_webhook_events (
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (provider, event_id)
);

create function prevent_audit_log_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;
create trigger audit_log_immutable before update or delete on audit_log
  for each row execute function prevent_audit_log_mutation();