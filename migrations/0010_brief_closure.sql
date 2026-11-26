-- 0010 (v93, C-23): the canonical brief carries its own closure record.
-- When a commission brief closes — by the buyer (cancel) or by ops through
-- the Intake Desk — the brief row records WHEN it closed and WHO closed it,
-- so every surface that reads the canonical brief (Board, Studio, account)
-- can state the same closure the intake record states, instead of the two
-- records disagreeing (intake CLOSED while the brief still read "open").
-- closed_by: 'desk' = ops via the Intake Desk · 'buyer' = the brief's owner.
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS closed_by TEXT
  CHECK (closed_by IN ('desk', 'buyer'));
