-- 0009_intake.sql — PAIRED engine v91: the unified intake layer.
--
-- ChatGPT verdict of record: REVIEW-VERDICT-V91-2026-11-26 (APPROVE WITH
-- REQUIRED EDITS). Write-through architecture: the existing business
-- tables stay canonical (briefs, pitches, founding_applications); this
-- layer adds, for every submission, ONE unified record carrying the
-- reference, the receipt, the operational review state and the
-- customer-facing history — plus an append-only event trail. The two
-- layers never mutate the same business facts: canonical writes and
-- their intake records commit in ONE transaction (verdict edit A1), so
-- a submission can never hold a reference without its canonical record,
-- nor a canonical record exist without its intake record.
--
-- References (verdict edit A3): 'PAIRED-' + 10 characters from an
-- unambiguous CSPRNG alphabet (~49 bits) over a uuid primary key. The
-- reference is a retrieval credential for guests (paired with the
-- contact email), never a sequential counter.
--
-- Idempotency (verdict edit A4): every submission carries an explicit
-- scope + key; the unique pair is the dedupe law for accounts AND
-- guests (a nullable owner id is never part of the key, so the Postgres
-- NULL-distinct hole cannot open). Same key + same payload returns the
-- original; same key + different payload is rejected by the routes.
--
-- Status storage: internal codes use underscores (UNDER_REVIEW,
-- ACTION_REQUIRED, PROPOSALS_RECEIVED, IN_DISCUSSION, IN_PROGRESS,
-- SHARED_WITH_BUYER); the customer-facing labels are the verdict §C
-- dictionary, applied at the view layer (src/lib/intake.js).
--
-- LEGACY POLICY (verdict edit A5) — founding applications: backfilled
-- below with is_legacy = true, their ORIGINAL created_at preserved,
-- status mapped pending→RECEIVED / approved→APPROVED /
-- rejected→DECLINED, reference 'PAIRED-LEGACY-…'. Briefs and pitches
-- created before this migration are NOT backfilled: they keep their
-- canonical path only (documented decision). Two consequences, both
-- deliberate: (a) the public board grandfather rule — a brief with NO
-- intake record is governed by its canonical status exactly as before;
-- a brief WITH an intake record is public only once that record is
-- VISIBLE or beyond; (b) GET /v1/me/commission-briefs lists legacy
-- briefs from the canonical table with reference = NULL.
--
-- RETENTION / DELETION (verdict §D4): intake payloads are retained for
-- 24 months after a submission reaches a terminal state, then ops may
-- redact the payload (the reference, status and event trail remain as
-- the accountability record). A verified deletion request from the
-- submitter is honored by redaction of payload + contact email with an
-- ops event recording the act. Payloads are never written to routine
-- application logs (routes log ids and references only).

CREATE TABLE IF NOT EXISTS intake_submissions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference            text NOT NULL UNIQUE,
  type                 text NOT NULL
                       CHECK (type IN ('artist', 'collector', 'collaboration', 'brief', 'proposal', 'founding')),
  owner_account_id     uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_email        text,
  status               text NOT NULL DEFAULT 'RECEIVED'
                       CHECK (status IN ('RECEIVED', 'UNDER_REVIEW', 'ACTION_REQUIRED',
                                         'APPROVED', 'DECLINED', 'CLOSED',
                                         'VISIBLE', 'PROPOSALS_RECEIVED', 'IN_DISCUSSION',
                                         'ACCEPTED', 'IN_PROGRESS', 'DELIVERED',
                                         'SHARED_WITH_BUYER', 'WITHDRAWN')),
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash         text NOT NULL,
  consent_at           timestamptz,
  source               text NOT NULL DEFAULT 'site',
  idempotency_scope    text NOT NULL,
  idempotency_key      text NOT NULL,
  canonical_table      text,
  canonical_id         uuid,
  linked_submission_id uuid REFERENCES intake_submissions(id) ON DELETE SET NULL,
  assigned_to          uuid REFERENCES accounts(id) ON DELETE SET NULL,
  action_note          text,
  close_reason         text,
  is_legacy            boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS intake_submissions_queue_idx
  ON intake_submissions (type, status, created_at);
CREATE INDEX IF NOT EXISTS intake_submissions_owner_idx
  ON intake_submissions (owner_account_id, created_at DESC)
  WHERE owner_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS intake_submissions_canonical_idx
  ON intake_submissions (canonical_table, canonical_id)
  WHERE canonical_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS intake_submissions_email_idx
  ON intake_submissions (lower(contact_email))
  WHERE contact_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS intake_submissions_linked_idx
  ON intake_submissions (linked_submission_id)
  WHERE linked_submission_id IS NOT NULL;

-- Append-only audit trail (verdict §E: status changes create IMMUTABLE
-- audit events). One row per fact: receipt, every status transition,
-- reviewer assignment, ops note, request-info, close. The trigger below
-- makes UPDATE/DELETE impossible at the database layer, not merely by
-- route discipline.
CREATE TABLE IF NOT EXISTS intake_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id    uuid NOT NULL REFERENCES intake_submissions(id) ON DELETE CASCADE,
  actor_type       text NOT NULL CHECK (actor_type IN ('customer', 'ops', 'system')),
  actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  kind             text NOT NULL DEFAULT 'status'
                   CHECK (kind IN ('received', 'status', 'note', 'assign', 'request_info', 'close', 'legacy_backfill')),
  from_status      text,
  to_status        text,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intake_events_submission_idx
  ON intake_events (submission_id, created_at);

CREATE OR REPLACE FUNCTION intake_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'intake_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS intake_events_no_mutate ON intake_events;
CREATE TRIGGER intake_events_no_mutate
  BEFORE UPDATE OR DELETE ON intake_events
  FOR EACH ROW EXECUTE FUNCTION intake_events_append_only();

-- ---------------------------------------------------------------------------
-- Legacy backfill: founding applications (see LEGACY POLICY above).
-- Idempotent by the (scope, key) unique pair; original timestamps kept.
-- ---------------------------------------------------------------------------
INSERT INTO intake_submissions
  (reference, type, owner_account_id, contact_email, status, payload,
   payload_hash, source, idempotency_scope, idempotency_key,
   canonical_table, canonical_id, is_legacy, created_at, updated_at)
SELECT
  'PAIRED-LEGACY-' || substr(md5(f.id::text), 1, 10),
  'founding',
  f.account_id,
  a.email,
  CASE f.status WHEN 'pending' THEN 'RECEIVED'
                WHEN 'approved' THEN 'APPROVED'
                WHEN 'rejected' THEN 'DECLINED' END,
  jsonb_build_object('note', f.note, 'origin', 'founding_application'),
  md5(f.id::text || coalesce(f.note, '')),
  'backfill-0009',
  'legacy',
  'founding:' || f.id::text,
  'founding_applications',
  f.id,
  true,
  f.created_at,
  f.created_at
FROM founding_applications f
JOIN accounts a ON a.id = f.account_id
ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING;

INSERT INTO intake_events (submission_id, actor_type, kind, from_status, to_status, note, created_at)
SELECT s.id, 'system', 'legacy_backfill', NULL, s.status,
       'Historical record attached to the intake layer by migration 0009; original timestamps preserved.',
       s.created_at
FROM intake_submissions s
WHERE s.is_legacy AND s.source = 'backfill-0009'
  AND NOT EXISTS (SELECT 1 FROM intake_events e WHERE e.submission_id = s.id);
