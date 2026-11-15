-- 0003_commerce.sql — PAIRED engine M3 schema.
-- Commerce & fulfillment: FOUR separate records (Order / Payment /
-- Fulfillment / Ledger) per M0 + the consult — financial truth never
-- derives from a display. Integer cents everywhere; no floats, ever.
-- The fee snapshot on the order is IMMUTABLE (trigger-enforced) and ledger
-- entries are APPEND-ONLY (trigger-enforced): corrections are new entries,
-- never edits. No record anywhere uses escrow language (M0).

-- ---------------------------------------------------------------------------
-- Manual payout rail (M0 §7 interim cycle): until an artist's Connect
-- account is active, ops may approve the manual rail (Friday batch) per
-- artist. The flag lives on the onboarding row so payout-path state has
-- exactly one home. Set only by an admin action with an audit row.
-- ---------------------------------------------------------------------------
ALTER TABLE connect_onboarding
  ADD COLUMN IF NOT EXISTS manual_rail boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Orders: the commercial record. One order = one piece (one-of-one) bought
-- by one buyer from one artist through one checkout.
-- Status chain (consult): checkout_open → paid → fulfilling → delivered →
-- accepted → released → completed, with canceled / refunded as terminal
-- exception states. Dispute state lives on the payment, never here.
-- The fee snapshot columns (price_cents, fee_*) are written once at
-- checkout creation and can never change (trigger below).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id           uuid NOT NULL REFERENCES accounts(id),
  artist_account_id          uuid NOT NULL REFERENCES accounts(id),
  listing_id                 uuid REFERENCES listings(id),
  kind                       text NOT NULL DEFAULT 'physical'
                             CHECK (kind IN ('physical', 'digital', 'commission')),
  status                     text NOT NULL DEFAULT 'checkout_open'
                             CHECK (status IN ('checkout_open', 'paid', 'fulfilling',
                                               'delivered', 'accepted', 'released',
                                               'completed', 'canceled', 'refunded')),
  price_cents                integer NOT NULL CHECK (price_cents > 0),
  currency                   text NOT NULL DEFAULT 'USD',
  fee_tier                   text NOT NULL,
  fee_entitled_tier          text NOT NULL,
  fee_rate_bps               integer NOT NULL CHECK (fee_rate_bps >= 0),
  fee_calc_version           text NOT NULL,
  artist_share_cents         integer NOT NULL CHECK (artist_share_cents >= 0),
  platform_share_cents       integer NOT NULL CHECK (platform_share_cents >= 0),
  stripe_checkout_session_id text UNIQUE,
  reservation_ref            text,
  reservation_expires_at     timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (artist_share_cents + platform_share_cents = price_cents),
  CHECK (buyer_account_id <> artist_account_id)
);
CREATE INDEX IF NOT EXISTS orders_buyer_idx ON orders (buyer_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_artist_idx ON orders (artist_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_listing_idx ON orders (listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, created_at)
  WHERE status IN ('checkout_open', 'paid', 'fulfilling', 'delivered', 'accepted');

CREATE OR REPLACE FUNCTION forbid_fee_snapshot_change() RETURNS trigger AS $$
BEGIN
  IF NEW.price_cents IS DISTINCT FROM OLD.price_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.fee_tier IS DISTINCT FROM OLD.fee_tier
     OR NEW.fee_entitled_tier IS DISTINCT FROM OLD.fee_entitled_tier
     OR NEW.fee_rate_bps IS DISTINCT FROM OLD.fee_rate_bps
     OR NEW.fee_calc_version IS DISTINCT FROM OLD.fee_calc_version
     OR NEW.artist_share_cents IS DISTINCT FROM OLD.artist_share_cents
     OR NEW.platform_share_cents IS DISTINCT FROM OLD.platform_share_cents THEN
    RAISE EXCEPTION 'order fee snapshot is immutable (price, currency, fee_* columns are written once at purchase)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS orders_fee_snapshot_immutable ON orders;
CREATE TRIGGER orders_fee_snapshot_immutable
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION forbid_fee_snapshot_change();

-- ---------------------------------------------------------------------------
-- Payments: the money-in record — one per order (separate charges model:
-- the platform charges the buyer on its own account, then transfers).
-- settled_at marks the funds as settled/available for release purposes.
-- dispute_state tracks the card-network dispute on THIS payment only; a
-- dispute freezes this order's unreleased leg and nothing else (M0).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id         text,
  amount_cents             integer NOT NULL CHECK (amount_cents >= 0),
  currency                 text NOT NULL DEFAULT 'USD',
  status                   text NOT NULL DEFAULT 'requires_payment'
                           CHECK (status IN ('requires_payment', 'processing', 'succeeded',
                                             'failed', 'canceled', 'refunded', 'partially_refunded')),
  settled_at               timestamptz,
  dispute_state            text NOT NULL DEFAULT 'none'
                           CHECK (dispute_state IN ('none', 'open', 'won', 'lost')),
  stripe_dispute_id        text,
  refunded_cents           integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_charge_idx ON payments (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_dispute_idx ON payments (dispute_state)
  WHERE dispute_state = 'open';

-- ---------------------------------------------------------------------------
-- Fulfillments: the delivery record — DISTINCT state machines per kind
-- (physical / digital / commission) over the shared financial core.
-- Delivery evidence + the 7-day acceptance window (M0) live here:
-- delivered_at starts the window; acceptance is the buyer's act or the
-- window's expiry (acceptance_source records which).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fulfillments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('physical', 'digital', 'commission')),
  state             text NOT NULL
                    CHECK (state IN ('awaiting_shipment', 'shipped', 'delivered',
                                     'awaiting_delivery', 'awaiting_start', 'in_progress',
                                     'revision_requested', 'accepted', 'lost',
                                     'returned', 'canceled')),
  carrier           text,
  tracking_number   text,
  delivery_ref      text,
  delivery_evidence jsonb,
  shipped_at        timestamptz,
  delivered_at      timestamptz,
  acceptance_due_at timestamptz,
  accepted_at       timestamptz,
  acceptance_source text CHECK (acceptance_source IN ('buyer', 'window')),
  downloads         integer NOT NULL DEFAULT 0,
  last_download_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fulfillments_window_idx ON fulfillments (acceptance_due_at)
  WHERE state = 'delivered';

-- Every fulfillment transition leaves an evidence event (ship, deliver,
-- download, accept, revision…) with its actor — the audit trail behind
-- "delivery evidence present" in the release conditions.
CREATE TABLE IF NOT EXISTS fulfillment_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id   uuid NOT NULL REFERENCES fulfillments(id) ON DELETE CASCADE,
  event            text NOT NULL,
  actor_account_id uuid REFERENCES accounts(id),
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fulfillment_events_fulfillment_idx
  ON fulfillment_events (fulfillment_id, created_at);

-- ---------------------------------------------------------------------------
-- Releases: the money-out record — one per order, ever.
-- TRANSFER (platform → connected account) and PAYOUT (connected account →
-- artist's bank) are SEPARATE statuses (M0): transfer_state is ours to
-- observe at creation; payout_state starts unknown → pending and is only
-- advanced by attributable payout evidence (reconciliation, M6).
-- idempotency_key is the Stripe idempotency key for the transfer: one
-- transfer per order, ever, even under retries and races.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS releases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  state                 text NOT NULL DEFAULT 'awaiting_conditions'
                        CHECK (state IN ('awaiting_conditions', 'ready', 'transfer_created',
                                         'complete', 'blocked_dispute', 'failed')),
  transfer_state        text NOT NULL DEFAULT 'not_started'
                        CHECK (transfer_state IN ('not_started', 'created', 'paid',
                                                  'failed', 'manual_recorded')),
  payout_state          text NOT NULL DEFAULT 'unknown'
                        CHECK (payout_state IN ('unknown', 'pending', 'paid', 'failed', 'canceled')),
  rail                  text CHECK (rail IN ('stripe', 'manual')),
  stripe_transfer_id    text UNIQUE,
  stripe_payout_id      text,
  destination_account_id text,
  idempotency_key       text NOT NULL UNIQUE,
  blockers              jsonb NOT NULL DEFAULT '[]'::jsonb,
  released_by           uuid REFERENCES accounts(id),
  override_reason       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Ledger: append-only financial truth. Entries are never updated or
-- deleted (trigger below); a correction is a new entry. Amounts are
-- positive integer cents; `kind` carries the direction/semantics.
-- idempotency_key makes every money fact safe to record twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid REFERENCES orders(id),
  account_id      uuid REFERENCES accounts(id),
  kind            text NOT NULL
                  CHECK (kind IN ('sale_accrual', 'platform_fee', 'transfer',
                                  'payout', 'refund', 'recovery', 'adjustment')),
  amount_cents    integer NOT NULL CHECK (amount_cents >= 0),
  currency        text NOT NULL DEFAULT 'USD',
  stripe_object_id text,
  idempotency_key text NOT NULL UNIQUE,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_entries_order_idx ON ledger_entries (order_id, created_at);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account_id, created_at);

CREATE OR REPLACE FUNCTION forbid_ledger_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are immutable (append-only): record a correction as a new entry';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();

-- ---------------------------------------------------------------------------
-- Recovery cases: a dispute (or full refund) that lands AFTER the artist
-- was already transferred opens a case — never an automatic clawback (M0).
-- Resolution is an ops decision recorded here: artist fault (recover from
-- the artist) or platform loss (the platform absorbs it).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id),
  payment_id        uuid REFERENCES payments(id),
  stripe_dispute_id text,
  trigger_kind      text NOT NULL CHECK (trigger_kind IN ('dispute', 'refund')),
  state             text NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'under_review', 'resolved_artist_fault',
                                     'resolved_platform_loss', 'closed')),
  resolution_notes  text,
  resolved_by       uuid REFERENCES accounts(id),
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_cases_dispute_uq
  ON recovery_cases (stripe_dispute_id) WHERE stripe_dispute_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recovery_cases_order_idx ON recovery_cases (order_id, created_at);
