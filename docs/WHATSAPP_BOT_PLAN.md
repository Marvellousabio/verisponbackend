# Verispon WhatsApp Bot — Implementation Plan

## Overview

Goal: ship a production-grade WhatsApp escrow bot that buyers and sellers can actually use.

> **Correction, checked against `apps/web/src` on 2026-10-03.** This plan previously
> stated that the bot logic, webhook route, dashboard sync and stores were all
> "Done". Three of those claims were false, and building against them would have
> wasted a day. The status table below is now what is actually on disk. Note also
> that `docs/API.md` previously documented `/api/whatsapp` request and response
> shapes for a route that does not exist; that has been removed.

What genuinely exists is the machinery *around* a webhook: payload parsing with
signature verification, the outbound sender, the env config loader, and two
file-backed stores. What does not exist is the route that binds them, and any link
between the bot and the transaction engine.

---

## Current State

Verified by file existence, not by intent.

| Layer | File(s) | Status |
|---|---|---|
| Meta payload parsing + signature verification | `src/lib/whatsapp-webhook.ts` | Done |
| Outbound Meta API sender | `src/lib/meta-whatsapp.ts` | Done |
| Config loader | `src/lib/meta-config.ts` | Done — reads env vars |
| Session store | `src/lib/session-store.ts` | Done — **file-based, single instance** |
| Escrow store | `src/lib/escrow-store.ts` | Done — **file-based, does not match the engine's model** |
| Postgres stores | `src/lib/postgres-store.ts` | Implements **superseded interfaces** — see `BACKEND.md` §2, do not extend |
| **API route (GET verify + POST webhook)** | `src/app/api/whatsapp/route.ts` | **MISSING. The file does not exist.** Meta cannot reach Verispon. |
| **Dashboard transaction sync** | `src/lib/escrow-transactions.ts` | **MISSING.** |
| Conversation state machine | `src/lib/whatsapp-bot.ts` | **Not an integration.** See below |
| WhatsApp link generator | `src/lib/whatsapp-link.ts` | Done |
| Animated frontend experience | `src/app/whatsapp/experience.tsx` | Done — a demo, not the bot |
| Landing CTA → WhatsApp | `src/app/page.tsx` | Done — sends a pre-filled early-access message |

### The bot is not wired to the engine

`handleWhatsAppMessage` advances a ten-step session by matching substrings:
`"wallet funded NNN"`, `"photos uploaded"`, `"payment received"`,
`"dispatch"`, `"tracking"`, `"item received in good condition"`. It has its own
`buyerDeliveryConfirmed` / `sellerDeliveryConfirmed` booleans and its own idea of
what "released" means.

It does not import the repositories, does not read `TransactionRecord`, does not
call the engine, and writes to `window.localStorage` behind a `typeof window`
guard — so a server invocation persists nothing at all.

Its "escrow" is not `escrow_cash`. Nothing it does moves money.

### What the bot can send now

There is a payment link (`BACKEND.md` §3.3, `domain/checkout.ts`): a 24-hour
unguessable token resolving to `/checkout/<token>`, readable with no account. The
outbound message finally has something to carry — send the link, not the
reference.

---

## Phase 1 — Meta / WhatsApp Business Setup (External)

### 1.1 Create Meta Developer App
1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create a new app
3. Add **WhatsApp** product
4. Note the **App ID** and **App Secret**

### 1.2 Get a WhatsApp Business Number
- Verify an existing business number in Meta Business Manager
- Or purchase a new number through Meta's WhatsApp Business Platform
- This becomes the sender number for all outbound messages

### 1.3 Generate Credentials
Collect these values from the Meta dashboard:

| Variable | Where to get it |
|---|---|
| `META_WA_TOKEN` | Meta > WhatsApp > API Setup > System user token |
| `META_WA_PHONE_NUMBER_ID` | Meta > WhatsApp > API Setup > Phone number ID |
| `META_WA_API_VERSION` | Latest stable, e.g. `v22.0` |
| `META_WEBHOOK_VERIFY_TOKEN` | Any random string you choose |
| `META_WEBHOOK_SECRET` | Generated when setting up webhook signing |
| `VERISPON_WHATSAPP_NUMBER` | The same business number in E.164 format |

### 1.4 Configure Webhook Subscription
- Webhook URL: `https://<your-domain>/api/whatsapp`
- Verify token: must match `META_WEBHOOK_VERIFY_TOKEN`
- Subscribe to fields: `messages`
- Enable webhook signing and note the secret for `META_WEBHOOK_SECRET`

---

## Phase 2 — Environment & Configuration

### 2.1 Environment Variables
Create `.env.local` (local) and set the same values in your hosting environment:

```env
META_WA_TOKEN=
META_WA_PHONE_NUMBER_ID=
META_WA_API_VERSION=v22.0
META_WEBHOOK_VERIFY_TOKEN=
META_WEBHOOK_SECRET=
VERISPON_WHATSAPP_NUMBER=
DATABASE_URL= # optional; enables Postgres session + escrow persistence
```

### 2.2 Required Hosting Capabilities
The `/api/whatsapp` route must be:
- **Publicly reachable** from Meta's servers
- **Stable** — avoid cold-start workers that can drop webhooks
- **Persistent** — background processes and file-based stores are not suitable for multi-instance hosting

Recommended hosting: Node.js server, containerized service, or Next.js on a persistent runtime.

---

## Phase 3 — Deployment & Infrastructure

### 3.1 Database
Move from file-based stores to Postgres for production:

| Table | Purpose |
|---|---|
| `whatsapp_sessions` | Session state keyed by WhatsApp sender ID |
| `escrows` | Escrow lifecycle records |
| `dashboard_transactions` | Optional: mirror of bot-created transactions |

Postgres schema is already implemented in `src/lib/postgres-store.ts`.

Run migrations:
```sql
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  session_id TEXT PRIMARY KEY,
  session JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escrows (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  amount_kobo BIGINT NOT NULL,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
```

### 3.2 Hosting Checklist
- [ ] `META_WA_TOKEN` and `META_WA_PHONE_NUMBER_ID` configured
- [ ] `META_WEBHOOK_VERIFY_TOKEN` and `META_WEBHOOK_SECRET` configured
- [ ] `VERISPON_WHATSAPP_NUMBER` configured
- [ ] HTTPS endpoint for `/api/whatsapp` reachable from the internet
- [ ] Static asset CDN for landing page
- [ ] Persistent process — no serverless cold-start for webhook handler

### 3.3 Testing Endpoint
After deployment, verify the webhook:
```bash
curl "https://<your-domain>/api/whatsapp?hub.mode=subscribe&hub.verify_token=<META_WEBHOOK_VERIFY_TOKEN>&hub.challenge=12345"
```
Should return the challenge string.

Send a test WhatsApp message to the bot number and confirm a reply comes back.

---

## Phase 4 — Testing

### 4.1 Unit Tests
Files already exist:
- `src/lib/whatsapp-bot.test.ts`
- `src/lib/whatsapp-webhook.test.ts`
- `src/lib/meta-config.test.ts`
- `src/lib/session-store.test.ts`
- `src/lib/escrow-store.test.ts`
- `src/lib/whatsapp-link.test.ts`
- `src/lib/meta-whatsapp.test.ts`
- `src/lib/escrow-transactions.test.ts`

Run:
```bash
npm test
```

### 4.2 Integration Tests
- Post a Meta-format payload to `/api/whatsapp`
- Assert the response contains `reply`, `session`, and `from`
- Assert outbound message is sent when config is present
- Assert duplicate message IDs are handled

### 4.3 Manual Tests
| Scenario | Expected Result |
|---|---|
| Send "1" to bot | Buyer flow starts |
| Send "2" to bot | Seller flow starts |
| Send item + amount | Escrow created, dashboard updated |
| Send "released" | Transaction marked complete |
| Send duplicate message | Bot does not double-process |

---

## Phase 5 — Bot Logic Improvements

### 5.1 Current Flow
- Buyer: welcome → role_selected → identity_pending → identity_verified → wallet_ready → escrow_created → payment_held → delivered → released
- Seller: welcome → role_selected → identity_pending → identity_verified → escrow_created → dispatch_pending → delivered → released

### 5.2 Recommended Additions
1. **Identity verification integration** — currently matched by regex; wire to a real OTP/identity provider
2. **Payment confirmation** — currently matched by keyword; wire to a real payment webhook
3. **Tracking number validation** — validate courier tracking format before advancing
4. **Dispute flow** — add explicit `/dispute` command and dispute state in escrow
5. **Receipt/reference generation** — send a transaction reference card after escrow creation
6. **Multi-language support** — detect language and switch reply templates
7. **Rate limiting** — prevent message floods from same sender

---

## Phase 6 — Security & Compliance

| Item | Status | Action |
|---|---|---|
| Webhook signature verification | Done | Keep `META_WEBHOOK_SECRET` set |
| Input sanitization | Partial | Review regex parsers in `whatsapp-bot.ts` |
| PII handling | Partial | NIN/DOB are sent in plain chat — consider encryption at rest |
| Outbound message retries | Partial | Add retry logic to `meta-whatsapp.ts` |
| Idempotency | Done | Duplicate message IDs are checked |
| Secrets in git | Check | Ensure `.env.local` is gitignored |
| Rate limiting | Not done | Add per-sender rate limits |

---

## Phase 7 — Monitoring & Observability

- [ ] Add request logging to `/api/whatsapp`
- [ ] Add error tracking for outbound message failures
- [ ] Add session state transition logging
- [ ] Add dashboard for active sessions and escrow states
- [ ] Alert on webhook delivery failures from Meta

---

## Phase 8 — Launch Checklist

- [ ] Meta app approved for WhatsApp Business Platform
- [ ] Business number verified and active
- [ ] Webhook URL reachable and verified
- [ ] All 5 env vars set in production
- [ ] Postgres database provisioned and migrated
- [ ] Tests passing (`npm test`)
- [ ] Manual end-to-end test complete
- [ ] Landing page CTA opens correct WhatsApp link
- [ ] Outbound messages confirmed working
- [ ] Session persistence confirmed across restarts
- [ ] **A WhatsApp command can do nothing the dashboard cannot** — verified by
      attempting each command as the wrong role and confirming the same refusal the
      HTTP route gives
- [ ] **Outbound messages carry the payment link**, not the bare reference, and an
      expired link produces "ask the seller for a new one" rather than a dead URL

---

## Key Files Reference

Missing files are marked — they are the work, not the description of it.

| File | Responsibility | Exists |
|---|---|---|
| `src/app/api/whatsapp/route.ts` | Webhook endpoint: verify, dedupe on `wamid`, call a service | **NO — to build** |
| `src/lib/whatsapp-bot.ts` | Keyword matcher; needs replacing with a service-backed conversation layer | Yes, but not integrated |
| `src/lib/whatsapp-webhook.ts` | Meta payload parsing + signature verify | Yes |
| `src/lib/meta-whatsapp.ts` | Outbound message sender | Yes |
| `src/lib/meta-config.ts` | Config loader from env vars | Yes |
| `src/lib/session-store.ts` | Conversation session persistence | Yes, file-based |
| `src/lib/escrow-store.ts` | Bot-local escrow model | Yes — **superseded**, do not build on it |
| `src/lib/postgres-store.ts` | Postgres implementations | Yes — **superseded interfaces**, delete rather than extend |
| `src/lib/escrow-transactions.ts` | Dashboard sync | **NO** |
| `src/lib/whatsapp-link.ts` | WhatsApp link generator | Yes |
| `src/app/whatsapp/experience.tsx` | Frontend demo | Yes |
| `src/app/page.tsx` | Landing CTA wiring | Yes |
| `src/domain/checkout.ts` | The payment link the bot should send | Yes |
| `src/server/repositories/*` | The engine the bot must call | Yes |
