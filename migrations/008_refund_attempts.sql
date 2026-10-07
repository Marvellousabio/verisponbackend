create type refund_attempt_status as enum ('PREPARED', 'SUBMITTING', 'UNKNOWN', 'SETTLED', 'FAILED');

create table refund_attempts (
  id uuid primary key default gen_random_uuid(),
  outbox_event_id bigint not null unique references outbox_events(id),
  transaction_id uuid not null references transactions(id),
  provider_transaction_id text not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  status refund_attempt_status not null default 'PREPARED',
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);