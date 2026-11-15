-- 0004_studio_ops.sql — PAIRED engine M4/M5/M6 schema.
-- M4: buyer engagement (saves, follows, listing view events) + the
-- commission board (briefs + pitches). M5: Common Room (posts, blocks,
-- reports). M6: the reconciliation exception queue.
-- Money law (M0) holds: budgets and pitch prices are INTEGER CENTS.

-- ---------------------------------------------------------------------------
-- Saves: a buyer saves a listing. One row per (account, listing); saving
-- twice is the same fact, never two rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saves (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, listing_id)
);
CREATE INDEX IF NOT EXISTS saves_listing_idx ON saves (listing_id);

-- ---------------------------------------------------------------------------
-- Follows: a buyer follows an artist. One row per (follower, artist);
-- an account can never follow itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS follows (
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  artist_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, artist_account_id),
  CHECK (account_id <> artist_account_id)
);
CREATE INDEX IF NOT EXISTS follows_artist_idx ON follows (artist_account_id);

-- ---------------------------------------------------------------------------
-- Listing views: the view EVENT record behind every views count in the
-- Studio. Counts always derive from these rows — never from a display.
-- viewer_account_id is NULL for anonymous reads; the listing owner's own
-- views are never recorded (enforced at the route).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_views (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  viewer_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listing_views_listing_idx
  ON listing_views (listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS listing_views_viewer_idx
  ON listing_views (listing_id, viewer_account_id, created_at DESC)
  WHERE viewer_account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Briefs: commission board posts. A buyer posts a brief with a real
-- budget; artists pitch; accepting a pitch awards the brief and creates
-- the commission order (src/lib/commissions.js). Status: open → awarded
-- (terminal for pitching) or open → canceled (buyer withdraws).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS briefs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  budget_cents     integer NOT NULL CHECK (budget_cents > 0),
  category         text,
  status           text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'awarded', 'canceled')),
  awarded_pitch_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS briefs_buyer_idx ON briefs (buyer_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS briefs_open_idx ON briefs (created_at DESC) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Pitches: an artist's response to a brief — a real price and a message.
-- One pitch per artist per brief. At most ONE accepted pitch per brief
-- (partial unique index): the award is a database fact, not a hope.
-- Unaccepted pitches create no obligations (consult M4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pitches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id          uuid NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  artist_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  price_cents       integer NOT NULL CHECK (price_cents > 0),
  message           text,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  order_id          uuid REFERENCES orders(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brief_id, artist_account_id)
);
CREATE INDEX IF NOT EXISTS pitches_brief_idx ON pitches (brief_id, created_at);
CREATE INDEX IF NOT EXISTS pitches_artist_idx ON pitches (artist_account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS pitches_one_accepted_uq
  ON pitches (brief_id) WHERE status = 'accepted';

ALTER TABLE briefs
  ADD CONSTRAINT briefs_awarded_pitch_fk
  FOREIGN KEY (awarded_pitch_id) REFERENCES pitches(id);

-- ---------------------------------------------------------------------------
-- Common Room posts: one table, parent_id NULL = top-level post, set =
-- a reply in that post's thread. Moderation states: visible → hidden
-- (ops, reversible) | removed (ops, terminal for display). Authors may
-- not edit history — there is deliberately no edit path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_posts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES room_posts(id) ON DELETE CASCADE,
  body       text NOT NULL,
  status     text NOT NULL DEFAULT 'visible'
             CHECK (status IN ('visible', 'hidden', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_posts_feed_idx
  ON room_posts (created_at DESC) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS room_posts_thread_idx
  ON room_posts (parent_id, created_at) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS room_posts_author_idx ON room_posts (account_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Blocks: blocker → blocked. A blocked account's posts are hidden from
-- the blocker everywhere in the room; blocking also severs the reply
-- path in both directions (enforced at the route).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocks (
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, blocked_account_id),
  CHECK (account_id <> blocked_account_id)
);

-- ---------------------------------------------------------------------------
-- Reports: the moderation queue's intake. A report targets a post or an
-- account; one OPEN report per (reporter, target) — duplicates collapse.
-- Decisions (actioned | dismissed) are admin acts with an audit row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_kind       text NOT NULL CHECK (target_kind IN ('post', 'account')),
  post_id           uuid REFERENCES room_posts(id) ON DELETE CASCADE,
  target_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  reason            text,
  state             text NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'actioned', 'dismissed')),
  decided_by        uuid REFERENCES accounts(id),
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_kind = 'post' AND post_id IS NOT NULL)
      OR (target_kind = 'account' AND target_account_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS reports_open_idx ON reports (created_at) WHERE state = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS reports_open_post_uq
  ON reports (reporter_account_id, post_id)
  WHERE state = 'open' AND target_kind = 'post';
CREATE UNIQUE INDEX IF NOT EXISTS reports_open_account_uq
  ON reports (reporter_account_id, target_account_id)
  WHERE state = 'open' AND target_kind = 'account';

-- ---------------------------------------------------------------------------
-- Exception queue (M6): reconciliation discrepancies and other money
-- exceptions that need a human decision. dedupe_key makes the
-- reconciliation job idempotent: the same discrepancy re-observed bumps
-- updated_at on the OPEN row instead of piling up duplicates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exception_queue (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL,
  order_id          uuid REFERENCES orders(id),
  account_id        uuid REFERENCES accounts(id),
  stripe_object_id  text,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key        text NOT NULL UNIQUE,
  state             text NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'acknowledged', 'resolved')),
  resolution_reason text,
  resolved_by       uuid REFERENCES accounts(id),
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exception_queue_open_idx
  ON exception_queue (created_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS exception_queue_order_idx
  ON exception_queue (order_id) WHERE order_id IS NOT NULL;
