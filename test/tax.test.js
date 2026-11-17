// Activation §3 — Stripe Tax (ChatGPT consult 2026-11-16, TAX-01…04):
// every Checkout session carries automatic tax with platform liability,
// an explicit per-product tax code, tax-exclusive pricing, and the
// address collection its kind needs; a commission whose brief never
// declared a deliverable type fails closed; settlement math stays
// pinned to the order's price while the collected tax is recorded on
// the payment for reconciliation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';
import { installFakeStripe, stripeState } from './helpers/fakestripe.js';

stubClerk();
installFakeStripe();
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor } = await import('./helpers/testapp.js');
const { makeArtist, makeListing, checkoutOk, deliverStripeEvent, nextEventId } = await import(
  './helpers/commerce.js'
);
const { runReconciliation } = await import('../src/lib/reconcile.js');
const { getStripe } = await import('../src/stripe.js');

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

function lastSessionParams() {
  return stripeState.sessions.at(-1).params;
}

function assertCommonTax(params) {
  assert.deepEqual(params.automatic_tax, { enabled: true, liability: { type: 'self' } });
  assert.equal(params.line_items[0].price_data.tax_behavior, 'exclusive');
}

async function makeMusicListing(artistName, { priceCents = 1500 } = {}) {
  const artistId = await accountIdFor(pool, artistName);
  const { rows } = await pool.query(
    `INSERT INTO listings
       (account_id, title, price_cents, type, medium, status, inventory_state,
        rights_recording, rights_composition, rights_state, content_kind)
     VALUES ($1, 'Test Release', $2, 'digital', 'music', 'published', 'available',
             true, true, 'declared', 'original')
     RETURNING id`,
    [artistId, priceCents],
  );
  return rows[0].id;
}

async function postBrief(as, payload = {}) {
  return call(app, {
    method: 'POST',
    url: '/v1/briefs',
    as,
    payload: { title: 'Tax brief', budgetCents: 30000, ...payload },
  });
}

async function pitchAndAccept(briefId, artistName, buyerName) {
  const p = await call(app, {
    method: 'POST',
    url: `/v1/briefs/${briefId}/pitches`,
    as: artistName,
    payload: { priceCents: 30000, message: 'Ready when you are' },
  });
  assert.equal(p.statusCode, 201, p.body);
  const res = await call(app, {
    method: 'POST',
    url: `/v1/pitches/${p.json().pitch.id}/accept`,
    as: buyerName,
  });
  return { res, pitchId: p.json().pitch.id };
}

test('physical listing checkout: tangible-goods code, shipping collection, automatic tax', async () => {
  await makeArtist(app, pool, 'tax_phys');
  const listingId = await makeListing(app, 'tax_phys', { priceCents: 20000, type: 'physical' });
  const res = await call(app, { method: 'POST', url: `/v1/listings/${listingId}/checkout`, as: 'tax_buyer1' });
  assert.equal(res.statusCode, 201, res.body);
  const params = lastSessionParams();
  assertCommonTax(params);
  assert.equal(params.line_items[0].price_data.product_data.tax_code, 'txcd_99999999');
  assert.deepEqual(params.shipping_address_collection, { allowed_countries: ['US'] });
  assert.equal(params.billing_address_collection, undefined);
});

test('digital listing checkout: digital-artwork code, billing auto, no shipping collection', async () => {
  await makeArtist(app, pool, 'tax_digi');
  const listingId = await makeListing(app, 'tax_digi', { priceCents: 20000, type: 'digital' });
  const res = await call(app, { method: 'POST', url: `/v1/listings/${listingId}/checkout`, as: 'tax_buyer2' });
  assert.equal(res.statusCode, 201, res.body);
  const params = lastSessionParams();
  assertCommonTax(params);
  assert.equal(params.line_items[0].price_data.product_data.tax_code, 'txcd_10505001');
  assert.equal(params.billing_address_collection, 'auto');
  assert.equal(params.shipping_address_collection, undefined);
});

test('music release checkout: music code, billing auto, 0% snapshot intact', async () => {
  await makeArtist(app, pool, 'tax_music');
  const listingId = await makeMusicListing('tax_music');
  const { order } = await checkoutOk(app, 'tax_buyer3', listingId);
  const params = lastSessionParams();
  assertCommonTax(params);
  assert.equal(params.line_items[0].price_data.product_data.tax_code, 'txcd_10401100');
  assert.equal(params.billing_address_collection, 'auto');
  assert.equal(params.shipping_address_collection, undefined);
  assert.equal(order.feeSnapshot.rateBps, 0);
  assert.equal(order.feeSnapshot.artistShareCents, 1500);
});

test('commission checkout follows the brief declaration: physical', async () => {
  await makeArtist(app, pool, 'tax_com_phys');
  const brief = (await postBrief('tax_buyer4', { deliverableType: 'physical' })).json().brief;
  assert.equal(brief.deliverableType, 'physical');
  const { res } = await pitchAndAccept(brief.id, 'tax_com_phys', 'tax_buyer4');
  assert.equal(res.statusCode, 201, res.body);
  const params = lastSessionParams();
  assertCommonTax(params);
  assert.equal(params.line_items[0].price_data.product_data.tax_code, 'txcd_99999999');
  assert.deepEqual(params.shipping_address_collection, { allowed_countries: ['US'] });
  assert.equal(params.billing_address_collection, undefined);
});

test('commission checkout follows the brief declaration: digital', async () => {
  await makeArtist(app, pool, 'tax_com_digi');
  const brief = (await postBrief('tax_buyer5', { deliverableType: 'digital' })).json().brief;
  const { res } = await pitchAndAccept(brief.id, 'tax_com_digi', 'tax_buyer5');
  assert.equal(res.statusCode, 201, res.body);
  const params = lastSessionParams();
  assertCommonTax(params);
  assert.equal(params.line_items[0].price_data.product_data.tax_code, 'txcd_10505001');
  assert.equal(params.billing_address_collection, 'auto');
  assert.equal(params.shipping_address_collection, undefined);
});

test('commission checkout follows the brief declaration: service', async () => {
  await makeArtist(app, pool, 'tax_com_svc');
  const brief = (await postBrief('tax_buyer6', { deliverableType: 'service' })).json().brief;
  const { res } = await pitchAndAccept(brief.id, 'tax_com_svc', 'tax_buyer6');
  assert.equal(res.statusCode, 201, res.body);
  const params = lastSessionParams();
  assertCommonTax(params);
  assert.equal(params.line_items[0].price_data.product_data.tax_code, 'txcd_20030000');
  assert.equal(params.billing_address_collection, 'auto');
  assert.equal(params.shipping_address_collection, undefined);
});

test('an undeclared brief fails closed at accept: no session, no order, nothing awarded', async () => {
  await makeArtist(app, pool, 'tax_com_undeclared');
  const briefRes = await postBrief('tax_buyer7', {});
  assert.equal(briefRes.statusCode, 201, briefRes.body);
  const brief = briefRes.json().brief;
  assert.equal(brief.deliverableType, null);

  const sessionsBefore = stripeState.sessions.length;
  const { res, pitchId } = await pitchAndAccept(brief.id, 'tax_com_undeclared', 'tax_buyer7');
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.json().error.code, 'tax_classification_unresolved');
  assert.equal(stripeState.sessions.length, sessionsBefore);

  const { rows: orders } = await pool.query(
    'SELECT id FROM orders WHERE artist_account_id = $1',
    [await accountIdFor(pool, 'tax_com_undeclared')],
  );
  assert.equal(orders.length, 0);
  const { rows: pitch } = await pool.query('SELECT status FROM pitches WHERE id = $1', [pitchId]);
  assert.equal(pitch[0].status, 'pending');
  const { rows: b } = await pool.query('SELECT status FROM briefs WHERE id = $1', [brief.id]);
  assert.equal(b[0].status, 'open');
});

test('brief creation rejects an invalid deliverableType', async () => {
  const res = await postBrief('tax_buyer8', { deliverableType: 'hologram' });
  assert.equal(res.statusCode, 400, res.body);
});

test('settlement with tax: transfer is price × keep-rate, tax recorded, splits unchanged', async () => {
  await makeArtist(app, pool, 'tax_settle', { tier: 'solo' });
  const listingId = await makeListing(app, 'tax_settle', { priceCents: 20000, type: 'physical' });
  const { order } = await checkoutOk(app, 'tax_buyer9', listingId);
  const session = stripeState.sessions.at(-1).session;

  // The buyer paid price + tax (tax-exclusive): $200.00 + $11.00 tax.
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_tax_completed'),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: session.id,
        payment_intent: session.payment_intent,
        payment_status: 'paid',
        amount_total: 21100,
        total_details: { amount_tax: 1100 },
        currency: 'usd',
        metadata: { order_id: order.id },
      },
    },
  });

  const { rows: pay } = await pool.query('SELECT * FROM payments WHERE order_id = $1', [order.id]);
  assert.equal(pay[0].status, 'succeeded');
  assert.equal(pay[0].amount_cents, 20000);
  assert.equal(pay[0].tax_cents, 1100);

  // The ledger accruals are the fee snapshot of the PRICE — the tax
  // never enters the split (solo 8%: artist $184, platform $16).
  const { rows: ledger } = await pool.query(
    'SELECT kind, amount_cents FROM ledger_entries WHERE order_id = $1 ORDER BY kind',
    [order.id],
  );
  assert.deepEqual(
    ledger.map((r) => [r.kind, r.amount_cents]),
    [
      ['platform_fee', 1600],
      ['sale_accrual', 18400],
    ],
  );

  // Drive the physical loop to acceptance; the release transfers the
  // artist share of the PRICE — not of the $211 the buyer was charged.
  const ship = await call(app, {
    method: 'POST', url: `/v1/orders/${order.id}/ship`, as: 'tax_settle',
    payload: { carrier: 'UPS', trackingNumber: '1Z-TAX' },
  });
  assert.equal(ship.statusCode, 200, ship.body);
  const deliver = await call(app, {
    method: 'POST', url: `/v1/orders/${order.id}/confirm-delivery`, as: 'tax_buyer9',
  });
  assert.equal(deliver.statusCode, 200, deliver.body);
  const accept = await call(app, {
    method: 'POST', url: `/v1/orders/${order.id}/accept`, as: 'tax_buyer9',
  });
  assert.equal(accept.statusCode, 200, accept.body);
  assert.equal(accept.json().order.status, 'released');
  const transfer = stripeState.transfers.at(-1);
  assert.equal(transfer.params.amount, 18400);

  // Reconciliation sees the settled charge at price + tax and raises
  // NO payment_amount_mismatch for this order.
  stripeState.stripeCharges.push({
    id: 'ch_tax_settle',
    paid: true,
    status: 'succeeded',
    payment_intent: session.payment_intent,
    amount: 21100,
  });
  const result = await runReconciliation(pool, getStripe());
  assert.equal(result.ran, true);
  const mismatches = result.discrepancies.filter(
    (d) => d.kind === 'payment_amount_mismatch' && d.orderId === order.id,
  );
  assert.deepEqual(mismatches, []);
});
