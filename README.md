# PAIRED Engine

The API service behind [pairedart.com](https://pairedart.com) — the marketplace
engine ordered 2026-11-14 ("Make it 100% operable"). One modular API service
plus a background worker; no microservices (consult cut, adopted).

**Milestone state:** M1 scaffold — identity + shared plumbing. Listings (M2),
commerce/fulfillment (M3), Studio (M4), Common Room + admin (M5), hardening
(M6) and independent certification (M7) build on this foundation. Governing
docs: `../ops-prep/ENGINE-BUILD-PLAN-2026-11-14.md` and
`../ops-prep/ENGINE-M0-CONTRACTS-2026-11-15.md` (binding).

## Architecture

```
pairedart.com SPA (GitHub Pages, static)
        │  Bearer <Clerk session token>
        ▼
paired-engine (this service, Render) ──► Neon Postgres (paired-production)
        │                                   ▲
        ├── Clerk (PRODUCTION instance) ────┘  webhooks → event_inbox → worker
        └── Stripe (Apex account, interim MoR; TEST MODE until M7 + live auth)
```

Laws baked into the code:

- **Clerk authenticates; Neon owns.** Roles, permissions, membership tier and
  commercial state live in this database and are resolved server-side on
  every protected request (`src/auth.js`). The frontend never decides tier,
  verified status, or eligibility.
- **Webhooks are durable.** Signature-verified events land in `event_inbox`
  first (unique event id, duplicates ignored), then an idempotent worker
  (`src/inbox.js` `processInbox`, run by `src/worker.js`) applies them.
  Failed applications keep `attempts`/`last_error` and stay unprocessed —
  nothing silently disappears.
- **Money is integer cents, always.** No float money columns anywhere, in
  any migration, ever. Four separate records arrive in M3 — Order · Payment ·
  Fulfillment · Ledger — and financial truth never derives from a display.
- **Fee snapshots are immutable** (`src/lib/fees.js`): tier + entitled tier +
  rate + calc version + shares are computed once at purchase and stored on
  the order. Rates: Solo 8% · Paired 5% · Ensemble 3%. Founding ($6/mo) is a
  subscription price, not a rate — the artist's entitled tier sets the rate.
  Processing is absorbed by the platform; the artist share is price × keep.
- **The buy door** (`src/lib/buydoor.js`): a listing is purchasable only when
  all 7 conditions pass (artist active+approved · listing human-made verified ·
  published with inventory · supported sale type/destination/currency ·
  connected account transfer+payout capable · no compliance/fraud/moderation
  hold · server can reserve + create checkout). Re-checked server-side at
  checkout creation in M3.
- **Founding seats are transactional** (`src/routes/founding.js`): seats are
  physical rows 1–100; an admin approval claims the lowest free seat in the
  same transaction that records the decision and writes the audit row.
  Approval also sets the membership tier to `founding` and grants the
  `artist` role (billing state binds later, in M6). A rejection frees
  nothing — a rejected application never held a seat.
- **No escrow language, ever** (M0). Funds sit in the platform's Stripe
  balance under Stripe's terms; no surface may call it escrow or guaranteed
  protection.

## Env contract

See `.env.example`. `DATABASE_URL` (Neon), `CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `PORT`. Secrets are provided by the platform
(Render env / local `.env`, gitignored) — never committed, never logged.
The engine boots without Stripe keys (identity legs work; money legs fail
closed). It refuses protected work without Clerk keys (401s).

## Running

```bash
npm install
npm run migrate     # apply migrations/*.sql not yet in schema_migrations
npm start           # API on $PORT (default 10000)
npm run worker      # inbox worker (separate process)
npm test            # node --test — fees, buy-door, migration smoke (skipped
                    # unless TEST_DATABASE_URL points at a throwaway DB)
```

Migrations: plain SQL files in `migrations/`, applied in filename order by
`src/db.js` `runMigrations()`, each in its own transaction, recorded in
`schema_migrations`. Never edit an applied migration — add the next number.

> **Ops note (this VM only):** direct TCP/5432 egress from the build VM is
> intercepted, so `scripts/apply-migrations-neon.py` fetches the Neon
> connection URI transiently (environment only, never printed or stored) and
> runs `scripts/migrate-tunneled.mjs`, which tunnels through the HTTP proxy
> with correct TLS SNI. On any normal network (Render included) plain
> `npm run migrate` is the path; the tunneled runner is a local workaround,
> not part of the service.

## Routes (M1)

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | — | `{ok:true, db:'up'}` after a real `SELECT 1` (503 when down) |
| `POST /webhooks/clerk` | svix signature | raw event → `event_inbox`, fast 200, duplicates ignored |
| `GET /v1/me` | Clerk Bearer | account + roles + membership (server truth) |
| `POST /v1/founding/apply` | Clerk Bearer | create founding application (409 if one is pending/approved) |
| `GET /v1/founding/status` | Clerk Bearer | my application, my seat, seats claimed / 100 |
| `POST /v1/admin/founding/decide` | Clerk Bearer + `admin` role | approve (atomic seat claim) / reject; audit-logged |

Granting the first admin: insert the role row directly in Neon for the
founder's account (`INSERT INTO account_roles VALUES (<account_id>, 'admin')`)
— there is deliberately no API for self-granting admin.

## Routes (M4–M6)

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/briefs` · `GET /v1/briefs` · `GET /v1/briefs/:id` · `POST /v1/briefs/:id/cancel` | Bearer (board reads public/soft) | commission briefs with real budgets |
| `POST /v1/briefs/:id/pitches` · `GET /v1/briefs/:id/pitches` · `POST /v1/pitches/:id/accept` · `/reject` · `/withdraw` | Bearer | artist pitches; accept creates the commission order through the M3 machinery (fail-closed without Stripe) |
| `POST/DELETE /v1/listings/:id/save` · `POST /v1/listings/:id/view` · `POST/DELETE /v1/artists/:accountId/follow` | Bearer | saves, view events, follows |
| `GET /v1/studio/seller` · `GET /v1/studio/buyer` | Bearer | both Studio faces — every value traced to a server record; transfer_state ≠ payout_state |
| `POST /v1/room/posts` · `GET /v1/room/posts` · `GET /v1/room/posts/:id` | Bearer | Common Room posts + one-level threads |
| `POST /v1/room/reports` · `POST /v1/room/blocks` · `DELETE /v1/room/blocks/:accountId` · `GET /v1/room/blocks` | Bearer | reports into the admin queue; blocks hide + sever replies |
| `GET /v1/admin/verifications/queue` · `GET /v1/admin/founding/applications` · `GET /v1/admin/orders` | Bearer + `admin` | console reads (the queue never returns proof codes) |
| `POST /v1/admin/reports/:id/decide` · `POST /v1/admin/room/posts/:id/moderate` | Bearer + `admin` | moderation decisions — reason required, audit-logged |
| `GET /v1/admin/exceptions` · `POST /v1/admin/exceptions/:id/acknowledge` · `/resolve` | Bearer + `admin` | the reconciliation exception queue |

Admin law (M5): every admin action requires a `reason` (400 without) and
writes `audit_log` with actor + reason + timestamp. That rule now covers
the founding decide and the verification decide (`evidenceNotes`) too.

Ops scripts: `node scripts/reconcile.mjs` runs one Stripe ↔ ledger
reconciliation pass on demand (the worker + API service also run it on
`RECONCILE_INTERVAL_MS`, default 15 min; discrepancies land in
`exception_queue`, dedupe-keyed and idempotent). `node
scripts/restore-drill.mjs` executes the backup/restore rehearsal against
throwaway PGlite databases and prints the per-table count record.

## Schema (0001_core)

`accounts` (Clerk-linked, soft-delete via status) · `account_roles`
(buyer/artist/moderator/admin) · `memberships` (tier + Stripe binding fields)
· `founding_applications` · `founding_seats` (seeded 1–100) · `event_inbox` ·
`jobs` · `audit_log` (actor + reason + timestamp on every sensitive action).
