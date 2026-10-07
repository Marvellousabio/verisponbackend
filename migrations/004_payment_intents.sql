create type payment_intent_status as enum ('PENDING', 'READY', 'PAID', 'FAILED');

create table payment_intents (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references transactions(id),
  provider text not null default 'nomba' check (provider = 'nomba'),
  provider_order_reference text not null unique,
  provider_order_id text,
  provider_transaction_id text unique,
  checkout_url text,
  amount_kobo bigint not null check (amount_kobo > 0),
  status payment_intent_status not null default 'PENDING',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);