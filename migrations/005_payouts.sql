create type payout_transfer_status as enum ('PREPARED', 'PENDING', 'SUCCEEDED', 'RETURNED');

create table account_payout_destinations (
  account_id uuid primary key references accounts(id),
  bank_code text not null,
  bank_name text not null,
  verified_account_name text not null,
  encrypted_destination text not null,
  verified_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table payout_transfers (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  merchant_tx_ref text not null unique,
  provider_transaction_id text unique,
  amount_kobo bigint not null check (amount_kobo > 0),
  status payout_transfer_status not null default 'PREPARED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index payout_one_active_or_successful_idx
  on payout_transfers (transaction_id)
  where status in ('PREPARED', 'PENDING', 'SUCCEEDED');