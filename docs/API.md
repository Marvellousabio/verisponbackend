# HTTP API

The contract a client codes against. Every route below exists in
`apps/web/src/app/api` and behaves as written; where behaviour is not yet
implemented, §7 says so rather than describing a wish.

Read this alongside `BACKEND.md` for the schema and service rules, and
`STATE_MACHINES.md` for the lifecycle. This document is the wire format only.

---

## 1. Conventions

### 1.1 Naming and casing

The wire is `camelCase`, matching the domain types. It is **not** `snake_case`:
the API is consumed by this repository's own client, so there is one casing, not
two with a converter between them. PostgreSQL columns are `snake_case` and the
mapping happens inside the repository implementation, below the API.

| Layer | Casing |
| --- | --- |
| JSON on the wire, domain types | `camelCase` |
| SQL columns, ledger accounts | `snake_case` |

### 1.2 Money

Every money field is an **integer number of kobo**, suffixed `Kobo`, never a float
and never a formatted string. `4500000` is ₦45,000. Naira exists only at the
formatting boundary, in the client.

The one exception is the create endpoint, which accepts `amount` as a **string**
(`"450,000"`, `"₦450,000"`, `"450000.50"`) because it is typed by a human into a
phone keypad. It is parsed server-side by `parseAmountToKobo` and stored as
`amountKobo`. Anything with more than two decimal places is rejected rather than
rounded.

### 1.3 Timestamps

ISO-8601 UTC with an explicit `Z`: `2026-10-03T21:47:57.428Z`. The one exception
is the evidence `timestamp` field, which is the same format.

### 1.4 Errors

Every error is a flat object with a single `error` string. There is no code, no
field map, and no nested structure — `apps/web/src/server/api-helpers.ts` is the
only place errors are shaped.

```json
{ "error": "Enter the other party's Verispon reference, for example VSP-A-0002." }
```

| Status | Raised when |
| --- | --- |
| `400` | Validation failed, or the body was not the expected shape |
| `401` | No session, or the session is unreadable |
| `403` | Engine-only transition requested, or a repository `FORBIDDEN` |
| `404` | Not found, **or** the caller is not a party (deliberately identical) |
| `409` | Illegal transition, duplicate email/phone, dispute already open |
| `429` | Throttled — sign-in, or recovery sends |
| `500` | Unexpected. Logged server-side, reported as `"Something went wrong. Try again."` |

A `404` never distinguishes "no such transaction" from "not your transaction".
Distinguishing them enumerates references, so a caller who guesses `VSP-0007`
learns nothing about whether it exists.

The `RepositoryError.code` → status mapping, in `api-helpers.ts`:

| `code` | Status |
| --- | --- |
| `VALIDATION` | 400 |
| `NOT_FOUND` | 404 |
| `FORBIDDEN` | 403 |
| `CONFLICT` | 409 |
| `INVALID_TRANSITION` | 409 |

### 1.5 Authentication

All routes except the auth endpoints and `GET /checkout/:token` require the
session cookie.

| Property | Value |
| --- | --- |
| Name | `verispon_session` |
| Value | `base64url(payload).base64url(hmac_sha256(payload))` |
| Payload | `{ accountId, issuedAt, roles }` |
| Lifetime | 7 days |
| Flags | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production |

`SESSION_SECRET` must be at least 32 characters. Without it, production **fails
closed**: every session is rejected rather than falling back to a default.

The account is re-read from the store on every request, so a soft-deleted account
stops working immediately without a revocation list. `roles` in the cookie is a
rendering convenience only and is never trusted for authorisation.

### 1.6 No idempotency header yet

`BACKEND.md` §3.5 specifies an `Idempotency-Key` header and an `idempotency_keys`
table. **Neither exists.** Today a repeated `POST` creates a second transaction.
This is the first thing to add when the Postgres repository lands, because the
payment and release endpoints must not be retryable into a double posting.

---

## 2. Reference formats

Public references are quoted aloud in WhatsApp messages, so they are short,
sequential, and shaped by kind.

| Kind | Format | Example | Source |
| --- | --- | --- | --- |
| Account | `VSP-A-` + 4 digits | `VSP-A-0002` | `accountReference()` |
| Transaction | `VSP-` + 4 digits | `VSP-0007` | `transactionReference()` |
| Dispute | `DSP-` + 4 digits | `DSP-0003` | `disputeReference()` |
| Checkout token | 32 lowercase hex chars | `d6a6e1cebffb33dca49fb6a0607abe11` | `newCheckoutToken()` |

An account reference is validated against `^VSP-[A-Z]-\d{4}$` wherever one is
entered. The checkout token is validated against `^[0-9a-f]{32}$` and nothing
else; a malformed token is a `404`, never a `500`.

Sequences are stored, not generated in memory, so references stay unique across
restarts and across instances.

---

## 3. Auth

### `POST /api/auth/register`

```json
{
  "name": "Amina Bello",
  "email": "amina@example.com",
  "phone": "2348030000001",
  "passcode": "123456",
  "role": "BUYER"
}
```

| Field | Rules |
| --- | --- |
| `name` | ≥ 2 characters after trimming |
| `email` | must match an email pattern; lowercased; unique |
| `phone` | E.164 digits, no leading `+`; unique; any of the supported countries |
| `passcode` | exactly 6 digits |
| `role` | `BUYER` or `SELLER` only |

`ADMIN` is refused — `SELF_ASSIGNABLE_ROLES` is `["BUYER", "SELLER"]` because the
admin console does not exist. An account may hold both roles; see §4.

`201`:

```json
{ "account": { "id": "…", "reference": "VSP-A-0001" } }
```

Sets the session cookie. Never returns the passcode or its digest.

### `POST /api/auth/login`

```json
{ "identifier": "2348030000001", "passcode": "123456" }
```

`identifier` is a phone number in any accepted format or an email address. The
server classifies it.

`200` with the same body as register. `401` with
`{"error":"Those details don't match an account."}` for **every** failure —
unknown account, wrong passcode, and malformed identifier alike. A message that
distinguished them would let a caller enumerate which numbers are registered.

A missing account still pays for a scrypt verification against a decoy digest, so
the response time does not reveal whether the account exists.

Throttled before hashing: 5 failures per identifier per 15 min, 60 per source
address per 15 min. `429` with `Retry-After`. See `BACKEND.md` §7.2 for why the
per-address limit is far higher than the per-identifier one.

### `POST /api/auth/logout`

No body. Clears the cookie. Always `200`.

### `POST /api/auth/recover`

```json
{ "identifier": "2348030000001" }
```

Sends a six-digit code over WhatsApp. Ten-minute life, one live code per account,
older codes invalidated, digest stored rather than the code.

`200` regardless of whether the account exists, for the same enumeration reason
as login. `429` after 3 sends per identifier per hour.

### `POST /api/auth/recover/verify`

```json
{ "identifier": "2348030000001", "code": "123456", "passcode": "654321" }
```

`200` and a fresh session on success. `400` on a bad shape, `401` on a wrong code.

---

## 4. Transactions

### `GET /api/transactions`

Query parameters:

| Name | Type | Notes |
| --- | --- | --- |
| `state` | repeated | One or more `AnyTransactionState` values |
| `search` | string | Matches title and reference |
| `limit` | number | Default 20 |
| `offset` | number | Default 0 |

Scope comes from the session. There is no parameter that can widen it: the query
filters on `buyer.accountId = $account OR seller.accountId = $account`.

`200`:

```json
{
  "transactions": [ /* TransactionRecord */ ],
  "total": 8
}
```

`TransactionRecord` is the domain type from `domain/transaction-record.ts`. Note
that **`checkout.token` is included in this response**. That is safe today because
the route is scoped to parties, but it is the reason §5.4 says listings must never
be reused for anything wider.

### `POST /api/transactions`

Opens a transaction. **Either side may open one.**

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

| Field | Rules |
| --- | --- |
| `title` | 4–120 characters after trimming |
| `description` | optional, ≤ 1000 characters |
| `amount` | string, parses to a positive integer number of kobo |
| `counterpartyReference` | `^VSP-[A-Z]-\d{4}$` |
| `photosEnabled` | optional boolean, defaults to `false`; accepted from either role |
| `delivery` | optional; **read only when the session account is a seller** |

`photosEnabled` turns on the condition-photo pair. When it is `true` the seller
must upload an `ITEM_BEFORE_TRANSACTION` before the transaction can move to
`AWAITING_PAYMENT` — a missing photo on that transition is `400`. When it is
`false` nothing is gated. The after photo (`ITEM_RECEIVED`, at `receipt`) is
prompted and never blocks. A before/after mismatch moves no money and changes no
state; it is evidence for dispute assessment. See `BACKEND.md` §6.3.

**Which side you are is decided by your roles, not by this request.** A `SELLER`
opening a transaction is recorded as its seller; a `BUYER` opening one is recorded
as its buyer. An account holding both roles opens as the **buyer**, because it is
the side asking for goods and the side whose money will be held. The repository
decides this; the client cannot choose.

Consequences worth knowing before you build against it:

- The client never sends a buyer id or a seller id. It sends a reference, and the
  counterparty is resolved from it. A client cannot open a transaction against
  someone who has not agreed to be on it.
- `delivery` from a buyer is **dropped, not rejected**. A buyer has not agreed a
  pickup or a window, so recording one would put words in the seller's mouth.
- The same rules run server-side as in the browser: `validateDraft` for the
  transaction, `validateDeliveryDraft` for the delivery. The server's copy is the
  one that decides.

`201`:

```json
{ "transaction": { /* … */ "checkout": { "token": "…", "expiresAt": "…" } } }
```

Refusals:

| Condition | Status | Body |
| --- | --- | --- |
| Invalid title/amount/reference | `400` | the specific message |
| Invalid delivery | `400` | the specific message |
| No account matches the reference | `404` | `No account matches that reference.` |
| Reference is your own | `400` | `You cannot start a transaction with yourself.` |
| You are unverified | `400` | `Verify an email address or a phone number before you open a transaction.` |

Fees are computed server-side and frozen onto the row. A client sending
`buyerFeeKobo` is ignored. Every transaction is issued a checkout link at creation
— see §5.

### `GET /api/transactions/:id`

`:id` accepts a uuid **or** a public reference (`VSP-0007`).

`200`:

```json
{
  "transaction": { /* TransactionRecord */ },
  "counterparty": { "id": "…", "reference": "VSP-A-0001", "name": "Amina Bello", "verified": true },
  "viewerRole": "seller"
}
```

`viewerRole` is `buyer` or `seller` — the role **on this transaction**, which is
not always the account's role: an account holding both roles is the buyer on the
transactions it opens.

Two rules that are not obvious from the shape:

- **`counterparty` carries no contact details.** No phone, no email. Both parties
  transact through Verispon and talk on WhatsApp; exposing contact details would
  invite settling outside the platform.
- **`404` for a non-party**, identical to a missing transaction.

---

## 5. The payment link

### What it is

Every transaction is issued an unguessable token at creation. The token is the
**capability** that grants access to the checkout page: `/checkout/:token` needs no
account, because the buyer may be paying for the first time. It lives 24 hours.

The token is deliberately *not* the public reference. References are sequential
and public — `VSP-0007` is guessable — so a reference cannot be what a buyer
clicks in a message from a stranger.

### Storage shape

```ts
checkout?: {
  token: string;      // 32 lowercase hex, issued once, never rotated
  expiresAt: string;  // ISO-8601, fixed at creation + 24h, never extended
  openedAt?: string;  // stamped on the first successful render
}
```

### Availability

`checkoutAvailability(link, state, now)` returns one of four values. The state of
the transaction **outranks the clock**, because telling a buyer to ask for a new
link for money they have already sent is the worse lie.

| Availability | When | What the page says |
| --- | --- | --- |
| `open` | Not paid, not closed, before `expiresAt` | The deal and how to pay |
| `expired` | Deadline passed, transaction still payable | Ask the seller for a new link |
| `paid` | `state = FUNDED` | Already paid for |
| `closed` | Cancelled, refunded, completed, disputed, under review, or no link / malformed deadline | No longer open for payment |

A record with **no** checkout is `closed`, never `open` by default. A malformed
`expiresAt` is `closed`, never open forever.

### `GET /checkout/:token`

A **page**, not an API route: public, `noindex, nofollow`, no session. It renders
the item, the fee breakdown and total payable, what the money is protected by, the
delivery details if the seller supplied any, and a countdown.

It **cannot mark a transaction paid**. `FUNDED` is engine-only, because "the money
arrived" is a fact about a bank, not something a browser may assert.

| Condition | Result |
| --- | --- |
| Token is not 32 lowercase hex | `404` |
| No transaction has that token | `404` |
| Otherwise | `200` |

`404` for a malformed token is deliberate. A page that looks live but cannot take
money is worse than a plain dead link.

The first successful render stamps `checkout.openedAt`, so a seller can tell a
buyer who never looked from one who looked and walked away. It is idempotent and
never touches the state machine.

### 5.4 Rules for anyone reusing this token

- Never put `checkout.token` in a listing, feed, log line, analytics event, or
  error report.
- Only a party to the transaction may see it in the authenticated API.
- Never rotate it. A rotated token is a link in an old WhatsApp message that now
  404s, and there is no way to tell the seller which one.
- Never extend `expiresAt`. A link that can be revived is a link that never
  expired.

---

## 6. Lifecycle, evidence and disputes

### `POST /api/transactions/:id/transition`

```json
{ "to": "RELEASED", "note": "Item as described." }
```

The route, in order:

1. Resolve the session account. **No body field may name the actor.**
2. Load the transaction. `404` if absent or if the caller is not a party.
3. Refuse `to` that is not a known state → `400`.
4. Refuse `to` when `isEngineOnly(to)` → `403` with
   `"Verispon makes that change once payment or settlement is confirmed."`
   Engine-only states are `FUNDED`, `COMPLETED`, `REFUNDED`,
   `PARTIALLY_REFUNDED`, `UNDER_REVIEW`, `RETURN_IN_PROGRESS`.
5. Call the repository, which re-checks the transition against the current state
   under a lock, rejects a repeat of the current state, and appends the timeline
   entry.

`200` with `{ "transaction": … }`. `409` on an illegal transition, including
repeating the state already held.

### `POST /api/transactions/:id/evidence` — **also opens a dispute**

This path serves two purposes, because from the buyer's point of view raising a
dispute is one action and its first step is collecting evidence.

- `POST` → open a dispute
- `PUT` → upload evidence (multipart)
- `GET` → list evidence plus the stage the current state expects
- `DELETE` → remove one item

`POST` body:

```json
{ "reason": "ITEM_NOT_AS_DESCRIBED", "summary": "The listing said full-grain leather…" }
```

`reason` ∈ `ITEM_NOT_AS_DESCRIBED`, `ITEM_NOT_RECEIVED`, `ITEM_DAMAGED`,
`PAYMENT_PROBLEM`, `DELIVERY_PROBLEM`, `OTHER`. `summary` is **required**, 20–2000
characters: a dispute is an assessment, and an assessment needs the party's
account. A reason alone would put the burden of reconstructing the complaint on
Verispon.

There is a dedicated `POST /api/transactions/:id/dispute` route with the same
contract and better refusal messages. **Prefer it.** The `POST` on this path is
legacy.

| Condition | Status |
| --- | --- |
| Not the buyer | `409` `"Only the buyer raises a dispute…"` |
| Nothing held, or money already left | `409` `"There is nothing to dispute here…"` |
| A dispute is already open | `409` |
| Opened | `201` with the updated transaction |

Only the buyer may raise one, ever: a dispute pauses the seller's payout, so
letting a seller open it would let them withhold money they are owed by raising a
claim. The seller answers with evidence.

`PUT` is `multipart/form-data`:

| Field | Notes |
| --- | --- |
| `files` | Repeatable. At least one required. |
| `type` | An `EvidenceType`. Required. |
| `description` | Optional. **Not length-checked server-side**; the UI caps it at 280. Add a `check` before trusting it. |

Limits, from `validateEvidenceSubmission`:

| Kind | Per file | Per submission |
| --- | --- | --- |
| Image (JPEG/PNG/WebP) | 5 MB | 5 images |
| PDF | 10 MB | — |
| Video (MP4/QuickTime/WebM) | 25 MB | — |
| **Total** | — | **50 MB** |

The declared `content-type` is **not trusted**. The decoded bytes are what is
size-checked and what is written. The filename is never used as a path segment;
the stored name is generated. `201` returns `{ "evidence": [...] }`.

`DELETE` takes `?evidenceId=`. Only the uploader may remove their own item, and
only before `RELEASED` or `COMPLETED` — once money has moved, the record of what
was submitted is the record of what was agreed.

### `GET /api/evidence/:transactionId/:filename`

Streams one stored file. Requires a session **and** party membership: `404`
otherwise, on the same reasoning as every other resource route.

The path is rebuilt from the upload directory rather than trusting the parameter,
and the filename is matched against the known evidence items, so a crafted name
cannot read an arbitrary path. Served with `Cache-Control: private, immutable` and
`X-Content-Type-Options: nosniff`.

**This route is the one most likely to be missed when writing an authorisation
matrix.** Evidence is what a dispute is decided on; a presigned object URL alone
would leak it to anyone who obtained the link.

---

## 7. Not implemented

Documented because a client will want them, and because building against a wish
produces a broken integration.

| Route | Purpose | Blocker |
| --- | --- | --- |
| `POST /api/internal/payments/confirm` | Banking partner settlement webhook | No banking adapter. **Highest priority.** |
| `POST /api/internal/payouts/settle` | Payout settlement confirmation | No banking adapter |
| `POST /api/internal/deliveries/events` | Rider/courier tracking event | Rider identity undecided |
| `POST /api/internal/disputes/:id/resolve` | Admin resolution | No admin authz, no console |
| `GET`/`POST /api/whatsapp` | Meta webhook | **Does not exist.** See §8 |
| `/api/admin/*` | Console | Deferred |

These are internal: authenticated by a shared secret plus an allowlisted source,
never by a session cookie. An unverified webhook signature is a public write
endpoint with money attached.

### Idempotency, again

`BACKEND.md` §3.5 and §6.1 require `Idempotency-Key` on every mutation. It is not
implemented. When it is, the semantics are: same key + same body hash replays the
stored response verbatim; same key + different body is `409`.

---

## 8. The WhatsApp webhook does not exist

`docs/WHATSAPP_BOT_PLAN.md` previously listed `src/app/api/whatsapp/route.ts` as
**Done**, and the previous version of this file documented its request and
response shapes. Neither was true. There is no such route, so Meta cannot reach
Verispon today.

What exists in `src/lib/` is the pieces *around* it: payload parsing and signature
verification (`whatsapp-webhook.ts`), the outbound sender (`meta-whatsapp.ts`), env
config (`meta-config.ts`), session and escrow file stores. What does not exist is
the route that binds them, and the engine integration — `whatsapp-bot.ts` keeps
its own ten-step session and writes to `window.localStorage` behind a
`typeof window` guard, so it persists nothing when a server calls it.

When it is built it must map inbound commands onto **the same services the web
routes call**, not onto its own state machine. A WhatsApp command that can do
something the dashboard cannot is a privilege escalation path. See
`WHATSAPP_BOT_PLAN.md`.

---

## 9. Full route index

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | — | Create an account, start a session |
| `POST` | `/api/auth/login` | — | Sign in |
| `POST` | `/api/auth/logout` | session | Clear the session |
| `POST` | `/api/auth/recover` | — | Issue a recovery code |
| `POST` | `/api/auth/recover/verify` | — | Set a new passcode |
| `GET` | `/api/transactions` | session | List the caller's transactions |
| `POST` | `/api/transactions` | session | Open a transaction |
| `GET` | `/api/transactions/:id` | party | Read one transaction |
| `POST` | `/api/transactions/:id/transition` | party | Request a state change |
| `GET` | `/api/transactions/:id/evidence` | party | List evidence + expected stage |
| `PUT` | `/api/transactions/:id/evidence` | party | Upload evidence (multipart) |
| `POST` | `/api/transactions/:id/evidence` | party | Open a dispute (legacy — use `/dispute`) |
| `DELETE` | `/api/transactions/:id/evidence` | party, uploader | Remove one item |
| `POST` | `/api/transactions/:id/dispute` | buyer | Open a dispute |
| `GET` | `/api/evidence/:transactionId/:filename` | party | Stream one evidence file |
| — | `/checkout/:token` | token | Buyer payment page (not an API route) |