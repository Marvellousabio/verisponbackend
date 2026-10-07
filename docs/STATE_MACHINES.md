# State Machines

The normative definitions are in code, not in this document. This file explains
them and points at the source; if the two ever disagree, the code is right and
this file is a bug.

| Machine | Source of truth |
| --- | --- |
| Escrow lifecycle | `apps/web/src/domain/transaction.ts` |
| Offered actions per state | `apps/web/src/domain/actions.ts` |
| Dispute rules | `apps/web/src/domain/dispute.ts` |
| Evidence stages | `apps/web/src/domain/evidence.ts` |
| Delivery and tracking | `apps/web/src/domain/delivery.ts` |
| Checkout link | `apps/web/src/domain/checkout.ts` |
| WhatsApp session | `apps/web/src/domain/whatsapp.ts` |

---

## 1. Escrow lifecycle

> A previous version of this document described eight lowercase states from a
> `src/domain/escrow.ts`. **No such file exists.** The real machine has seventeen
> states with the names below, and it disagrees with the old map in ways that
> matter — most visibly, the old map made `funded → in_progress` and offered no
> exception states at all.

### States

**Happy path** — `TRANSACTION_STATES`, in order:

```
CREATED → AWAITING_BUYER_VERIFICATION → AWAITING_PAYMENT → FUNDED
        → SELLER_PROCESSING → SHIPPED → DELIVERED → BUYER_INSPECTION
        → RELEASED → COMPLETED
```

**Exception states** — `EXCEPTION_STATES`, entered from the happy path:

```
CANCELLED · DELIVERY_FAILED · RETURN_IN_PROGRESS · DISPUTED
UNDER_REVIEW · REFUNDED · PARTIALLY_REFUNDED
```

Three classifications matter more than the order:

| Set | Members | Why it matters |
| --- | --- | --- |
| `TERMINAL_STATES` | `COMPLETED`, `CANCELLED`, `REFUNDED` | No outgoing transitions. `PARTIALLY_REFUNDED` is deliberately **not** terminal: the remainder is still releasable, so it continues to `RELEASED`. |
| `FUND_HOLDING_STATES` | `FUNDED`, `SELLER_PROCESSING`, `SHIPPED`, `DELIVERED`, `BUYER_INSPECTION`, `DISPUTED`, `UNDER_REVIEW`, `RETURN_IN_PROGRESS`, `DELIVERY_FAILED` | Money is held. Release is refused outside this set. |
| `ENGINE_ONLY_STATES` | `FUNDED`, `COMPLETED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `UNDER_REVIEW`, `RETURN_IN_PROGRESS` | No client may request these, however it phrases the request. |

`DELIVERY_FAILED` holds funds. This is not an oversight: a failed delivery does
not move money. It opens a choice between a retry, a return to the seller, or a
review. Auto-refunding on a failed delivery would let a seller force a refund by
losing a parcel.

Confirmed by the business owner: **only cancellation before dispatch refunds
automatically.** A failed attempt in transit is not a cancellation. The refund
happens when the return completes — `DELIVERY_FAILED → RETURN_IN_PROGRESS →
REFUNDED` — and the buyer fee is retained either way. See `BACKEND.md` §5.

`RELEASED` is deliberately **not** engine-only. The buyer's confirmation is the
authorisation. Making it engine-only would leave a buyer with no way to complete
a good transaction.

### Transition map

`TRANSITIONS`, verbatim. The database does not enforce this map; the service does,
under a row lock, and the service is the only writer.

| From | To |
| --- | --- |
| `CREATED` | `AWAITING_BUYER_VERIFICATION`, `CANCELLED` |
| `AWAITING_BUYER_VERIFICATION` | `AWAITING_PAYMENT`, `CANCELLED` |
| `AWAITING_PAYMENT` | `FUNDED`, `CANCELLED` |
| `FUNDED` | `SELLER_PROCESSING`, `DISPUTED`, `CANCELLED`, `REFUNDED` |
| `SELLER_PROCESSING` | `SHIPPED`, `DELIVERY_FAILED`, `DISPUTED`, `CANCELLED`, `REFUNDED` |
| `SHIPPED` | `DELIVERED`, `DELIVERY_FAILED`, `DISPUTED`, `RETURN_IN_PROGRESS` |
| `DELIVERED` | `BUYER_INSPECTION`, `DISPUTED`, `RETURN_IN_PROGRESS` |
| `BUYER_INSPECTION` | `RELEASED`, `DISPUTED`, `RETURN_IN_PROGRESS` |
| `RELEASED` | `COMPLETED`, `DISPUTED` |
| `COMPLETED` | — |
| `CANCELLED` | — |
| `DELIVERY_FAILED` | `RETURN_IN_PROGRESS`, `SELLER_PROCESSING`, `DISPUTED`, `REFUNDED` |
| `RETURN_IN_PROGRESS` | `REFUNDED`, `DISPUTED` |
| `DISPUTED` | `UNDER_REVIEW` |
| `UNDER_REVIEW` | `RELEASED`, `REFUNDED`, `PARTIALLY_REFUNDED` |
| `REFUNDED` | — |
| `PARTIALLY_REFUNDED` | `RELEASED` |

Four edges carry most of the design:

- **`DELIVERY_FAILED → SELLER_PROCESSING`** — the retry. A failed delivery is
  recoverable without a refund.
- **`RELEASED → DISPUTED`** — a dispute can be raised *after* the money is
  released. `COMPLETED` cannot, because by then nothing is left to contest.
- **`PARTIALLY_REFUNDED → RELEASED`** — a split resolution releases the remainder,
  so a partly-refunded transaction still ends in a payout.
- **`DISPUTED → UNDER_REVIEW` is the only exit from `DISPUTED`.** A dispute cannot
  be withdrawn by the party who opened it.

A repeat of the state already held is refused with `INVALID_TRANSITION`, even where
the map appears to permit it. `canTransition` answers legality; the repository
separately rejects the no-op.

### Who may cause each transition

`ACTIONS` in `domain/actions.ts` defines what is *offered*; `availableActions(state,
role)` filters it. Deriving the offer is not authorisation — the transition route
re-checks independently — but it keeps the UI from rendering a button the server
would refuse.

| Action | Role | Leads to | Meaning |
| --- | --- | --- | --- |
| `SEND_TERMS` | seller | `AWAITING_BUYER_VERIFICATION` | Seller sends the item and delivery terms |
| `VERIFY_TERMS` | buyer | `AWAITING_PAYMENT` | Buyer reviews before any money moves |
| `PAY_AND_PROTECT` | buyer | — | Requests payment. The move to `FUNDED` is the engine's, on settlement |
| `ASSIGN_RIDER` | seller | — | Chooses a rider and window |
| `UPLOAD_EVIDENCE` | seller | — | Photos, packaging, handover |
| `MARK_DISPATCHED` | seller | `SHIPPED` | After verifying the rider's code |
| `TRACK_DELIVERY` | buyer | — | Follows tracking events |
| `START_INSPECTION` | buyer | `BUYER_INSPECTION` | Opens the inspection window |
| `CONFIRM_RECEIPT` | buyer | `RELEASED` | **The authorisation.** |
| `RAISE_DISPUTE` | buyer | — | Pauses release. Opens a `dispute/` screen |
| `RESPOND_TO_DISPUTE` | both | — | Seller answers with evidence |

### Money movement

Only these transitions post to the ledger. Everything else is a state change and a
timeline entry with no postings — the money sits in `escrow_cash` until an outcome
is decided. Full posting groups are in `BACKEND.md` §4.3.

| Transition | Posts? |
| --- | --- |
| `→ FUNDED` | Yes — G1, money in, fee recognised |
| `BUYER_INSPECTION → RELEASED` | Yes — G2, escrow to seller payable plus fee |
| `→ COMPLETED` | Yes — G3, seller payable to payout clearing |
| `→ REFUNDED` | Yes — G4, escrow to refund payable. The buyer receives `A` only; the fee is retained by Verispon, moved from `buyer_fee_revenue` to `platform_equity` |
| `→ PARTIALLY_REFUNDED` | Yes — G6, `R` only, and the fee is retained in full rather than prorated |
| Any cancellation before funding | No. Nothing was ever held |
| `DELIVERED`, `BUYER_INSPECTION`, `DISPUTED`, `UNDER_REVIEW`, `RETURN_IN_PROGRESS`, `DELIVERY_FAILED` | No |

---

## 2. Dispute rules

From `domain/dispute.ts`. Separate from the transition map because a dispute is
an assessment, not a step.

`canRaiseDispute(transaction, role)` is true only when **all** of these hold:

1. `role === "buyer"` — always. A dispute pauses the seller's payout, so a seller
   who could open one could withhold money they are owed by raising a claim. The
   seller answers with evidence.
2. `holdsFunds(state)` — there is nothing to dispute before money is held, and
   nothing to dispute once it has left.
3. No dispute is open (`OPEN` or `UNDER_REVIEW`), and none has `resolvedAt`. A
   resolved dispute cannot be reopened; that would be an appeal, and this product
   does not model one.

The summary is required, 20–2000 characters. A reason alone would put the burden
of reconstructing the complaint on Verispon.

Resolution statuses: `OPEN`, `UNDER_REVIEW`, `RESOLVED_RELEASE`,
`RESOLVED_REFUND`, `RESOLVED_PARTIAL`. Resolution is engine/admin-only — there is
no route for it yet.

---

## 3. Evidence stages

From `domain/evidence.ts`. Evidence is classified by **stage**, and each
transaction state expects a stage.

| Stage | Expects | Meaning |
| --- | --- | --- |
| `before_payment` | `ITEM_BEFORE_TRANSACTION` | Condition recorded before the buyer pays |
| `payment` | — | Payment verified and funds held |
| `fulfillment` | `ITEM_PACKAGING` | Seller documents packaging and condition |
| `dispatch` | `ITEM_HANDOVER` | Item handed to a rider |
| `delivery` | `DELIVERY` | Rider confirms the delivery event |
| `receipt` | `ITEM_RECEIVED` | Buyer captures the received item and its condition |
| `confirmation` | `DOCUMENT` | Buyer confirms the item is acceptable |
| `dispute` | `ITEM_DAMAGED` | Evidence collected for assessment |

`stateEvidenceStage` maps each of the seventeen states to its stage.

`requiredEvidenceForStage` is enforced in **exactly one place**: the transition into
`AWAITING_PAYMENT`, and **only when `transaction.photos_enabled` is true**. When the
flag is on, the seller must have uploaded an `ITEM_BEFORE_TRANSACTION` before the
buyer can be moved to pay. When it is off, nothing is blocked and the photo stays
a suggestion. This is now a settled product decision rather than an open one, and
it is conditional — the stage table above is a declaration for the other seven
stages and a gate only for `before_payment`, and only when the transaction asked
for it.

The gate is at the transition, not at creation, so the transaction still exists,
the payment link is still live, and the seller can see on the transaction page
exactly what is missing. The `ITEM_RECEIVED` photo at `receipt` is prompted and
never blocks: by then the funds are held and the deal is running, and refusing the
buyer's confirmation over a camera roll would strand money in escrow.

A before/after mismatch triggers nothing. No state change, no refund — it is
evidence for dispute assessment. See `BACKEND.md` §6.3.

Evidence upload is always additive and is never a state transition. It is allowed
for either party in any non-terminal state.

---

## 4. Delivery and tracking

From `domain/delivery.ts`.

**Methods** — `SELLER_RIDER` and `BUYER_ARRANGED` are live. `INTEGRATED_COURIER`
is modelled with `available: false` and an `unavailableReason`, because partner
coverage and returns capability are unconfirmed. Presenting an unconfirmed option
as live is a promise Verispon cannot keep.

**Tracking events** — `PICKED_UP`, `IN_TRANSIT`, `ARRIVED`, `DELIVERED`,
`UNABLE_TO_DELIVER`, `RETURNING`, `RETURNED`. Each carries an optional `reason`
(required for a failed delivery), an optional `location`, and `riderVerified`.

**Rider verification.** `DeliveryRecord.riderVerifiedAt` is set when the seller
confirms the rider presented their code. The handover record therefore rests on a
code both parties saw, not on an assertion. `MARK_DISPATCHED`'s description says
so, and the action is only offered once the rider exists.

Rider identity is **undecided**: a rider is not an account, and the model that
lets a rider post tracking events without becoming a user has not been chosen. This
blocks the deliveries webhook.

`validateFailedDeliveryReport(reason, confirmed)` requires a reason of at least 8
characters and an explicit confirmation. A failed delivery never refunds on its
own; `FAILED_DELIVERY_RESOLUTIONS` offers retry, return, or review.

---

## 5. Checkout link

From `domain/checkout.ts`. Not a lifecycle state machine, but it has a lifecycle
that is easy to get wrong.

```
created (token issued, expiresAt = createdAt + 24h)
   │
   ├── opened ─────────────► open
   ├── deadline passes ────► expired
   ├── state = FUNDED ─────► paid
   └── state ∈ {cancelled, refunded, completed, disputed, under review} ──► closed
```

The transaction's state **outranks the clock**. A link on a paid or cancelled
transaction is never reported as `expired`, because that tells a buyer to ask for
a new link for money they have already sent.

`expiresAt` is fixed at creation and never extended. A link that can be revived
is a link that never expired.

---

## 6. WhatsApp session

From `domain/whatsapp.ts`. Steps in `whatsappStepOrder`:

```
welcome → role_selected → identity_pending → identity_verified → wallet_ready
        → escrow_created → payment_held → dispatch_pending → delivered → released
```

Intended flows:

- **Buyer:** `welcome → role_selected → identity_pending → identity_verified → wallet_ready → escrow_created → payment_held → delivered → released`
- **Seller:** `welcome → role_selected → identity_pending → identity_verified → escrow_created → dispatch_pending → delivered → released`

**This machine is not the escrow machine and must not become one.**
`handleWhatsAppMessage` in `lib/whatsapp-bot.ts` is a keyword matcher over these
steps: it advances on `"dispatch"`, `"photos uploaded"`,
`"item received in good condition"`, and `"wallet funded NNN"`. It does not read or
write the transaction engine, does not call the repositories, and writes to
`window.localStorage` behind a `typeof window` guard, so it persists nothing when a
server invokes it.

When the webhook is built, these steps become a **conversation** layer over the
services in §1 — a message maps to the same call as the equivalent dashboard
action, with the same authorisation. A WhatsApp command that can do something the
dashboard cannot is a privilege escalation path. See `WHATSAPP_BOT_PLAN.md`.