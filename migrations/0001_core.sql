-- 0001_core.sql — PAIRED engine M1 core schema.
-- Identity (Clerk authenticates; THIS database owns roles, permissions, entitlements),
-- membership state, founding-seat allocation, durable event inbox, jobs, audit log.
-- Money law (M0): all monetary amounts in later migrations are INTEGER CENTS. No floats, ever.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Accounts: one row per Clerk user, stable internal id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL UNIQUE,
  email         text,
  display_name  text,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_email_idx ON accounts (lower(email));

-- ---------------------------------------------------------------------------
-- Roles: Neon owns permissions. A user may hold several roles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_roles (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('buyer', 'artist', 'moderator', 'admin')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, role)
);

-- ---------------------------------------------------------------------------
-- Memberships: server-owned tier authority. The frontend never decides tier.
-- status mirrors the Stripe subscription lifecycle, reconciled by webhooks (M6).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memberships (
  account_id             uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  tier                   text NOT NULL DEFAULT 'solo'
                         CHECK (tier IN ('solo', 'paired', 'ensemble', 'inner_circle', 'founding')),
  status                 text NOT NULL DEFAULT 'none'
                         CHECK (status IN ('none', 'trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  stripe_customer_id     text,
  stripe_subscription_id text,
  current_period_end     timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memberships_stripe_customer_idx
  ON memberships (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Founding 100: applications + transactional seat allocation.
-- Counters can never exceed 100 or double-allocate: seats are physical rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS founding_applications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  note       text,
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by uuid REFERENCES accounts(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS founding_applications_account_idx
  ON founding_applications (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS founding_applications_status_idx
  ON founding_applications (status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS founding_seats (
  seat_no    int PRIMARY KEY CHECK (seat_no BETWEEN 1 AND 100),
  account_id uuid UNIQUE REFERENCES accounts(id),
  claimed_at timestamptz
);
INSERT INTO founding_seats (seat_no)
SELECT generate_series(1, 100)
ON CONFLICT (seat_no) DO NOTHING;
CREATE INDEX IF NOT EXISTS founding_seats_free_idx
  ON founding_seats (seat_no) WHERE account_id IS NULL;

-- ---------------------------------------------------------------------------
-- Event inbox: signature-verified webhooks land here FIRST (durable, unique
-- event id, duplicates ignored), then an idempotent worker applies them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_inbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL CHECK (source IN ('clerk', 'stripe')),
  event_id     text NOT NULL UNIQUE,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  last_error   text
);
CREATE INDEX IF NOT EXISTS event_inbox_unprocessed_idx
  ON event_inbox (received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Jobs: database-backed background work (durable retries, no silent loss).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_after  timestamptz NOT NULL DEFAULT now(),
  attempts   int NOT NULL DEFAULT 0,
  locked_at  timestamptz,
  done_at    timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_runnable_idx
  ON jobs (run_after) WHERE done_at IS NULL;

-- ---------------------------------------------------------------------------
-- Audit log: every sensitive/admin action — actor, reason, timestamp.
-- Money-related manual overrides are forbidden without a row here (M0).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_account_id uuid REFERENCES accounts(id),
  action           text NOT NULL,
  target           text,
  reason           text,
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_account_id, created_at DESC);
