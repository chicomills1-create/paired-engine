// Checkout creation: the 7-condition buy-door recheck matrix, the
// immutable fee snapshot, the 15-minute one-of-one reservation, Stripe
// failure compensation, and reservation expiry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';
import { installFakeStripe, stripeState } from './helpers/fakestripe.js';

stubClerk();
installFakeStripe();
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call } = await import('./helpers/testapp.js');
const { makeArtist, makeListing, checkoutOk } = await import('./helpers/commerce.js');
const { expireStaleReservations } = await import('../src/lib/checkout.js');

let pool;
let app;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
});

after(async () => {
  await app.close();
  await pool.end();
});

async function checkout(buyer, listingId) {
  return call(app, { method: 'POST', url: `/v1/listings/${listingId}/checkout`, as: buyer });
}

test('happy path: snapshot, reservation, and the four records land together', async () => {
  await makeArtist(app, pool, 'aria', { tier: 'paired' });
  const listingId = await makeListing(app, 'aria', { priceCents: 20000 });

  const before = Date.now();
  const res = await checkout('bob', listingId);
  assert.equal(res.statusCode, 201, res.body);
  const { order, checkoutUrl } = res.json();
  assert.ok(checkoutUrl.includes('cs_test_'));
  assert.equal(order.status, 'checkout_open');
  assert.equal(order.priceCents, 20000);
  assert.deepEqual(order.feeSnapshot, {
    tier: 'paired',
    entitledTier: 'paired',
    rateBps: 500,
    calcVersion: 'v1',
    artistShareCents: 19000,
    platformShareCents: 1000,
  });
  assert.equal(order.fulfillment.state, 'awaiting_shipment');
  assert.equal(order.payment.status, 'requires_payment');
  assert.equal(order.release.state, 'awaiting_conditions');
  assert.equal(order.release.transferState, 'not_started');
  assert.equal(order.release.payoutState, 'unknown');

  const { rows: listing } = await pool.query('SELECT * FROM listings WHERE id = $1', [listingId]);
  assert.equal(listing[0].inventory_state, 'reserved');
  assert.equal(listing[0].reservation_ref, order.id);
  const until = new Date(listing[0].reserved_until).getTime();
  assert.ok(until > before + 14 * 60 * 1000 && until < before + 16 * 60 * 1000, '15-minute hold');

  const session = stripeState.sessions.at(-1);
  assert.equal(session.params.line_items[0].price_data.unit_amount, 20000);
  assert.equal(session.params.metadata.order_id, order.id);
  assert.equal(session.params.payment_intent_data.transfer_group, `order_${order.id}`);
});

test('fee snapshots follow the tier: solo 8%, ensemble 3%, founding rides paired', async () => {
  await makeArtist(app, pool, 'solo_sam', { tier: 'solo' });
  const soloListing = await makeListing(app, 'solo_sam', { priceCents: 20000 });
  const solo = await checkoutOk(app, 'buyer_solo', soloListing);
  assert.equal(solo.order.feeSnapshot.rateBps, 800);
  assert.equal(solo.order.feeSnapshot.artistShareCents, 18400);

  await makeArtist(app, pool, 'ens_ema', { tier: 'ensemble' });
  const ensListing = await makeListing(app, 'ens_ema', { priceCents: 20000 });
  const ens = await checkoutOk(app, 'buyer_ens', ensListing);
  assert.equal(ens.order.feeSnapshot.rateBps, 300);
  assert.equal(ens.order.feeSnapshot.artistShareCents, 19400);

  await makeArtist(app, pool, 'founder_flo', { tier: 'founding' });
  const fListing = await makeListing(app, 'founder_flo', { priceCents: 20000 });
  const f = await checkoutOk(app, 'buyer_f', fListing);
  assert.equal(f.order.feeSnapshot.tier, 'founding');
  assert.equal(f.order.feeSnapshot.entitledTier, 'paired');
  assert.equal(f.order.feeSnapshot.rateBps, 500);
});

test('recheck matrix: each closed condition fails by name', async () => {
  // listing_published
  await makeArtist(app, pool, 'draft_dan', {});
  const draftId = await makeListing(app, 'draft_dan', { publish: false });
  let res = await checkout('buyer_x', draftId);
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.failed.includes('listing_published'));

  // artist_verified
  await makeArtist(app, pool, 'unvera', { verified: false });
  const unvListing = await makeListing(app, 'unvera', {});
  res = await checkout('buyer_x', unvListing);
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.failed.includes('artist_verified'));

  // artist_payout_path_live — no Connect, no manual rail
  await makeArtist(app, pool, 'norail', { connectState: 'not_started', manualRail: false });
  const norailListing = await makeListing(app, 'norail', {});
  res = await checkout('buyer_x', norailListing);
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.failed.includes('artist_payout_path_live'));

  // ...but the manual rail opens the same door
  await makeArtist(app, pool, 'manual_meg', { connectState: 'not_started', manualRail: true });
  const megListing = await makeListing(app, 'manual_meg', {});
  res = await checkout('buyer_x', megListing);
  assert.equal(res.statusCode, 201, res.body);

  // buyer_is_not_seller
  res = await checkout('manual_meg', megListing);
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.failed.includes('buyer_is_not_seller'));

  // price_above_zero (a published zero-price row, inserted directly —
  // the publish guard keeps the routes from ever making one)
  await makeArtist(app, pool, 'zero_zoe', {});
  const zoeId = await (async () => {
    const { rows } = await pool.query(
      `SELECT id FROM accounts WHERE clerk_user_id = 'clerk_zero_zoe'`,
    );
    const ins = await pool.query(
      `INSERT INTO listings (account_id, title, price_cents, type, status)
       VALUES ($1, 'Free?', 0, 'physical', 'published') RETURNING id`,
      [rows[0].id],
    );
    return ins.rows[0].id;
  })();
  res = await checkout('buyer_x', zoeId);
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.failed.includes('price_above_zero'));

  // inventory_available — a sold piece
  await makeArtist(app, pool, 'sold_sue', {});
  const sueListing = await makeListing(app, 'sold_sue', {});
  await pool.query(`UPDATE listings SET inventory_state = 'sold' WHERE id = $1`, [sueListing]);
  res = await checkout('buyer_x', sueListing);
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.failed.includes('inventory_available'));
});

test('no_open_dispute_freeze is pair-scoped: same buyer blocked, others pass', async () => {
  await makeArtist(app, pool, 'freeze_fred', {});
  const first = await makeListing(app, 'freeze_fred', { title: 'First' });
  const { order } = await checkoutOk(app, 'buyer_f1', first);
  await pool.query(
    `UPDATE payments SET dispute_state = 'open' WHERE order_id = $1`,
    [order.id],
  );
  const second = await makeListing(app, 'freeze_fred', { title: 'Second' });
  const blocked = await checkout('buyer_f1', second);
  assert.equal(blocked.statusCode, 422);
  assert.ok(blocked.json().error.failed.includes('no_open_dispute_freeze'));
  const allowed = await checkout('buyer_f2', second);
  assert.equal(allowed.statusCode, 201, allowed.body);
});

test('a second buyer cannot check out a reserved piece; one order exists', async () => {
  await makeArtist(app, pool, 'race_rue', {});
  const listingId = await makeListing(app, 'race_rue', {});
  const first = await checkout('buyer_r1', listingId);
  assert.equal(first.statusCode, 201);
  const second = await checkout('buyer_r2', listingId);
  assert.equal(second.statusCode, 422);
  assert.ok(second.json().error.failed.includes('inventory_available'));
  const { rows } = await pool.query('SELECT * FROM orders WHERE listing_id = $1', [listingId]);
  assert.equal(rows.length, 1);
});

test('a Stripe session failure compensates: order canceled, piece released', async () => {
  await makeArtist(app, pool, 'fail_faye', {});
  const listingId = await makeListing(app, 'fail_faye', {});
  stripeState.failNextSessionCreate = true;
  const res = await checkout('buyer_z', listingId);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, 'stripe_error');
  const { rows: orders } = await pool.query('SELECT * FROM orders WHERE listing_id = $1', [listingId]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, 'canceled');
  const { rows: listing } = await pool.query('SELECT inventory_state FROM listings WHERE id = $1', [listingId]);
  assert.equal(listing[0].inventory_state, 'available');
  const retry = await checkout('buyer_z', listingId);
  assert.equal(retry.statusCode, 201, retry.body);
});

test('expired reservations sweep: order canceled, piece sellable again', async () => {
  await makeArtist(app, pool, 'exp_eli', {});
  const listingId = await makeListing(app, 'exp_eli', {});
  const { order } = await checkoutOk(app, 'buyer_e1', listingId);
  await pool.query(
    `UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [order.id],
  );
  await pool.query(
    `UPDATE listings SET reserved_until = now() - interval '1 minute' WHERE id = $1`,
    [listingId],
  );
  const swept = await expireStaleReservations(pool);
  assert.equal(swept, 1);
  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(o[0].status, 'canceled');
  const { rows: l } = await pool.query('SELECT inventory_state FROM listings WHERE id = $1', [listingId]);
  assert.equal(l[0].inventory_state, 'available');
  const again = await checkout('buyer_e2', listingId);
  assert.equal(again.statusCode, 201, again.body);
});
