-- 0006_support_questions.sql — PAIRED engine ASK PAIRED cure schema.
-- Desk cure order 2026-11-15 (mailto-class audit): the Ask Paired form
-- on pairedart.com stored the question only in the visitor's own
-- localStorage and handed off via a mailto: link, while the on-page ack
-- claimed the question was "on its way to a human" — unearned. This
-- table is the server record that makes the ack true: every question
-- asked through the form lands here, with a reference (ASK-XXXXXX, the
-- house PAIRED-XXXXXX style) the visitor can quote and ops can read
-- back through GET /v1/admin/support/questions.
--
-- Ask Paired is a PUBLIC surface: rows carry the visitor's own stated
-- name + email, never an account id (most askers are signed out).

CREATE TABLE IF NOT EXISTS support_questions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference  text NOT NULL UNIQUE,
  name       text NOT NULL,
  email      text NOT NULL,
  question   text NOT NULL,
  status     text NOT NULL DEFAULT 'open'
             CHECK (status IN ('open', 'answered', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_questions_created_idx
  ON support_questions (created_at DESC);
CREATE INDEX IF NOT EXISTS support_questions_status_idx
  ON support_questions (status, created_at DESC);
