import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyDoor, BUY_DOOR_CONDITIONS } from '../src/lib/buydoor.js';

function allPass() {
  return {
    artist: { status: 'active', approved: true },
    listing: { status: 'published', humanMadeVerification: 'approved', inventoryAvailable: 1 },
    sale: { saleType: 'original', currency: 'USD', destinationSupported: true },
    connectedAccount: { transfers: 'active', payouts: 'active' },
    holds: { compliance: false, fraud: false, moderation: false },
    reservation: { canReserve: true, checkoutCreatable: true },
  };
}

test('all conditions passing opens the door', () => {
  const result = buyDoor(allPass());
  assert.equal(result.ok, true);
  assert.deepEqual(result.failed, []);
});

test('empty input fails closed on every presence condition', () => {
  const result = buyDoor({});
  assert.equal(result.ok, false);
  // The hold condition is an absence check: no holds recorded = no hold
  // active, so it is the one leg that passes on empty input. The other six
  // all require positive evidence and fail closed.
  const expected = BUY_DOOR_CONDITIONS.filter((c) => c !== 'no_compliance_fraud_moderation_hold');
  assert.deepEqual([...result.failed].sort(), [...expected].sort());
});

test('a missing holds object passes the hold leg; any active hold blocks it', () => {
  const input = allPass();
  delete input.holds;
  assert.equal(buyDoor(input).ok, true);
  input.holds = { moderation: true };
  const blocked = buyDoor(input);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.failed, ['no_compliance_fraud_moderation_hold']);
});

// Each condition failing individually must block, and name exactly that condition.
const breakers = [
  ['artist_account_active_approved', (i) => { i.artist.status = 'suspended'; }],
  ['artist_account_active_approved', (i) => { i.artist.approved = false; }],
  ['listing_human_made_verified', (i) => { i.listing.humanMadeVerification = 'pending'; }],
  ['listing_published_with_inventory', (i) => { i.listing.status = 'draft'; }],
  ['listing_published_with_inventory', (i) => { i.listing.inventoryAvailable = 0; }],
  ['sale_type_destination_currency_supported', (i) => { i.sale.saleType = 'print-on-demand'; }],
  ['sale_type_destination_currency_supported', (i) => { i.sale.currency = 'EUR'; }],
  ['sale_type_destination_currency_supported', (i) => { i.sale.destinationSupported = false; }],
  ['connected_account_transfer_payout_capable', (i) => { i.connectedAccount.transfers = 'pending'; }],
  ['connected_account_transfer_payout_capable', (i) => { i.connectedAccount.payouts = 'restricted'; }],
  ['no_compliance_fraud_moderation_hold', (i) => { i.holds.compliance = true; }],
  ['no_compliance_fraud_moderation_hold', (i) => { i.holds.fraud = true; }],
  ['no_compliance_fraud_moderation_hold', (i) => { i.holds.moderation = true; }],
  ['no_compliance_fraud_moderation_hold', (i) => { i.holds = ['fraud']; }],
  ['server_can_reserve_and_create_checkout', (i) => { i.reservation.canReserve = false; }],
  ['server_can_reserve_and_create_checkout', (i) => { i.reservation.checkoutCreatable = false; }],
];

for (const [condition, breakIt] of breakers) {
  test(`failing ${condition} alone blocks the door`, () => {
    const input = allPass();
    breakIt(input);
    const result = buyDoor(input);
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, [condition]);
  });
}
