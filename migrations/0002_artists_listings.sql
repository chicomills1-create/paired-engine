-- 0002_artists_listings.sql — PAIRED engine M2 schema.
-- Artist profiles, human-made verification records, listings + media,
-- transactional one-of-one inventory state, Connect payout onboarding state.
-- Money law (M0): all prices are INTEGER CENTS. No floats, ever.

-- ---------------------------------------------------------------------------
-- Artist profiles: one row per account that presents as an artist.
-- `verified` is a DERIVED flag stored for read speed: it is maintained ONLY
-- by verification transitions (see verification_requests) and is recomputed
-- from the request records inside the decision transaction. It can never be
-- set directly by the artist — a verified record is the only source.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artist_profiles (
  account_id   uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  display_name text,
  bio          text,
  verified     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Verification requests: the human-made proof PROCESS record.
-- An artist submits a shop URL + the proof code shown on that shop (the
-- Instant Membership mechanic); a reviewer records a decision with evidence
-- notes. This is a process record — it attests that a human reviewed the
-- evidence, never that detection is infallible.
-- States: submitted → under_review → verified | rejected.
-- At most ONE open (submitted/under_review) request per account, enforced
-- by the partial unique index below as well as the route.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shop_url            text NOT NULL,
  proof_code          text NOT NULL,
  state               text NOT NULL DEFAULT 'submitted'
                      CHECK (state IN ('submitted', 'under_review', 'verified', 'rejected')),
  reviewer_account_id uuid REFERENCES accounts(id),
  evidence_notes      text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_requests_account_idx
  ON verification_requests (account_id, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS verification_requests_open_uq
  ON verification_requests (account_id)
  WHERE state IN ('submitted', 'under_review');

-- ---------------------------------------------------------------------------
-- Listings: artist-owned artworks for sale.
-- status: draft → published → archived (draft again on unarchive).
-- inventory_state is the one-of-one state machine (M0): available →
-- reserved (transactional, with expiry + an opaque reservation reference)
-- → sold; reserved → available on release/expiry. Transitions happen ONLY
-- through the atomic guarded UPDATE in src/lib/inventory.js — never by
-- writing the column directly from a route.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title           text,
  description     text,
  category        text,
  price_cents     integer CHECK (price_cents IS NULL OR price_cents >= 0),
  type            text NOT NULL DEFAULT 'physical'
                  CHECK (type IN ('physical', 'digital')),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'archived')),
  inventory_state text NOT NULL DEFAULT 'available'
                  CHECK (inventory_state IN ('available', 'reserved', 'sold')),
  reserved_until  timestamptz,
  reservation_ref text,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listings_account_idx
  ON listings (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS listings_public_idx
  ON listings (status, category, created_at DESC)
  WHERE status = 'published';

-- ---------------------------------------------------------------------------
-- Listing media: objects in S3-compatible storage, attached to a listing by
-- the owning artist after direct-to-storage upload. object_key is always
-- namespaced accounts/<account_id>/<uuid>.<ext> (enforced at the route).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_media (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  kind       text NOT NULL DEFAULT 'image' CHECK (kind IN ('image')),
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, object_key)
);
CREATE INDEX IF NOT EXISTS listing_media_listing_idx
  ON listing_media (listing_id, position, created_at);

-- ---------------------------------------------------------------------------
-- Connect onboarding: the artist's payout-account link state.
-- State machine: not_started → link_issued → pending → active | restricted.
-- stripe_account_id is set when the connected account is first created and
-- is then reused forever (one connected account per artist).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect_onboarding (
  account_id        uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  stripe_account_id text UNIQUE,
  state             text NOT NULL DEFAULT 'not_started'
                    CHECK (state IN ('not_started', 'link_issued', 'pending', 'active', 'restricted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
