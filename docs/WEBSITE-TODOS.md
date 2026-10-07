# Verispon website — open items (TODO)

Decisions confirmed by the founder and now applied to the site are recorded in
§1 below. What remains open is in §2 onward. Source of truth for the product is
the requirements document ("Dual-Channel Escrow & Transaction Protection
Platform"). Nothing on the site is claimed beyond what is listed here.

## 1. Confirmed — do not re-open these questions

| Item               | Confirmed answer                                                  | Where it appears                   |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------- |
| Fees               | Buyer 2%, seller 1%, capped at ₦10,000 per transaction            | `FeesSection.tsx`, FAQ             |
| Failed transaction | Buyer is refunded in full, **except the payment processing fee**  | `FeesSection.tsx`, FAQ             |
| Banking partner    | Nomba                                                             | Hero, custody section, FAQ, footer |
| Nomba's role       | Payment collection, fund custody **and** settlement to the seller | `CustodySection.tsx`, FAQ          |
| Payout control     | Verispon authorises the payout                                    | `CustodySection.tsx`, FAQ, footer  |
| Approved wording   | "our banking partner, Nomba"                                      | `CustodySection.tsx`               |
| Launch status      | **Pre-launch, early access only**                                 | Every CTA, FAQ, meta description   |
| Legal entity       | Netsible Solutions NG Limited                                     | Footer, `/privacy`, `/terms`       |
| Privacy & Terms    | Drafted for review by a qualified legal adviser                   | `/privacy`, `/terms`               |

Notes on how these are expressed:

- **Pre-launch** is stated plainly rather than hidden: primary CTAs say "Get
  Early Access" and route to WhatsApp, the FAQ answers "Can I use Verispon
  today?" with "Not yet", and the WhatsApp demo is labelled "Preview of the
  flow Verispon will run".
- **No licensing, regulatory, insurance, guarantee or payout-protection claim**
  is made about Nomba or Verispon anywhere. That boundary is deliberate —
  do not add such a claim without written confirmation from the partner.
- **The fee wording on `/privacy` and `/terms` must be kept in step** with
  `FeesSection.tsx`. There are two copies; change both.

## 2. Fees — remaining business decisions

The headline rates are confirmed, but the PRD still lists these as open
(§19 business policy). None of them are on the public site yet, and none should
be until they are settled:

- Fee handling on **cancellations** (distinct from outright failures, which are
  now answered).
- Fee handling on a **dispute resolved with a partial settlement**.
- Fee handling on **failed delivery** where the buyer is not at fault.
- Whether the ₦10,000 cap is per transaction, per side, or per day.
- Supported currencies. The site currently implies Naira only.

## 3. Identity / KYC

The site makes no NIN claim and no "verify once" claim, correctly: PRD §7 says
phone, email and identity verification are **separate statuses** and that the
provider, required levels and production thresholds "remain subject to partner
and compliance confirmation".

Needed: which checks are required at MVP, and the public wording used to
describe them.

## 4. `/privacy` and `/terms` — drafted, not approved

Both pages exist and are linked from the footer. Each carries a visible "Draft
for review" banner and states that it is not legal advice.

They still need a real lawyer. Gaps to close before approving:

- **Retention periods** for each category of record (privacy page currently
  flags this).
- **Governing law and jurisdiction** — neither draft names either. Needed.
- **Dispute and liability carve-outs** reviewed against the actual Verispon
  business rules.
- **Data controller / DPO contact details** — currently "contact us on WhatsApp",
  which is probably not sufficient for a data protection notice.
- **Cookie / tracking** — no cookie notice exists yet. Required if any
  non-essential tracking is added before launch.

## 5. WhatsApp number (`src/lib/whatsapp-config.ts`)

`WHATSAPP_NUMBER = "2348100337646"` predates this work and is used by every
contact CTA. Confirm it is the official public number before launch. The
landing hero CTA points at `/whatsapp`, which redirects using
`VERISPON_WHATSAPP_NUMBER` from the server environment.

## 6. Marketplace early access (`src/components/landing/MarketplacesSection.tsx`)

Positioned as an opportunity, with a **Request Early Access** WhatsApp CTA. The
right-hand figure is a placeholder diagram; no platform logos or partner names
are shown because none exist yet.

Needed: what platform access actually looks like (API scope, integration
effort, commercial terms) before this can be more specific.

## 7. Imagery (`src/components/landing/ScenariosSection.tsx`)

Sections were matched to images by intent only (`marketplace.jpg`,
`freelancer.jpg`, `goods.jpg` — the previous version swapped the first two).
`goods.jpg` was copied from `public/images/images/` to `public/` so
`/goods.jpg` resolves.

Needed: a human visual check of each image against its section on a real
device. Replace files rather than recycling another section's image.

## 8. Brand assets

The shield + checkmark is inline SVG matching the logo description. There is no
`verispon-logo.svg`/`.png` in the repo. Needed: the real logo file to replace
the inline mark in `Header.tsx` and `FooterColumns.tsx`, and a favicon
matching it.

The accent token was moved from amber `#FFC857` to warm coral `#FF8A4C`
(`--vs-gold` / `--vs-gold-ink` in `globals.css`) to match the described
orange/coral checkmark gradient. Confirm against the source logo.

## 9. PRD needs updating

The PRD is now behind the website in three places:

- §15 still lists Paystack, Nomba, Paybeta, Kuda and Flutterwave all at
  _Evaluate_. **Nomba is confirmed** for collection, custody and settlement.
- §15/§19 still treat fees as TBD. **Buyer 2% / seller 1% / ₦10,000 is
  confirmed.**
- The document does not state that Verispon is pre-launch and running an
  early-access list.

## 10. Removed content that should not come back

The previous site carried claims with no basis in the PRD. These are gone and
must not be reintroduced without evidence:

- "92% dispute-free release rate", "fraud rates below 0.5%" and other invented
  metrics (the `/blog` page listed six posts with these statistics and linked
  to article routes that did not exist).
- "One-time NIN verification" / "One NIN check unlocks every future
  transaction".
- A named courier partner in the WhatsApp demo.
- "Platform API access is a planned product direction, not a live integration"
  and "we will not borrow another provider's claims" — internal language.
- Fake contact details: `+234 8100337646` / `+44 223344455` tel links.
- Every `href="#"` placeholder CTA and footer link.

## 11. Pre-existing repo issue (not introduced here)

`pnpm --filter verispon-web lint` runs `next lint`, which no longer exists in
Next 16, and `apps/web` has no `eslint.config.mjs` (the shared config lives in
`packages/eslint-config` and is not referenced). Lint was already broken before
this work. `typecheck`, `test` (27 passing) and `build` all pass.
