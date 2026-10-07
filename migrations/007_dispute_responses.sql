create table dispute_responses (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references disputes(id),
  author_id uuid not null references accounts(id),
  summary text not null check (length(summary) between 20 and 2000),
  created_at timestamptz not null default now()
);
create index dispute_responses_dispute_idx on dispute_responses (dispute_id, created_at);