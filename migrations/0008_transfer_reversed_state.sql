-- 0008_transfer_reversed_state.sql — PAIRED engine transfer event mapping.
--
-- Stripe has retired the transfer.paid webhook event; current API
-- versions emit transfer.created / transfer.updated / transfer.reversed.
-- The engine now records a reversed transfer on the release itself
-- (src/lib/stripeEvents.js, transfer.reversed), which needs 'reversed'
-- in the transfer_state vocabulary. 0003 defined the CHECK without it,
-- so without this migration the reversal UPDATE would violate the
-- constraint inside the inbox transaction and the event could never
-- apply. All pre-existing states are preserved verbatim; 'reversed' is
-- the only addition. transfer_state remains separate from payout_state
-- (M0): a reversal says the platform→artist leg was pulled back by
-- Stripe; it asserts nothing about the artist's bank payout.

ALTER TABLE releases DROP CONSTRAINT IF EXISTS releases_transfer_state_check;
ALTER TABLE releases ADD CONSTRAINT releases_transfer_state_check
  CHECK (transfer_state IN ('not_started', 'created', 'paid',
                            'failed', 'manual_recorded', 'reversed'));
