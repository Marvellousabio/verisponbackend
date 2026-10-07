create type verification_channel as enum ('EMAIL', 'PHONE', 'BOTH');

create table account_verification_challenges (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  channel verification_channel not null check (channel in ('EMAIL', 'PHONE')),
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index verification_one_live_channel_idx
  on account_verification_challenges (account_id, channel)
  where verified_at is null and consumed_at is null;