-- Condition photos gate the move into AWAITING_PAYMENT, so the flag has to
-- survive on the row rather than in the request that happened to open it.
-- It is server-computed at creation and never written by a client afterwards.
alter table transactions
  add column photos_enabled boolean not null default false;

-- The payment link is a capability, not a reference: VSP-0007 is sequential and
-- guessable, so a buyer must not be able to arrive at a checkout page by
-- guessing. 32 lowercase hex chars is the whole format.
alter table transactions
  add column checkout_token text,
  add column checkout_expires_at timestamptz,
  add column checkout_opened_at timestamptz;

alter table transactions
  add constraint checkout_token_shape
    check (checkout_token is null or checkout_token ~ '^[0-9a-f]{32}$'),
  add constraint checkout_link_is_paired
    check ((checkout_token is null) = (checkout_expires_at is null));

create unique index transactions_checkout_token_idx
  on transactions (checkout_token) where checkout_token is not null;

-- docs/BACKEND.md §11 lists nine ledger accounts; VERISPON_ESCROW_BANK was
-- missing. It is the account a refund debits when principal leaves escrow to
-- the provider, so leaving it out made a correct refund posting impossible.
insert into ledger_accounts (account, kind, description) values
  ('verispon_escrow_bank', 'asset', 'Verispon escrow bank balance backing held principal')
on conflict (account) do nothing;
