-- 0007_tax_activation.sql — PAIRED engine activation §3 schema.
-- Two minimal additions, both in service of the Stripe Tax activation
-- (ChatGPT consult 2026-11-16, TAX-02 / TAX-04):
--
-- 1. briefs.deliverable_type — the commission board's tax classification
--    input. Neither briefs nor pitches carried any deliverable-type data,
--    so a commission's tax treatment had nothing lawful to resolve from.
--    The BRIEF is the buyer's declaration of what will be delivered, made
--    before any pitch or checkout exists, so the declaration lives here:
--    'physical' (a physical artwork is shipped), 'digital' (a finished
--    artwork delivered electronically), 'service' (the deliverable is the
--    artist's service). NULLABLE by design: briefs posted before this
--    column existed are UNDECLARED, and an undeclared brief fails closed
--    at pitch-accept (tax_classification_unresolved) — never classified
--    by a default, a guess, or the account preset.
--
-- 2. payments.tax_cents — the sales tax Stripe actually collected on the
--    order, recorded from the completed Checkout session
--    (total_details.amount_tax) at settlement. Tax-exclusive pricing
--    means the charge total is price + tax while payments.amount_cents
--    stays the item price; reconciliation compares the charge against
--    amount_cents + tax_cents. NULL until a session reports it (the
--    payment-intent event alone carries no tax figure).
--    Money law (M0) holds: integer cents, never a float.

ALTER TABLE briefs
  ADD COLUMN IF NOT EXISTS deliverable_type text
  CHECK (deliverable_type IN ('physical', 'digital', 'service'));

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS tax_cents integer
  CHECK (tax_cents IS NULL OR tax_cents >= 0);
