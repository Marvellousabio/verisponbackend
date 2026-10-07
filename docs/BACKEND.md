# Verispon Backend Architecture

Status: design specification. Nothing in this document is implemented yet except
where the "Today" column in the gaps table says otherwise.

This is the server-side counterpart to the frontend rebuild. It specifies the
PostgreSQL schema behind the existing repository seam, the escrow state machine
and its ledger rules, the payment link, the HTTP API contracts, authentication and
authorisation, the fee schedule, external integrations, and the admin surface.

**Read with:**

| Document | Contains |
| --- | --- |
| `API.md` | The wire contract: every route, request and response shape, error format |
| `STATE_MACHINES.md` | The lifecycle, the transition map, dispute and evidence rules |
| `WHATSAPP_BOT_PLAN.md` | The WhatsApp bridge, and what is honestly not built |

Where this document and the code disagree, the code is right and this document is
a bug. Every "today" claim below was checked against `apps/web/src`; §15 lists
what changed most recently and which earlier claims were wrong.

---

## 1. Principles

These are the constraints every later decision is measured against. Where a
design choice appears to violate one, the principle wins.

1. **The engine decides state. Clients request transitions.**
   WhatsApp and the web client may ask for a state change. Only the server-side
   transaction engine performs one. A client that guesses a legal transition
   still gets refused when its role does not permit it, and gets refused outright
   when the transition is engine-only.
2. **Money never touches floating point.** Every amount is an integer number of
   kobo in `BIGINT`. Naira exists only at the formatting boundary.
3. **Every movement of money is a balanced, atomic, auditable posting.**
   There is no code path that changes an escrow balance without writing ledger
   entries in the same database transaction.
4. **Fees are frozen at creation.** A later change to the published fee schedule
   cannot retroactively alter what a party agreed to pay.
5. **Dependency direction is one-way.** `src/domain/*` knows nothing about HTTP,
   SQL, or storage. Server services depend on the repository interfaces.
   Repository implementations depend on the domain and on PostgreSQL. No
   interface depends on an implementation.
6. **A missing authorisation answer is a 404, not a 403.** Distinguishing
   "does not exist" from "exists but is not yours" enumerates references.
7. **A capability token is unguessable and expires.** The payment link is what a
   buyer clicks in a message from a stranger, so it is not a sequential public
   reference, and it is not renewable once its deadline passes.

---

## 2. Layering

```
  HTTP routes  ──▶  services  ──▶  repositories (interfaces)
  (Next route        (authz,            │
   handlers)          orchestration,     ▼
                      validation)   implementations
                                          │
                        ┌─────────────────┴─────────────────┐
                        ▼                                   ▼
                 PostgresRepository              JsonRepository
                 (production)                    (tests, local dev)
```

| Layer | Location today | Responsibility |
| --- | --- | --- |
| Domain | `apps/web/src/domain/*` | Pure rules: states, transitions, fees, validation. No I/O. |
| Services | `apps/web/src/server/services/*` (new) | Authorisation, orchestration, idempotency, outbox writes. |
| Repositories | `apps/web/src/server/repositories/*` | Persistence contract and implementations. |
| Adapters | `apps/web/src/server/adapters/*` (new) | Banking, WhatsApp, courier, object storage. |
| Routes | `apps/web/src/app/api/*` | Parse, delegate, map errors to status codes. No business rules. |

Routes must not contain business rules. A rule that only exists in a route is a
rule the WhatsApp bridge does not have, and the bridge is a first-class client
of the same engine.

The legacy `apps/web/src/lib/postgres-store.ts` implements superseded interfaces
and must be deleted, not extended. It is a dead module that reads as though
PostgreSQL support already exists.

---

## 3. Data model

### 3.1 Accounts

```sql
create type account_role as enum ('BUYER', 'SELLER', 'ADMIN');
create type verification_channel as enum ('EMAIL', 'PHONE', 'BOTH');

create table accounts (
  id              uuid primary key default gen_random_uuid(),
  reference       text not null unique,          -- e.g. 'VSP-A-0002', human-facing
  name            text not null,
  email           citext not null unique,
  phone           text unique,                    -- E.164 digits, no leading '+'
  passcode_hash   text not null,                  -- scrypt$N$r$p$salt$hash
  roles           account_role[] not null default array['BUYER']::account_role[],
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz                    -- soft delete
);
create index accounts_email_idx on accounts (email) where deleted_at is null;
create index accounts_phone_idx on accounts (phone) where deleted_at is null;
```

Email and phone verification remain two independent timestamps, mirroring
`Account.emailVerified` / `Account.phoneVerified`. A single `verified_at` would
claim more than has been proven, and disputes turn on who did what.

`deleted_at` is a soft delete because a historical transaction must keep resolving
to a party. A hard delete would orphan the record of what was agreed.

`ADMIN` is not in the insert path. It is granted out of band by a migration or an
operator script; the admin console does not exist yet, so `SELF_ASSIGNABLE_ROLES`
stays `['BUYER', 'SELLER']`.

### 3.2 Transactions

The current `TransactionRecord` is flat and self-contained. Keeping the flat
shape in SQL is a deliberate choice, not laziness: a dispute is read far more
often than it is written, and denormalised party snapshots mean a deleted or
renamed account cannot rewrite history.

```sql
create type transaction_state as enum (
  'CREATED','AWAITING_BUYER_VERIFICATION','AWAITING_PAYMENT','FUNDED',
  'SELLER_PROCESSING','SHIPPED','DELIVERED','BUYER_INSPECTION','RELEASED',
  'COMPLETED','CANCELLED','DELIVERY_FAILED','RETURN_IN_PROGRESS','DISPUTED',
  'UNDER_REVIEW','REFUNDED','PARTIALLY_REFUNDED'
);
create type delivery_method as enum ('SELLER_RIDER','INTEGRATED_COURIER','BUYER_ARRANGED');

create table transactions (
  id                 uuid primary key default gen_random_uuid(),
  reference          text not null unique,      -- e.g. 'VSP-0007', quoted aloud in WhatsApp
  title              text not null check (length(btrim(title)) between 4 and 120),
  description        text check (description is null or length(description) <= 1000),

  -- Party snapshots. Denormalised on purpose; see above.
  buyer_account_id   uuid not null references accounts(id),
  buyer_name         text not null,
  buyer_reference    text not null,
  seller_account_id  uuid not null references accounts(id),
  seller_name        text not null,
  seller_reference   text not null,

  -- Money, in kobo, frozen at creation.
  amount_kobo        bigint not null check (amount_kobo > 0),
  buyer_fee_kobo     bigint not null check (buyer_fee_kobo >= 0),
  seller_fee_kobo    bigint not null check (seller_fee_kobo >= 0),
  buyer_total_kobo   bigint not null generated always as
                       (amount_kobo + buyer_fee_kobo) stored,
  seller_net_kobo    bigint not null generated always as
                       (amount_kobo - seller_fee_kobo) stored,

  state              transaction_state not null default 'CREATED',
  previous_state     transaction_state,

  -- Condition photos. Off by default; when on, the before photo gates payment.
  photos_enabled     boolean not null default false,

  -- The payment link. See §3.3; this is the capability a buyer clicks.
  checkout_token       text unique check (checkout_token ~ '^[0-9a-f]{32}$'),
  checkout_expires_at  timestamptz,
  checkout_opened_at   timestamptz,
  constraint checkout_is_all_or_nothing check (
    (checkout_token is null) = (checkout_expires_at is null)
  ),

  delivery_method    delivery_method,
  rider_name         text,
  rider_phone        text,
  rider_reference    text,
  rider_verified_at  timestamptz,
  pickup_address     text,
  destination_address text,
  delivery_window    text,
  delivery_fees_kobo bigint,
  delivery_outcome   text check (delivery_outcome in ('DELIVERED','FAILED','RETURNED')),
  failure_reason     text,
  failure_confirmed_at timestamptz,

  -- Scheduling and settlement.
  auto_release_at    timestamptz,
  payout_authorised_at timestamptz,
  payout_reference   text,
  inspection_expires_at timestamptz,

  -- Running total of what has been refunded, for the reconciliation query.
  refunded_kobo      bigint not null default 0
                       check (refunded_kobo >= 0 and refunded_kobo <= amount_kobo),

  cancelled_at       timestamptz,
  cancellation_reason text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint buyer_is_not_seller check (buyer_account_id <> seller_account_id),
  constraint release_requires_authority check (
    state <> 'RELEASED' or payout_authorised_at is not null
  )
);
create index transactions_party_idx
  on transactions (buyer_account_id, updated_at desc);
create index transactions_party_seller_idx
  on transactions (seller_account_id, updated_at desc);
create index transactions_state_idx on transactions (state);
create index transactions_due_release_idx
  on transactions (auto_release_at)
  where state = 'BUYER_INSPECTION';
```

`previous_state` is persisted because the transition check has to reject a repeat
of a state already entered, and because a stored `from` makes an audit row
reconstructible without a separate event log.

The length checks match the domain constants exactly — `TITLE_MIN`/`TITLE_MAX` are
4/120 and `DESCRIPTION_MAX` is 1000 in `domain/transaction-draft.ts`. An earlier
version of this document specified 3/140 and 2000, which the database would have
accepted and the service rejected; keeping the two in step is what stops a
divergence report nobody can reproduce.

The `release_requires_authority` constraint means the database refuses a
`RELEASED` row that has no payout authority, independently of the service that
wrote it. A second line of defence behind `ENGINE_ONLY_STATES`.

### 3.3 The payment link

Three columns on `transactions`, or a side table if you would rather keep the row
narrow — the current in-repo shape is a nested `checkout` object on the record, so
either is a faithful translation.

| Column | Notes |
| --- | --- |
| `checkout_token` | 16 random bytes as hex. Unique, indexed by the constraint |
| `checkout_expires_at` | Fixed at creation: `created_at + interval '24 hours'` |
| `checkout_opened_at` | Set on the first successful render. Idempotent |

Four rules, each of which exists because breaking it causes a specific failure:

1. **The token is not the public reference.** `VSP-0007` is sequential and
   guessable; a link built from it lets anyone enumerate live deals. Generate with
   `randomBytes(16)`, never from the reference sequence.
2. **`checkout_expires_at` is written once and never updated.** A link that can be
   revived after it expired is a link that never really expired, and the buyer who
   was told to ask for a new one now has two.
3. **Never rotate the token.** A rotated token 404s a link already sitting in
   somebody's WhatsApp thread, and nothing tells the seller which one died. The
   answer to an expired link is a **new transaction with a new link**, or an
   explicit operator action recorded in `audit_log`.
4. **Availability is decided by state first, clock second.** A link on a `FUNDED`
   or `CANCELLED` transaction is reported as paid or closed, never as expired —
   telling a buyer to ask for a new link for money they already sent is the worse
   lie. `checkoutAvailability()` in `domain/checkout.ts` implements this and must
   be preserved in the service, not reimplemented per endpoint.

A record with no checkout is **closed**, never open by default, so a partially
migrated table cannot accidentally serve a live-looking page. A malformed
`checkout_expires_at` is also closed.

The escrow account the buyer transfers to is configuration, not data:

```env
VERISPON_ESCROW_BANK=
VERISPON_ESCROW_ACCOUNT_NUMBER=
VERISPON_ESCROW_ACCOUNT_NAME=
```

All three or none. With any one missing, the checkout page shows **no account
number at all** and tells the buyer to wait for instructions from Verispon. A
plausible-looking number with no name beside it is worse than no number: it is how
a transfer becomes unrecoverable. See `lib/payout-config.ts`.

Note what the checkout page deliberately does **not** do: it cannot mark a
transaction `FUNDED`. `FUNDED` is engine-only, because "the money arrived" is a
fact about a bank, not something a browser may assert. The page reviews the deal
and states where to send the money; the settlement webhook in §8.1 is what moves
the state.

### 3.4 Timeline, evidence, delivery events, disputes

```sql
create table transaction_events (
  id             bigserial primary key,
  transaction_id uuid not null references transactions(id) on delete cascade,
  state          transaction_state not null,
  actor          text not null check (actor in ('buyer','seller','system','admin')),
  actor_account_id uuid references accounts(id),
  note           text,
  at             timestamptz not null default now()
);
create index transaction_events_tx_idx on transaction_events (transaction_id, at);

create type evidence_type as enum (
  'ITEM_BEFORE_TRANSACTION','ITEM_PACKAGING','ITEM_HANDOVER','ITEM_SHIPMENT',
  'DELIVERY','ITEM_RECEIVED','ITEM_DAMAGED','RECEIPT','DOCUMENT','OTHER'
);
create type evidence_stage as enum (
  'before_payment','payment','fulfillment','dispatch','delivery',
  'receipt','confirmation','dispute'
);

create table evidence (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  type           evidence_type not null,
  stage          evidence_stage not null,
  uploader_id    uuid not null references accounts(id),
  uploader_name  text not null,
  storage_key    text not null,             -- object key, never a local path
  content_type   text not null,
  bytes          integer not null check (bytes > 0),
  checksum       text,                      -- sha256 of the original
  description    text check (description is null or length(description) <= 280),
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index evidence_tx_idx on evidence (transaction_id, created_at);

create type tracking_event_type as enum (
  'PICKED_UP','IN_TRANSIT','ARRIVED','DELIVERED',
  'UNABLE_TO_DELIVER','RETURNING','RETURNED'
);

create table delivery_events (
  id             bigserial primary key,
  transaction_id uuid not null references transactions(id) on delete cascade,
  type           tracking_event_type not null,
  reason         text,
  location       text,
  rider_verified boolean not null default false,
  reported_by    text not null check (reported_by in ('seller','buyer','rider','system')),
  at             timestamptz not null default now()
);
create index delivery_events_tx_idx on delivery_events (transaction_id, at);

create type dispute_reason as enum (
  'ITEM_NOT_AS_DESCRIBED','ITEM_NOT_RECEIVED','ITEM_DAMAGED',
  'PAYMENT_PROBLEM','DELIVERY_PROBLEM','OTHER'
);
create type dispute_status as enum (
  'OPEN','UNDER_REVIEW','RESOLVED_RELEASE','RESOLVED_REFUND','RESOLVED_PARTIAL'
);

create table disputes (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references transactions(id) on delete cascade,
  reason         dispute_reason not null,
  summary        text not null check (length(summary) between 20 and 2000),
  opened_by      uuid not null references accounts(id),
  opened_by_role text not null check (opened_by_role = 'buyer'),
  status         dispute_status not null default 'OPEN',
  resolution     text,
  refund_kobo    bigint check (refund_kobo is null or refund_kobo >= 0),
  opened_at      timestamptz not null default now(),
  resolved_at    timestamptz,
  resolved_by    uuid references accounts(id)
);
create index disputes_open_idx on disputes (status) where status in ('OPEN','UNDER_REVIEW');
```

`opened_by_role` is constrained to `'buyer'` in the database, not only in the
service. A seller raising a dispute would let them withhold money they are owed;
the seller answers with evidence instead.

The `transaction_id` unique constraint enforces one dispute per transaction. The
domain's `canRaiseDispute` also refuses a second dispute after one was resolved,
which is an appeal path this product does not model.

### 3.5 Double-entry ledger

This is the core of the design. An escrow balance is not a mutable number; it is
the sum of postings against a control account. The transaction row carries the
same figure for read performance, and a reconciliation query proves the two
agree.

```sql
create type ledger_account as enum (
  'escrow_cash',            -- liability: money held on behalf of transactions
  'buyer_fee_revenue',      -- revenue: buyer fees
  'seller_fee_revenue',     -- revenue: seller fees
  'seller_payable',         -- liability: released but not yet paid out
  'refund_payable',         -- liability: refunded but not yet paid out
  'platform_equity',        -- equity: retained fees net of anything refunded
  'external_cash',          -- asset: the banking partner's settlement account
  'payout_clearing'         -- asset: money sent to sellers or buyers, in flight
);

create table ledger_accounts (
  account     ledger_account primary key,
  currency    char(3) not null default 'NGN',
  kind        text not null check (kind in ('asset','liability','equity','revenue')),
  description text not null
);

create table ledger_entries (
  id             bigserial primary key,
  group_id       uuid not null,             -- all legs of one posting share this
  transaction_id uuid references transactions(id),
  account        ledger_account not null,
  direction      char(1) not null check (direction in ('D','C')),
  amount_kobo    bigint not null check (amount_kobo > 0),
  memo           text,
  actor          text not null check (actor in ('buyer','seller','system','admin')),
  created_at     timestamptz not null default now(),
  constraint no_zero_postings check (amount_kobo > 0)
);
create index ledger_entries_tx_idx on ledger_entries (transaction_id);
create index ledger_entries_group_idx on ledger_entries (group_id);
```

Five core accounts plus the three control accounts. The five named in the design
decisions — `escrow_cash`, `seller_payable`, `buyer_fee_revenue`,
`seller_fee_revenue`, `refund_payable` — carry the escrow lifecycle. The others
exist so that money entering and leaving the platform is also balanced.

**Balance rules, enforced in the service inside the same database transaction:**

- Sum of `D` equals sum of `C` across every `group_id`.
- `escrow_cash` for a transaction never goes negative. A release or refund that
  would overdraw it is rejected with `VALIDATION`.
- `refund_kobo` may never exceed `escrow_cash` for that transaction at the time of
  the refund.
- The fee accounts accept no manual postings. Fees arise only from the frozen
  schedule at funding time.

```sql
-- Reconciliation: the amount still held in escrow must equal the residual
-- postings. After a partial refund the residual is A - R, hence refunded_kobo.
-- The state guard matters: once a transaction is settled the money has left
-- escrow entirely, so the expectation is 0 even though refunded_kobo is still 0
-- for a release. Without the guard this query reports every released and
-- completed transaction as a mismatch. See sql/reconciliation.sql, which is
-- the version the scheduled job runs.
select t.id,
       case
         when t.state in ('FUNDED','SELLER_PROCESSING','SHIPPED','DELIVERED','BUYER_INSPECTION',
                          'DELIVERY_FAILED','RETURN_IN_PROGRESS','DISPUTED','UNDER_REVIEW','PARTIALLY_REFUNDED')
           then t.amount_kobo - t.refunded_kobo
         else 0
       end as expected_held,
       coalesce(sum(case when l.account = 'escrow_cash' and l.direction = 'C'
                       then l.amount_kobo
                       when l.account = 'escrow_cash' and l.direction = 'D'
                       then -l.amount_kobo
                       else 0 end), 0) as posted_held
from transactions t
left join ledger_entries l on l.transaction_id = t.id
group by t.id, t.state, t.amount_kobo, t.refunded_kobo
having case
         when t.state in ('FUNDED','SELLER_PROCESSING','SHIPPED','DELIVERED','BUYER_INSPECTION',
                          'DELIVERY_FAILED','RETURN_IN_PROGRESS','DISPUTED','UNDER_REVIEW','PARTIALLY_REFUNDED')
           then t.amount_kobo - t.refunded_kobo
         else 0
       end <> coalesce(sum(case when l.account = 'escrow_cash' and l.direction = 'C'
                       then l.amount_kobo
                       when l.account = 'escrow_cash' and l.direction = 'D'
                       then -l.amount_kobo
                       else 0 end), 0);
```

A second invariant, on release: a transaction in `RELEASED` or `COMPLETED` must
post no `escrow_cash` at all.

```sql
select t.id, t.state, sum(l.amount_kobo) as still_held
from transactions t
join ledger_entries l on l.transaction_id = t.id and l.account = 'escrow_cash'
where t.state in ('RELEASED', 'COMPLETED')
group by t.id, t.state
having sum(l.amount_kobo) > 0;
```

Both queries returning zero rows is the release gate. A transaction whose cached
figures disagree with its postings is a bug, and the mismatch must page someone
rather than be silently reconciled.

### 3.6 Idempotency and outbox

```sql
create table idempotency_keys (
  key          text not null,
  account_id   uuid not null references accounts(id),
  endpoint     text not null,
  request_hash text not null,                -- sha256 of the canonical body
  response     jsonb,                        -- replayed verbatim on retry
  status       text not null check (status in ('IN_FLIGHT','COMPLETED')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',
  primary key (key, account_id, endpoint)
);

create table outbox_events (
  id             bigserial primary key,
  topic          text not null,              -- 'transaction.state_changed', etc.
  transaction_id uuid references transactions(id),
  payload        jsonb not null,
  attempts       integer not null default 0,
  available_at   timestamptz not null default now(),
  delivered_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index outbox_pending_idx on outbox_events (available_at)
  where delivered_at is null;
```

Every mutation endpoint accepts an `Idempotency-Key` header. A repeat with the
same key and the same body hash replays the stored response; a repeat with a
different body returns `409`. Retrying a payment or a release must not be able to
double-post.

`outbox_events` is written in the same transaction as the state change and the
ledger postings. A worker drains it. Without it, a WhatsApp message is sent
inline and a failing provider rolls back a financial transaction that already
happened.

### 3.7 Audit

```sql
create table audit_log (
  id            bigserial primary key,
  actor_id      uuid references accounts(id),
  actor_role    text,
  action        text not null,               -- 'dispute.resolve', 'account.admin_grant'
  target_type   text not null,
  target_id     text not null,
  before        jsonb,
  after         jsonb,
  ip            inet,
  user_agent    text,
  at            timestamptz not null default now()
);
create index audit_target_idx on audit_log (target_type, target_id, at desc);
```

Admin actions are append-only. No update or delete path exists, enforced by
revoking those privileges from the application role.

---

## 4. Escrow state machine

### 4.1 States

Happy path: `CREATED → AWAITING_BUYER_VERIFICATION → AWAITING_PAYMENT → FUNDED →
SELLER_PROCESSING → SHIPPED → DELIVERED → BUYER_INSPECTION → RELEASED → COMPLETED`

Exceptions: `CANCELLED`, `DELIVERY_FAILED`, `RETURN_IN_PROGRESS`, `DISPUTED`,
`UNDER_REVIEW`, `REFUNDED`, `PARTIALLY_REFUNDED`.

Terminal: `COMPLETED`, `CANCELLED`, `REFUNDED`. `PARTIALLY_REFUNDED` is
deliberately not terminal — the remainder is still releasable, so the transaction
continues to `RELEASED`.

Funds are held in: `FUNDED`, `SELLER_PROCESSING`, `SHIPPED`, `DELIVERED`,
`BUYER_INSPECTION`, `DISPUTED`, `UNDER_REVIEW`, `RETURN_IN_PROGRESS`,
`DELIVERY_FAILED`.

`DELIVERY_FAILED` is a funds-holding state. A failed delivery does not move
money. It opens a choice between a retry, a return to the seller, or a review.
Auto-refunding on failed delivery would let a seller force a refund by losing a
parcel.

The transition map is the `TRANSITIONS` record in `src/domain/transaction.ts` and
is unchanged by this design. The database does not enforce it; a trigger would
duplicate the domain rule in a second language. The service enforces it, and the
engine is the only writer.

### 4.2 Who may cause each transition

| Transition | Actor | Notes |
| --- | --- | --- |
| `CREATED → AWAITING_BUYER_VERIFICATION` | seller | Sends terms |
| `AWAITING_BUYER_VERIFICATION → AWAITING_PAYMENT` | buyer | Verified terms |
| `AWAITING_PAYMENT → FUNDED` | **engine only** | Banking partner confirmation |
| `FUNDED → SELLER_PROCESSING` | seller | Begins fulfilment |
| `SELLER_PROCESSING → SHIPPED` | seller | Rider code verified |
| `SHIPPED → DELIVERED` | **engine only** | Delivery event |
| `DELIVERED → BUYER_INSPECTION` | buyer | Opens inspection |
| `BUYER_INSPECTION → RELEASED` | **buyer** | The authorisation |
| `RELEASED → COMPLETED` | **engine only** | Payout settlement confirmed |
| any held → `DISPUTED` | buyer | Only the buyer; see §7.4 |
| `DISPUTED → UNDER_REVIEW` | **engine only** | Assessment starts |
| `UNDER_REVIEW → RELEASED` | **engine only** | Resolution: release |
| `UNDER_REVIEW → REFUNDED` | **engine only** | Resolution: full refund |
| `UNDER_REVIEW → PARTIALLY_REFUNDED` | **engine only** | Resolution: split |
| `PARTIALLY_REFUNDED → RELEASED` | **engine only** | Remainder released |
| `→ CANCELLED` | seller or buyer | Pre-funding only |
| `→ DELIVERY_FAILED` | engine / seller | Delivery outcome |
| `→ RETURN_IN_PROGRESS` | engine | Return arranged |
| `→ REFUNDED` (pre-dispute) | **engine only** | Settlement decision |

`RELEASED` is deliberately *not* engine-only. The buyer's confirmation is the
authorisation; the engine then authorises the payout. Making it engine-only would
leave a buyer with no way to complete a good transaction. Auto-release after the
inspection window is an engine action, but it is a worker running the same
code path the buyer's button runs, not a separate rule.

### 4.3 Ledger postings per transition

Amounts in kobo. `A` = `amount_kobo`, `BF` = `buyer_fee_kobo`,
`SF` = `seller_fee_kobo`.

**Payment confirmed → `FUNDED`** (group G1)

| Account | D | C |
| --- | --- | --- |
| `external_cash` | `A + BF` | |
| `escrow_cash` | | `A` |
| `buyer_fee_revenue` | | `BF` |

Money has arrived and is now held. The buyer's fee is recognised immediately:
the service was performed, and reversing it later on a refund is a separate
decision, not a correction.

**Buyer confirms → `RELEASED`** (group G2)

| Account | D | C |
| --- | --- | --- |
| `escrow_cash` | `A` | |
| `seller_payable` | | `A - SF` |
| `seller_fee_revenue` | | `SF` |

**Payout settled → `COMPLETED`** (group G3)

| Account | D | C |
| --- | --- | --- |
| `seller_payable` | `A - SF` | |
| `payout_clearing` | | `A - SF` |

**Full refund → `REFUNDED`** (group G4)

| Account | D | C |
| --- | --- | --- |
| `escrow_cash` | `A` | |
| `refund_payable` | | `A` |
| `buyer_fee_revenue` | `BF` | |
| `platform_equity` | | `BF` |

**Refund disbursed** (group G5)

| Account | D | C |
| --- | --- | --- |
| `refund_payable` | `A` | |
| `external_cash` | | `A` |

**Partial refund of `R`** where `0 < R < A` (group G6)

| Account | D | C |
| --- | --- | --- |
| `escrow_cash` | `R` | |
| `refund_payable` | | `R` |
| `platform_equity` | `BF` | |
| `buyer_fee_revenue` | | `BF` |

then the remainder is released by G2 with `A - R` as the principal.

**Cancellation before funding** — no postings. Nothing was ever held, so there is
nothing to post. Writing zero-amount entries is noise; `amount_kobo > 0` is
checked on every row.

`DELIVERY_FAILED`, `DISPUTED`, `UNDER_REVIEW`, `RETURN_IN_PROGRESS` and
`BUYER_INSPECTION` all write **no** postings. The money is sitting in
`escrow_cash` and stays there until an outcome is decided. The state change and
its `transaction_events` row are still written, so the timeline is complete even
though the ledger is silent.

Every transition that moves money performs: lock the transaction row, validate
the transition, write the postings, update the state, append the timeline entry,
append the outbox event, and commit. One `BEGIN`/`COMMIT`, or nothing happened.

---

## 5. Fees

Published schedule, from `src/domain/money.ts`, and the single source of truth for
the landing page, the dashboard, and this document.

- Currency: `NGN`
- Buyer fee: `2%`
- Seller fee: `1%`
- Cap: `1_000_000` kobo (₦10,000) per side, per transaction
- `fee = min(round(amount × rate), FEE_CAP_KOBO)`

`round`, not `floor`: a kobo is the smallest amount that exists, and truncating
would systematically shave a kobo from the seller on every transaction.

### Worked examples

| Amount | Buyer fee | Buyer pays | Seller fee | Seller receives |
| --- | --- | --- | --- | --- |
| ₦5,000 (500,000) | ₦100 | ₦5,100 | ₦50 | ₦4,950 |
| ₦50,000 (5,000,000) | ₦1,000 | ₦51,000 | ₦500 | ₦49,500 |
| ₦500,000 (50,000,000) | ₦10,000 *(capped)* | ₦510,000 | ₦5,000 | ₦495,000 |
| ₦1,000,000 (100,000,000) | ₦10,000 *(capped)* | ₦1,010,000 | ₦10,000 *(capped)* | ₦990,000 |

At ₦500,000 the buyer fee reaches the cap exactly. Above it, the fee is flat: the
schedule is a ceiling on what Verispon may charge, not a margin that scales.

### Decision: the buyer fee is never refunded

**Settled by the business owner. The buyer fee is unrefundable, and the principal
is refunded when delivery is cancelled.** The two halves are separate amounts and
only one of them comes back.

| Amount | On delivery cancelled | On dispute lost | On dispute split | On success |
| --- | --- | --- | --- | --- |
| Principal `A` | Refunded to the buyer | Refunded to the buyer | `R` refunded, `A - R` released | Paid to the seller |
| Buyer fee `BF` | **Retained by Verispon** | **Retained by Verispon** | **Retained in full** | Earned |

So a buyer whose delivery is cancelled receives exactly `A`. They do not receive
`A + BF`, and a partial refund does not prorate the fee either: the full `BF` is
retained on every refund path. `BF` is recognised as revenue at funding (G1) and
is never reversed. On a full refund G4 moves it from `buyer_fee_revenue` to
`platform_equity`; on a partial refund G6 does the same for the whole `BF`. The
posting matrix above already implements this, so no ledger change is required —
what changes is that it is no longer provisional.

**The fee is charged on the transaction, not on success.** Verispon has already
done the work of holding and inspecting the funds by the time any refund is
raised, and the assessment work a dispute generates is the business's largest
cost. A fee that returned on every failed outcome would leave Verispon paying to
be the worse party in a transaction it never completed.

Two obligations follow from this, and both are copy, not schema:

- The buyer must be told the fee is non-refundable **before** they pay, at the
  payment step, not in a footer after the fact. "Total to pay" on its own does
  not disclose it.
- The same statement must appear wherever a total is shown to a buyer — the
  payment link, the checkout, and the transaction summary — so the amount is
  never a surprise at the point of cancellation.

Note the fee is retained even when the **seller** cancels. The buyer gets `A` back
and has lost `BF` for a transaction they did nothing wrong. This is intended: the
fee buys escrow of the funds regardless of who caused the cancellation, and
retaining it is what stops cancellation from being a free option for a buyer who
simply changes their mind.

#### What counts as "delivery cancelled"

**Only cancellation before dispatch refunds automatically.** Confirmed by the
business owner. The precise boundary:

| Situation | State | Money |
| --- | --- | --- |
| Cancelled before funding | `CANCELLED` | Nothing was held. No postings |
| Cancelled after funding, **item still with the seller** | `CANCELLED` | **Refunded in full — this is "delivery cancelled"** |
| Delivery attempt fails, item in transit | `DELIVERY_FAILED` | **Funds held. No refund** |
| Item returned to the seller | `RETURN_IN_PROGRESS → REFUNDED` | Refunded, via an engine step |

`DELIVERY_FAILED` is not a cancellation and does not refund. A failed attempt is
a recoverable event, and refunding on it would let a seller manufacture a refund by
failing to deliver — the seller loses nothing by losing a parcel, and the buyer
loses the fee as well as the deal. A failed delivery opens a choice between a
retry, a return, and a dispute; the refund happens when the **return** completes,
not when the delivery fails.

This is why the `CANCELLED` transitions from `FUNDED` and `SELLER_PROCESSING` are
the refund-on-cancel path, and why `DELIVERY_FAILED` is in `FUND_HOLDING_STATES`
alongside the happy-path states rather than beside `CANCELLED`.

---

## 6. HTTP API

`API.md` is the normative wire contract — every route, shape and status code. This
section states only the decisions behind it, so the two cannot drift without it
being obvious.

### 6.1 Conventions

- JSON bodies, `camelCase` on the wire **matching the domain types**. Not
  `snake_case`: there is one casing, not two with a converter between them. SQL
  columns are `snake_case` and the mapping lives inside the repository
  implementation, below the API.
- All money fields are integers named `*Kobo`. Never a float, never a formatted
  string. The single exception is the create endpoint's `amount`, which is a
  **string** because a human types it on a phone keypad; it is parsed server-side
  and anything with more than two decimals is rejected rather than rounded.
- All timestamps are ISO-8601 UTC with an explicit `Z`.
- Errors are a flat `{ "error": string }`. No code, no field map. An unexpected
  failure is logged server-side and reported generically, so an internal message
  never leaks through the API.
- Unauthenticated: `401`. Not a party: `404`. Engine-only transition requested:
  `403`. Illegal transition: `409`. Validation: `400`.
- **Idempotency-Key is specified but not implemented.** See §3.6.

### 6.2 Authentication

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create an account |
| `POST` | `/api/auth/login` | Sign in with phone or email + passcode |
| `POST` | `/api/auth/logout` | Clear the session |
| `POST` | `/api/auth/recover` | Issue a six-digit recovery code over WhatsApp |
| `POST` | `/api/auth/recover/verify` | Verify the code, set a new passcode |

Sessions are a signed HMAC cookie (`verispon_session`, 7 days,
`HttpOnly`, `SameSite=Lax`, `Secure` in production). The payload carries
`accountId`, `issuedAt`, and `roles`; the account is re-read on every request so a
revoked or deleted account stops working immediately without a revocation list.

`roles` in the cookie is a rendering convenience and is **never** trusted for
authorisation.

`SESSION_SECRET` must be at least 32 characters. In production without it, every
session is rejected — a misconfigured deployment fails closed.

`ADMIN` is not assignable through `register`; `SELF_ASSIGNABLE_ROLES` is
`["BUYER", "SELLER"]`. It is granted by an operator script that writes to
`audit_log`.

### 6.3 Transactions

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/transactions` | List the caller's transactions |
| `POST` | `/api/transactions` | Open a transaction |
| `GET` | `/api/transactions/:id` | Read one transaction |
| `POST` | `/api/transactions/:id/transition` | Request a state change |
| `GET`/`PUT`/`DELETE` | `/api/transactions/:id/evidence` | List, upload, remove evidence |
| `POST` | `/api/transactions/:id/dispute` | Open a dispute |
| `GET` | `/api/evidence/:transactionId/:filename` | Stream a stored file |
| — | `/checkout/:token` | Buyer payment page. A page, not an API route |

Two things this table used to get wrong, both now corrected in code and here:

- Evidence upload is **`PUT` with `multipart/form-data`**, not `POST` with JSON.
  Multipart because a browser file input produces it directly; base64 inflates
  every byte by a third, which the 50 MB submission limit cannot absorb.
- There is **no `/dispute/response` route**. A seller answers a dispute by adding
  evidence through the same evidence endpoint. A `POST` on `/evidence` also opens a
  dispute, which predates `/dispute`; it is legacy, keep it working, and prefer
  `/dispute` for its better refusal messages.

**`GET /api/transactions`**

Query: `state` (repeatable), `search`, `limit` (default 20, max 100), `offset`.

Scope is derived from the session, never from a query parameter. The repository
query takes `accountId` and filters on `buyer_account_id = $1 or
seller_account_id = $1`.

```json
{
  "transactions": [ /* TransactionRecord */ ],
  "total": 6
}
```

`checkout.token` appears in this response. That is safe because the route is
scoped to parties, and it is exactly why §3.3 forbids reusing this payload for
anything wider.

**`POST /api/transactions`**

```json
{
  "title": "Black shoe, size 42",
  "description": "Genuine leather, worn twice.",
  "amount": "20,000",
  "counterpartyReference": "VSP-A-0001",
  "photosEnabled": true,
  "delivery": {
    "method": "SELLER_RIDER",
    "pickupAddress": "University of Lagos",
    "destinationAddress": "14 Glover Road, Lagos",
    "deliveryWindow": "Tuesday morning"
  }
}
```

`photosEnabled` is optional and defaults to `false`. It turns on the condition-photo
pair described in §6.3: the before photo then gates the transition into
`AWAITING_PAYMENT`, and the after photo is prompted at `receipt`. It is accepted
from **either** role, because either side may be the one documenting the item, and
it names no counterparty field — the flag is about the transaction, not the parties.
The `delivery` object remains seller-only; a buyer sending one is ignored, not
rejected, so a shared form does not fail for a dual-role account.

**Either side may open a transaction, and the roles come from the account, not the
request.** A `SELLER` opening one is recorded as its seller; a `BUYER` opening one
is recorded as its buyer. An account holding both roles opens as the **buyer**,
because it is the side asking for goods and the side whose money will be held. The
repository decides this from `initiator.roles`; the client sends no party id and
cannot choose.

This is the single most important thing to get right in the implementation, so the
reasoning is explicit. The deal runs the same way round either way — the buyer
always pays into escrow and the seller always delivers — so which side opened it
changes only the wording and the fee. Deriving the roles from the account rather
than from who clicked means there is no code path where a seller-opened
transaction is recorded as a purchase.

Consequences the service must preserve:

- The client sends a **reference**, never a party id, and the counterparty is
  resolved from it. A client cannot open a transaction against someone who has not
  agreed to be on it.
- The counterparty cannot be the session account, and the **initiator** must be
  verified on at least one channel.
- **`delivery` is read only when the initiator is a seller.** A buyer has not
  agreed a pickup or a window, so their delivery input is dropped rather than
  rejected — and definitely not recorded, which would put words in the seller's
  mouth. Rejecting it would teach buyers that the field exists and then refuse it.
- Response `201` with the created record, including its `checkout` link. Fees are
  computed server-side and frozen onto the row; a client sending `buyerFeeKobo` is
  ignored.
- The same validators run server-side as in the browser — `validateDraft`,
  `validateDeliveryDraft` — and the server's copy decides.

**`GET /api/transactions/:id`**

Accepts a uuid or a public reference. Returns `404` when the account is not a
party. A party sees:

```json
{
  "id": "…",
  "reference": "VSP-0007",
  "state": "BUYER_INSPECTION",
  "counterparty": { "id": "…", "reference": "VSP-A-0002", "name": "Kola Studio", "verified": true },
  "viewerRole": "seller",
  "fees": { "amountKobo": 125000000, "buyerFeeKobo": 2500000, "sellerFeeKobo": 1250000, "buyerTotalKobo": 127500000, "sellerNetKobo": 123750000 },
  "delivery": { "method": "SELLER_RIDER", "riderVerifiedAt": "…", "events": [ { "type": "DELIVERED", "at": "…" } ] },
  "checkout": { "token": "…", "expiresAt": "…", "openedAt": "…" },
  "evidence": [ /* … */ ],
  "dispute": null,
  "timeline": [ { "state": "…", "at": "…", "actor": "system" } ],
  "actions": [ { "id": "CONFIRM_RECEIPT", "to": "RELEASED", "label": "…" } ]
}
```

Two rules that are not obvious from the shape:

- **The counterparty carries no contact details.** Not a phone, not an email.
  Both parties transact through Verispon and communicate on WhatsApp; exposing
  contact details in the dashboard would defeat the record and invite
  settlement outside the platform.
- **A party's own fee is shown, the other party's fee is not.** The buyer sees
  the buyer fee because they pay it. Seeing the seller fee would let a buyer
  infer a ceiling and negotiate against a number they should not know.

`actions` is derived server-side from the caller's role and the current state, so
a crafted client cannot render a button the server would refuse. Deriving it is
not authorisation — the transition route re-checks independently — but it keeps
the UI honest.

**`POST /api/transactions/:id/transition`**

```json
{ "to": "RELEASED", "note": "Item as described." }
```

The route:
1. Resolves the session account. No body field may identify the actor.
2. Loads the transaction. `404` if the account is not a party.
3. Rejects `to` when `isEngineOnly(to)` — **`403`**. A client asking for `FUNDED`,
   `COMPLETED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `UNDER_REVIEW` or
   `RETURN_IN_PROGRESS` is refused however it phrases the request.
4. Calls the engine, which re-validates the transition against the current state
   under a row lock, rejects a repeat of the current state, and writes the
   postings.

The engine uses the actor's **role on this transaction**, not the account's roles.
An account holding both roles is the buyer on a transaction it opened and the
seller on one it did not, and conflating the two is how a dual-role account ends up
authorising the wrong side of its own deal.

A repeat of a state already held is `409`. A concurrent double-submit is serialised
by the row lock, so the second one loses the race and is rejected cleanly rather
than posting twice.

**`PUT /api/transactions/:id/evidence`**

`multipart/form-data`: `files` (repeatable), a `type`, an optional `description`.
Validated against `validateEvidenceSubmission`: 5 images per submission, 5 MB per
image, 10 MB per PDF, 25 MB per video, 50 MB total, and a content-type allowlist of
JPEG/PNG/WebP/PDF/MP4/QuickTime/WebM. The declared content type is **not trusted**;
the decoded bytes are what is size-checked and what is written. The client filename
is never used as a path segment.

`description` is currently **not length-checked server-side** — the UI caps it at
280. Add a `check` before trusting it.

Evidence is keyed by transaction id, so it cannot be attached before the
transaction exists. The new-transaction flow therefore creates, then uploads, and
treats an upload failure as a warning rather than a rollback: the deal is real, and
the condition photos can be added from the transaction page whenever they are
taken.

`GET` on this path lists evidence plus the stage the current state expects.
`DELETE` removes one item, permitted only to its uploader and only before
`RELEASED` or `COMPLETED` — once money has moved, the record of what was submitted
is the record of what was agreed, and deleting it would let the evidence trail be
rewritten.

#### Condition photos: before and after

A settled feature, not a stray enum value. When a transaction is created with
`photosEnabled`, two photographs are taken and compared:

| Photo | Type | Stage | Taken by | When |
| --- | --- | --- | --- | --- |
| Before | `ITEM_BEFORE_TRANSACTION` | `before_payment` | Seller | Before the buyer pays |
| After | `ITEM_RECEIVED` | `receipt` | Buyer | On arrival, at receipt |

The point of the pair is one question: **did the buyer receive the same item that
was photographed before payment?** The before photo is the reference, the after
photo is the observation, and the comparison is what a dispute is argued over.

**`photos_enabled` defaults to `false`, and the flag is set by whoever creates the
transaction.** It is part of the create payload and is stored on the transaction,
because "should this deal have condition photos" is a property of the deal, not a
global setting. A seller creating with `photosEnabled: true` is asking for the
extra protection; one creating without it gets the simpler flow.

**When the flag is on, the before photo gates payment.** It is enforced on the
transition into `AWAITING_PAYMENT`, not at creation — the transaction exists, the
seller can see the buyer's payment link, and the missing photo is visible on the
transaction page rather than a rejected form. When the flag is off the photo
stays a suggestion and nothing is blocked.

This is the first place `requiredEvidenceForStage` is actually read. It is a real
gate, and it is conditional: `requiredEvidenceForStage('before_payment')` returns
`ITEM_BEFORE_TRANSACTION` and the guard applies it only when
`transaction.photos_enabled` is true. The after photo is a prompt at `receipt` and
is **not** a gate — by that point the money is already held and the deal is
running, and blocking the buyer's confirmation on a camera roll would strand funds.

**A mismatch is evidence, never a trigger.** If the before and after photos do not
match, nothing happens automatically: no refund, no state change, no penalty. The
mismatch is recorded and Verispon reviews it with both parties during dispute
assessment. This is deliberate and it is the safe side of the choice. An automatic
refund on mismatch would hand the item-condition question to two photographs, and
a buyer could claim a mismatch on any delivery at all. The pair of photos is
evidence for a human decision, which is the only thing it is fit to be.

**`POST /api/transactions/:id/dispute`**

```json
{ "reason": "ITEM_NOT_AS_DESCRIBED", "summary": "…" }
```

`openedBy` comes from the session. There is no body field for it, and there is
never going to be one. A summary of 20 to 2000 characters is required, not
optional: a dispute is an assessment, and an assessment needs the party's
account. A reason alone would put the burden of reconstructing the complaint on
Verispon.

Returns `201`, moves the transaction to `DISPUTED`, and pauses release. The
response body and the UI both say plainly that this pauses the payout and is not
a refund. A dispute that only *looked* like a refund button would produce a
support load and a bad review.

Refusals are `409`, not `404`: the caller **is** a party here, so hiding the
existence of the transaction would be pointless, and the reason is worth telling
them. A seller gets `"Only the buyer raises a dispute…"`. A buyer on a transaction
with nothing held gets `"There is nothing to dispute here…"`.

### 6.4 The payment link page

`GET /checkout/:token` is a **page**, not an API route: public, `noindex`, and
readable with no account, because the buyer may be paying for the first time. It
renders the item, the fee breakdown and total payable, what the money is protected
by, the delivery details if a seller supplied any, and a countdown.

It cannot mark a transaction `FUNDED`. See §3.3.

| Condition | Result |
| --- | --- |
| Token is not 32 lowercase hex | `404` |
| No transaction has that token | `404` |
| Otherwise | `200`, with the availability from §3.3 deciding which copy renders |

The first successful render stamps `checkout_opened_at`. It is idempotent and never
touches the state machine.

### 6.5 Endpoints that do not exist yet

| Endpoint | Purpose | Blocker |
| --- | --- | --- |
| `POST /api/internal/payments/confirm` | Banking partner webhook | Adapter needed. **Highest priority: nothing makes the escrow real without it** |
| `POST /api/internal/payouts/settle` | Payout settlement webhook | Adapter needed |
| `POST /api/internal/deliveries/events` | Rider or courier tracking event | Rider identity model |
| `POST /api/internal/disputes/:id/resolve` | Admin resolution | Admin authz |
| `GET`/`POST` | `/api/whatsapp` | Meta webhook. **The route does not exist** — see §8.2 |
| `GET`/`POST` | `/api/admin/*` | Console, capabilities, audit search |
| any mutation + `Idempotency-Key` | Replay protection | Table and middleware; see §3.6 |

These are internal: authenticated by a shared secret plus an allowlisted source
IP, never by a session cookie. A webhook signature that is not verified is a
public write endpoint with money attached.

---

## 7. Authentication and security

### 7.1 Passcodes

A six-digit passcode is a product decision, not a password: small enough to be
memorable over WhatsApp, usable on a phone keypad. It means 10^6 candidates, so
every control around it is load-bearing, not optional.

- Digest: `scrypt$N$r$p$salt$hash`, per-password random salt, `N = 2^17`, `r = 8`,
  `p = 1`. Parameters travel with the digest so they can be raised later without
  invalidating existing passcodes. Verification uses the stored parameters.
- A successful sign-in re-hashes with the current parameters, so a parameter
  increase migrates the population gradually instead of requiring a reset.
- Comparison is `timingSafeEqual`.

### 7.2 Throttling

A six-digit passcode is enumerable in hours without a ceiling on attempts. Scrypt
makes each guess expensive; it does not make the space unguessable. Throttling is
a correctness requirement.

| Scope | Window | Limit |
| --- | --- | --- |
| Failures per identifier | 15 min | 5 |
| Failures per source address | 15 min | 60 |
| Recovery sends per identifier | 1 hour | 3 |
| Recovery sends per address | 1 hour | 10 |

Namespaces are separate. Recovery-code guessing must not consume a sign-in
budget, or an attacker could burn a real user's sign-in allowance from the
recovery form.

The per-address cap is deliberately far higher than the per-identifier cap.
Nigerian mobile carriers put large numbers of subscribers behind a single NAT,
and offices and campuses share one egress address. A hard block on a small
per-address total is a denial of service against real users, not only against
attackers. The per-identifier cap does the precise work; the per-address cap
bounds distributed guessing throughput.

A successful sign-in clears the counter for that identifier.

Today this state lives in `globalThis` — one process, lost on restart, and
inconsistent across instances. It must move to Redis or Postgres before a second
instance exists. The same applies to `recovery-store.ts`: a code issued by one
instance is unverifiable by another, which is a hard blocker for horizontal
scaling and is called out here rather than papered over with a store that does
not exist.

### 7.3 Recovery

Six digits, ten minute life, one live code per account with older codes
invalidated, an attempt counter, and the code digest stored rather than the code.
Codes go over WhatsApp, which is why the send rate is limited separately from
verification attempts. An account with no phone cannot use recovery.

### 7.4 Authorisation

Enforced in the service layer, not in the route:

- The actor is always the session account. No request field may name an actor.
- Resource access is checked with `isPartyTo`, and a failure is a `404`.
- Capability access (`ADMIN`) is checked against roles re-read from the database.
- Engine-only transitions are refused before the engine is called, and the engine
  refuses them again.
- A seller cannot raise a dispute; a seller responds to one.
- Evidence upload is allowed for either party in any non-terminal state. It is
  always additive, and it is never a state transition.

### 7.5 Uploads

Content type sniffed from bytes, not trusted from the header. Size limits per kind.
Generated storage keys — never a client-supplied filename, and never a path that
is used to build a filesystem path. Files are served through an authenticated
route handler that re-checks party membership; a presigned object URL alone would
leak evidence to anyone who obtained the link, and evidence is the thing a
dispute is decided on.

Object storage replaces `uploads.ts`, which assumes a single writable filesystem
and does not survive a serverless deployment.

---

## 8. Integrations

### 8.1 Banking partner

Sequence:

1. Buyer requests payment in `AWAITING_PAYMENT`. The server creates a payment
   intent with the partner and returns the authorisation URL or the account
   details. No money moves yet.
2. The buyer pays. The partner settles.
3. **Webhook** → verify the signature → look up the idempotency key → if already
   processed, return `200` and change nothing → else in one transaction: lock the
   transaction, confirm the amount matches `buyer_total_kobo`, write G1, move to
   `FUNDED`, append the timeline entry, write the outbox event, commit.
4. Only then send the WhatsApp notification, from the outbox worker.

Webhook handling must be idempotent and must verify the amount. A callback
claiming ₦1 that settles ₦1,250,000 must be refused, not applied.

Release: the engine posts G2, instructs the partner, and waits for a settlement
confirmation before G3 and `COMPLETED`. `RELEASED` means the buyer's money is
released to the seller as a liability; `COMPLETED` means it actually left.
Collapsing the two would let the UI claim a payout that failed.

### 8.2 WhatsApp

**The inbound route does not exist.** There is no `src/app/api/whatsapp/route.ts`,
so Meta cannot reach Verispon today, and `WHATSAPP_BOT_PLAN.md` previously listed it
as Done. What exists in `src/lib/` is the machinery around it: payload parsing and
signature verification (`whatsapp-webhook.ts`), the outbound sender
(`meta-whatsapp.ts`), env config (`meta-config.ts`), and file-backed session and
escrow stores. `lib/escrow-transactions.ts`, also listed as Done, does not exist.

`lib/whatsapp-bot.ts` is **not** an integration. It is a ten-step keyword matcher
(`"dispatch"`, `"photos uploaded"`, `"item received in good condition"`) with its
own `step` field, its own `buyerDeliveryConfirmed` / `sellerDeliveryConfirmed`
booleans, and no relationship to `TransactionRecord`. It writes to
`window.localStorage` behind a `typeof window` guard, so a server invocation
persists nothing. Its notion of "released" is not `RELEASED` and does not post
anything.

When it is built:

- **The webhook route binds the existing pieces and nothing new.** Parse, verify
  the signature, dedupe on `wamid`, look up the session, call a service, reply.
- **Commands map to the services the web routes call**, not to raw state changes.
  "Confirm" from WhatsApp is the same call as `POST /transition { to: "RELEASED" }`,
  including the same authorisation and the same engine-only refusals. A WhatsApp
  command that can do something the dashboard cannot is a privilege escalation
  path.
- **Send the payment link, not a reference.** Once the link exists (§3.3), the
  outbound message is the one artefact that makes the bot useful: the buyer clicks
  `/checkout/<token>` and needs no account.
- Outbound messages are written to the outbox in the same transaction as the
  business event and sent by a worker. Never inline — a failing provider must not
  roll back a financial transaction that already happened.
- Consent and opt-out state is stored, and a stop message is honoured immediately
  and permanently.

### 8.3 Courier

`INTEGRATED_COURIER` is modelled and unavailable. The `available: false` flag and
`unavailableReason` exist because partner coverage and returns capability are not
confirmed, and presenting an unconfirmed option as live would be a promise
Verispon cannot keep.

`SELLER_RIDER` and `BUYER_ARRANGED` are live. The seller appoints and verifies the
rider's code before handover, so the handover record rests on a code both parties
saw rather than on an assertion. Verispon does not supply riders.

Rider identity is unresolved: a rider is not an account, and the model that lets
a rider post tracking events without becoming a user has not been decided.

---

## 9. Admin

Deferred. The console does not exist, and `SELF_ASSIGNABLE_ROLES` reflects that.

Required capabilities:

| Capability | Why |
| --- | --- |
| `disputes.read` | See open disputes with all evidence |
| `disputes.resolve` | Choose release, refund, or split |
| `transactions.read_all` | Read any transaction, not only one's own |
| `accounts.read` | Read accounts and verification state |
| `accounts.roles.grant` | Grant `ADMIN` out of band |
| `accounts.freeze` | Stop an account transacting without deleting history |
| `audit.read` | Search the audit log |

Design rules:

- Every admin action writes `audit_log` with before and after. Append-only; the
  application role has no `UPDATE` or `DELETE` on the table.
- Admin access is a role claim on the session, but the roles are re-read from the
  database on each request, so revoking a role takes effect immediately.
- Admin views are read-through to the same services. There is no second
  implementation of the state machine for admins; a dispute resolved in the
  console and a dispute resolved by a script must produce identical postings.
- Disputes are not auto-resolved. There is no heuristic that releases money after
  a timeout. A dispute that is not assessed holds funds and shows as held.

---

## 10. Background work

| Job | Trigger | Action |
| --- | --- | --- |
| `outbox-drain` | Every 5s | Send queued notifications |
| `auto-release` | Every 1 min | Release `BUYER_INSPECTION` rows past `auto_release_at` |
| `recovery-sweep` | Every 5 min | Drop expired recovery challenges |
| `reconciliation` | Hourly | Assert the ledger matches the cached figures |
| `stale-state` | Hourly | Flag transactions stuck in one state too long |

**Auto-release** is the important one and the one most likely to be built
carelessly. It must:

- Only touch `BUYER_INSPECTION` rows whose `auto_release_at` has passed.
- Skip any transaction with an open dispute, whatever the state says.
- Take the same row lock and call the same engine method as the buyer's
  confirmation button, not a parallel code path.
- Be idempotent, and safe to run twice concurrently.
- Never run in a state where a dispute was opened between the read and the write.
  The row lock plus the in-transaction dispute re-check is what prevents this.

Releasing a disputed transaction is the single most expensive bug available in
this system. It pays out money the buyer is contesting and there is no way to
recover it.

**Settlement of refunds and payouts** is a separate job from posting them.
Posting creates the liability; disbursing moves real money and needs a
reconciliation back from the partner.

---

## 11. What exists today

Verified against `apps/web/src`, not from memory.

| Capability | State |
| --- | --- |
| Domain model, transitions, fees, validation | Complete, unit tested |
| Repository interfaces | Complete |
| JSON repository | Complete, file-backed |
| Auth register/login/logout/recover | Working, in-process throttles |
| Transactions list/create/read/transition | Working |
| **Either side may open a transaction**, roles derived from the account | Working |
| **Delivery details at creation, seller only** | Working |
| **Payment link issued at creation, 24h expiry** | Working (`domain/checkout.ts`) |
| **Buyer checkout page `/checkout/:token`**, public, noindex | Working |
| **Escrow account config** | Working; **not set in any environment** |
| Evidence upload, list, remove | Working, local disk |
| Dispute open | Working, two routes (one legacy) |
| Dispute resolve | Repository method only, no route |
| Delivery methods and tracking events | Modelled; no write route |
| Dashboard UI | Rebuilt and verified |
| PostgreSQL schema | Not implemented |
| Ledger | Not implemented |
| Object storage | Not implemented |
| Banking adapter | Not implemented |
| WhatsApp webhook route | **Not implemented — the file does not exist** |
| WhatsApp bot logic | Keyword matcher only; not an integration |
| Courier integration | Modelled, unavailable |
| Admin console | Not implemented |
| Middleware route guard | Not implemented |
| Auto-release worker | Not implemented |
| Distributed throttling | Not implemented |
| Idempotency keys | **Not implemented** |

---

## 12. Build order

Each step is independently deployable and leaves the system in a working state.

1. **Schema and migrations.** Tables, enums, constraints, indexes — including
   `checkout_token`, `checkout_expires_at`, `checkout_opened_at` and the
   all-or-nothing constraint from §3.3. No code change yet; the JSON store still
   serves.
2. **Read path.** `PostgresTransactionRepository.list` and `findById`, behind the
   existing interface. Verify against the JSON store with the same fixtures.
3. **Ledger.** `ledger_accounts`, `ledger_entries`, the posting helper, the
   balance rules, and the reconciliation query. Unit-test the posting groups
   before anything calls them.
4. **Write path.** `create` and `transition` on Postgres, with the row lock, the
   idempotency table, and the outbox. This is the step where the engine becomes
   real. `create` must derive buyer/seller from the initiator's roles and issue the
   checkout token — see §6.3.
5. **Banking adapter** and the two settlement webhooks. This is what makes the
   escrow real rather than modelled, and it is the only thing standing between the
   current system and real money.
6. **Object storage.** Replace `uploads.ts`. Evidence is worthless if the link that
   decides a dispute breaks in eighteen months.
7. **Auto-release worker**, with the dispute re-check written first and tested by
   forcing the race.
8. **Admin resolution route** and the audit log, then the console.
9. **Distributed throttles.** Redis for the rate limiter and recovery store.
   Required before a second instance, and the second instance is what makes a
   webhook reliable.
10. **WhatsApp webhook route**, mapped to the existing services. With the payment
    link in place, the outbound message finally has something to send.
11. **Delivery write path** — rider verification, tracking events, failed delivery.
    Blocked on the rider identity decision (§14, item 2).
12. **Middleware route guard.** The dashboard layout guards the pages; the API
    routes must guard themselves.
13. **Reconciliation on a schedule**, alerting on a non-empty result.

Steps 1 to 5 are the critical path. Nothing after step 5 can be built honestly
without the ledger, because every later feature is a posting.

---

## 13. Testing strategy

- **Domain.** Exhaustive transition tests. For each state, assert exactly which
  `to` values are legal. This is the rule the whole system rests on, and it is
  pure, so it is cheap to test exhaustively.
- **Ledger.** For each posting group, assert debits equal credits, assert
  `escrow_cash` never goes negative, and assert the full lifecycle of one
  transaction leaves every account at an expected balance. A property test over
  random amounts asserting `sum(D) == sum(C)` for every group is worth more than
  any individual case.
- **Authorisation.** A matrix test: every endpoint × every role × party and
  non-party. Assert `404` for a non-party on every resource route, including
  the evidence streaming route, which is the one most likely to be missed.
- **Concurrency.** Two simultaneous `RELEASED` submissions. Assert exactly one
  posting group exists.
- **Auto-release.** A test that opens a dispute in the same tick the window
  expires. Assert no release. This test is the point of the feature.
- **Idempotency.** Replay every mutating request with the same key. Assert one
  state change, one posting group, and a byte-identical response.

---

## 14. Open decisions

These are not settled. Each one changes the schema or the postings, so each needs
an answer before the relevant step in §12.

1. **Rider identity.** Whether a rider gets a limited account or an authenticated
   tracking token. Blocks the delivery-events webhook.
2. **Auto-release window length.** Not specified. `auto_release_at` is computed at
   `DELIVERED`; the duration is a product decision.
3. **Dispute resolution SLA.** No timeout exists, deliberately. Whether an
   operational target should alert on ageing disputes is a separate question from
   whether a timeout should auto-resolve one. It should not.
4. **Partial refund split rules.** Whether the split is restricted to whole
   percentages of `A` or can be any kobo figure.
5. **Multi-currency.** The ledger has a `currency` column and the design assumes
   `NGN` only. A second currency means exchange rates at funding and at release,
   and a rate source that can be relied on later.
6. **What replaces an expired link.** Currently the answer is "ask the seller for a
   new one", and the only way to get one is a new transaction. Whether Verispon
   re-issues a link against the same transaction — and if so, whether the 24 hours
   restarts — is undecided. See §3.3 rule 3 for why rotating is not the answer.

**Closed since the last revision.** Three decisions that were open are now settled
by the business owner:

- **The buyer fee is retained** on every refund path, and the principal is refunded
  when delivery is cancelled. §5 is rewritten from two options to the decision, its
  two copy obligations, and an explicit table of which situations count as a
  cancellation.
- **Only pre-dispatch cancellation refunds automatically.** `DELIVERY_FAILED` holds
  funds and the refund happens on completion of the return. §5 states the boundary.
- **Condition photos are a feature.** `photos_enabled` is a new column and a new
  create-payload input; the before photo gates the transition into `AWAITING_PAYMENT`
  when the flag is on, the after photo is a prompt, and a mismatch between them is
  evidence for assessment rather than a trigger for money to move. §6.3 documents
  the whole thing.

---

## 15. What changed most recently

Recorded so the next reader can tell which parts of this document are load-bearing
and which describe a superseded design. The first three items were documented
incorrectly before this revision.

1. **The payment link did not appear anywhere in this document.** It is now the
   entry point of the whole funnel: created in step 1, rendered in step 5, and the
   only thing a WhatsApp message can usefully carry. §3.3 is new.
2. **The create endpoint was documented as seller-only**, with the buyer resolved
   from the reference and `amount_kobo` on the wire. Either side may now open a
   transaction, the roles are derived from the initiator's account, `amount` is a
   string, and `delivery` is accepted from sellers only. §6.3 is corrected.
3. **`POST /api/transactions/:id/dispute/response` does not exist.** Evidence upload
   is `PUT` with `multipart/form-data`; there is no separate dispute-response route.
   §6.3 and `API.md` §6 are corrected.
4. **`Idempotency-Key` is specified but not implemented.** A repeated `POST
   /api/transactions` creates a second transaction today. Flagged in §6.1 and §6.5
   rather than quietly presented as working.
5. **`/api/whatsapp` was listed as Done.** It does not exist, and neither does
   `lib/escrow-transactions.ts`. §8.2 and `API.md` §8 say so plainly.
6. Reference formats were given as `VSP-4821` for both accounts and transactions.
   Accounts are `VSP-A-0002`, transactions `VSP-0007`, disputes `DSP-0003`.
7. Errors were documented as a nested `{ error: { code, message, fields } }` object
   and validation as `422`. Both are wrong: the body is a flat `{ error: string }`
   and validation is `400`. See `API.md` §1.4 for the real mapping.
8. **Three open decisions are now closed by the business owner.** The buyer fee is
   unrefundable and the principal is refunded on cancellation, with the boundary
   stated explicitly: only pre-dispatch cancellation refunds, and `DELIVERY_FAILED`
   holds funds. Condition photos are a feature rather than a stray enum value — a
   `photos_enabled` column gates the transition into `AWAITING_PAYMENT` when set,
   the after photo is prompted, and a before/after mismatch is evidence for
   assessment rather than a trigger for money to move. §5 and §6.3 carry all of
   it, and §14 keeps only what is still open.
