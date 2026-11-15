// The release engine: the full condition matrix, one-transfer-ever
// idempotency, fee-snapshot immutability (including after a tier
// change), the manual rail, the admin override's exact limits, transfer
// failure recovery, and the commerce sweeps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';
import { installFakeStripe, stripeState } from './helpers/fakestripe.js';

stubClerk();
installFakeStripe();
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor, grantRole } = await import('./helpers/testapp.js');
const {
  makeArtist,
  makeListing,
  checkoutOk,
  deliverStripeEvent,
  sessionCompletedEvent,
} = await import('./helpers/commerce.js');
const { evaluateRelease, runCommerceSweeps } = await import('../src/lib/release.js');
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

async function settledOrder(artistName, buyerName, { tier = 'paired', priceCents = 20000, type = 'physical', artistOpts = {} } = {}) {
  await makeArtist(app, pool, artistName, { tier, ...artistOpts });
  const listingId = await makeListing(app, artistName, { priceCents, type });
  const { order } = await checkoutOk(app, buyerName, listingId);
  const { rows } = await pool.query('SELECT stripe_checkout_session_id FROM orders WHERE id = $1', [order.id]);
  const rec = stripeState.sessions.find((s) => s.session.id === rows[0].stripe_checkout_session_id);
  await deliverStripeEvent(pool, sessionCompletedEvent(order, rows[0].stripe_checkout_session_id, rec.session.payment_intent));
  return { orderId: order.id, listingId };
}

async function shipAndDeliver(orderId, artistName) {
  let res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/ship`, as: artistName, payload: { carrier: 'UPS', trackingNumber: '1Z1' } });
  assert.equal(res.statusCode, 200, res.body);
  res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/deliver`, as: artistName, payload: {} });
  assert.equal(res.statusCode, 200, res.body);
}

test('condition matrix: blockers fall one by one until the transfer fires — once', async () => {
  const { orderId } = await settledOrder('mx_mona', 'buyer_m1');
  const stripe = getStripe();

  let res = await evaluateRelease(pool, stripe, orderId);
  assert.equal(res.transferred, false);
  assert.ok(res.blockers.includes('delivery_evidence_missing'));
  assert.ok(res.blockers.includes('not_accepted'));
  assert.equal(stripeState.transfers.length, 0);

  await shipAndDeliver(orderId, 'mx_mona');
  res = await evaluateRelease(pool, stripe, orderId);
  assert.equal(res.transferred, false);
  assert.deepEqual(res.blockers, ['not_accepted']);

  // Window expiry converts to acceptance inside the engine.
  await pool.query(
    `UPDATE fulfillments SET acceptance_due_at = now() - interval '1 hour' WHERE order_id = $1`,
    [orderId],
  );
  res = await evaluateRelease(pool, stripe, orderId);
  assert.equal(res.transferred, true);
  assert.equal(stripeState.transfers.length, 1);
  const t = stripeState.transfers[0];
  assert.equal(t.params.amount, 19000);
  assert.equal(t.params.destination, 'acct_mx_mona');
  assert.equal(t.opts.idempotencyKey, `transfer:${orderId}`);

  const { rows: f } = await pool.query('SELECT state, acceptance_source FROM fulfillments WHERE order_id = $1', [orderId]);
  assert.equal(f[0].state, 'accepted');
  assert.equal(f[0].acceptance_source, 'window');
  const { rows: r } = await pool.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(r[0].transfer_state, 'created');
  assert.equal(r[0].payout_state, 'pending');
  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  assert.equal(o[0].status, 'released');
  const { rows: l } = await pool.query(
    `SELECT amount_cents FROM ledger_entries WHERE order_id = $1 AND kind = 'transfer'`,
    [orderId],
  );
  assert.equal(l.length, 1);
  assert.equal(l[0].amount_cents, 19000);

  // One transfer per order, ever — repeated evaluations are no-ops.
  await evaluateRelease(pool, stripe, orderId);
  await evaluateRelease(pool, stripe, orderId);
  assert.equal(stripeState.transfers.length, 1);
});

test('digital: delivery + logged download + buyer acceptance releases', async () => {
  const { orderId } = await settledOrder('dg_dana', 'buyer_d1', { type: 'digital' });
  let res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/deliver`, as: 'dg_dana', payload: { deliveryRef: 'accounts/x/master.zip' } });
  assert.equal(res.statusCode, 200, res.body);

  const stripe = getStripe();
  const early = await evaluateRelease(pool, stripe, orderId);
  assert.equal(early.transferred, false);
  assert.ok(early.blockers.includes('delivery_evidence_missing')); // no download yet

  res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/download`, as: 'buyer_d1' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().order.fulfillment.downloads, 1);

  res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/accept`, as: 'buyer_d1' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().order.release.transferState, 'created');
  assert.equal(res.json().order.status, 'released');
});

test('digital: window expiry alone completes the evidence and releases', async () => {
  const { orderId } = await settledOrder('dg_drew', 'buyer_d2', { type: 'digital' });
  const res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/deliver`, as: 'dg_drew', payload: { deliveryRef: 'accounts/y/master.zip' } });
  assert.equal(res.statusCode, 200, res.body);
  await pool.query(
    `UPDATE fulfillments SET acceptance_due_at = now() - interval '1 hour' WHERE order_id = $1`,
    [orderId],
  );
  const out = await evaluateRelease(pool, getStripe(), orderId);
  assert.equal(out.transferred, true);
});

test('commission: start → deliver → revision → deliver → accept → release', async () => {
  // Commission orders ride the same engine; the listing kind drives the
  // workflow (briefs themselves arrive with the M4 board).
  await makeArtist(app, pool, 'cm_cleo', { tier: 'solo' });
  const { rows: cleo } = await pool.query(`SELECT id FROM accounts WHERE clerk_user_id = 'clerk_cm_cleo'`);
  const ins = await pool.query(
    `INSERT INTO listings (account_id, title, price_cents, type, status)
     VALUES ($1, 'Commission slot', 30000, 'digital', 'published') RETURNING id`,
    [cleo[0].id],
  );
  // A commission-kind order is created directly at the record level here
  // (checkout for commissions opens with the M4 brief flow).
  const { order } = await checkoutOk(app, 'buyer_c1', ins.rows[0].id);
  await pool.query(`UPDATE orders SET kind = 'commission' WHERE id = $1`, [order.id]);
  await pool.query(`UPDATE fulfillments SET kind = 'commission', state = 'awaiting_start' WHERE order_id = $1`, [order.id]);
  const rec = stripeState.sessions.find((s) => s.params.metadata.order_id === order.id);
  await deliverStripeEvent(pool, sessionCompletedEvent(order, rec.session.id, rec.session.payment_intent));

  let res = await call(app, { method: 'POST', url: `/v1/orders/${order.id}/start`, as: 'cm_cleo' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().order.fulfillment.state, 'in_progress');
  res = await call(app, { method: 'POST', url: `/v1/orders/${order.id}/deliver`, as: 'cm_cleo', payload: { note: 'first pass' } });
  assert.equal(res.json().order.fulfillment.state, 'delivered');
  res = await call(app, { method: 'POST', url: `/v1/orders/${order.id}/request-revision`, as: 'buyer_c1', payload: { note: 'warmer sky' } });
  assert.equal(res.json().order.fulfillment.state, 'revision_requested');
  res = await call(app, { method: 'POST', url: `/v1/orders/${order.id}/deliver`, as: 'cm_cleo', payload: { note: 'revised' } });
  assert.equal(res.json().order.fulfillment.state, 'delivered');
  res = await call(app, { method: 'POST', url: `/v1/orders/${order.id}/accept`, as: 'buyer_c1' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().order.status, 'released');
  assert.equal(res.json().order.release.transferState, 'created');
  const t = stripeState.transfers.at(-1);
  assert.equal(t.params.amount, 27600); // solo 8% of $300
});

test('fee snapshot is immutable — tier changes and direct writes cannot move it', async () => {
  const { orderId } = await settledOrder('im_ivan', 'buyer_i1', { tier: 'paired' });
  await pool.query(
    `UPDATE memberships SET tier = 'ensemble'
      WHERE account_id = (SELECT artist_account_id FROM orders WHERE id = $1)`,
    [orderId],
  );
  const { rows: o } = await pool.query('SELECT fee_rate_bps, artist_share_cents FROM orders WHERE id = $1', [orderId]);
  assert.equal(o[0].fee_rate_bps, 500);
  assert.equal(o[0].artist_share_cents, 19000);

  await assert.rejects(
    pool.query('UPDATE orders SET fee_rate_bps = 300 WHERE id = $1', [orderId]),
    /immutable/,
  );
  await assert.rejects(pool.query('UPDATE ledger_entries SET amount_cents = 1'), /immutable/);
  await assert.rejects(pool.query('DELETE FROM ledger_entries'), /immutable/);

  await shipAndDeliver(orderId, 'im_ivan');
  const res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/accept`, as: 'buyer_i1' });
  assert.equal(res.statusCode, 200, res.body);
  const t = stripeState.transfers.at(-1);
  assert.equal(t.params.amount, 19000); // snapshot price, not the new tier's
});

test('manual rail: release records without Stripe; ledger carries the rail', async () => {
  const transfersBefore = stripeState.transfers.length;
  const { orderId } = await settledOrder('mr_moss', 'buyer_mr', {
    artistOpts: { connectState: 'not_started', manualRail: true },
  });
  await shipAndDeliver(orderId, 'mr_moss');
  const res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/accept`, as: 'buyer_mr' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().order.release.transferState, 'manual_recorded');
  assert.equal(res.json().order.release.rail, 'manual');
  assert.equal(res.json().order.status, 'released');
  assert.equal(stripeState.transfers.length, transfersBefore); // no Stripe transfer
  const { rows: l } = await pool.query(
    `SELECT meta FROM ledger_entries WHERE order_id = $1 AND kind = 'transfer'`,
    [orderId],
  );
  assert.equal(l.length, 1);
  assert.equal(l[0].meta.rail, 'manual');
});

test('stripe rail without a Stripe client stays ready with the blocker named', async () => {
  const { orderId } = await settledOrder('nc_nina', 'buyer_n1');
  await shipAndDeliver(orderId, 'nc_nina');
  await call(app, { method: 'POST', url: `/v1/orders/${orderId}/accept`, as: 'buyer_n1' });
  // The accept above released via the configured client; use a fresh
  // order to isolate the no-client evaluation.
  const second = await settledOrder('nc_nina', 'buyer_n2');
  await shipAndDeliver(second.orderId, 'nc_nina');
  const { rows: f } = await pool.query('SELECT state FROM fulfillments WHERE order_id = $1', [second.orderId]);
  assert.equal(f[0].state, 'delivered');
  await pool.query(
    `UPDATE fulfillments SET state = 'accepted', accepted_at = now(), acceptance_source = 'buyer' WHERE order_id = $1`,
    [second.orderId],
  );
  const res = await evaluateRelease(pool, null, second.orderId);
  assert.equal(res.transferred, false);
  assert.deepEqual(res.blockers, ['stripe_not_configured']);
  assert.equal(res.release.state, 'ready');
  const done = await evaluateRelease(pool, getStripe(), second.orderId);
  assert.equal(done.transferred, true);
});

test('admin override: reason required, acceptance-only, audited; dispute is never overridden', async () => {
  await call(app, { method: 'GET', url: '/v1/artist/profile', as: 'boss_admin' });
  const bossId = await accountIdFor(pool, 'boss_admin');
  await grantRole(pool, bossId, 'admin');

  const { orderId } = await settledOrder('ov_olga', 'buyer_o1');
  await shipAndDeliver(orderId, 'ov_olga');

  // Not an admin → 403. Admin without a reason → 400.
  let res = await call(app, { method: 'POST', url: `/v1/admin/orders/${orderId}/release`, as: 'buyer_o1', payload: { reason: 'please' } });
  assert.equal(res.statusCode, 403);
  res = await call(app, { method: 'POST', url: `/v1/admin/orders/${orderId}/release`, as: 'boss_admin', payload: {} });
  assert.equal(res.statusCode, 400);

  res = await call(app, { method: 'POST', url: `/v1/admin/orders/${orderId}/release`, as: 'boss_admin', payload: { reason: 'Buyer confirmed receipt by phone; artist verified' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().transferred, true);
  const { rows: audit } = await pool.query(
    `SELECT * FROM audit_log WHERE action = 'release.override' AND target = $1`,
    [`order:${orderId}`],
  );
  assert.equal(audit.length, 1);
  assert.match(audit[0].reason, /confirmed receipt by phone/);
  const { rows: rel } = await pool.query('SELECT released_by FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel[0].released_by, bossId);

  // With an open dispute, even an admin reason cannot release.
  const second = await settledOrder('ov_olga', 'buyer_o2');
  await shipAndDeliver(second.orderId, 'ov_olga');
  await pool.query(`UPDATE payments SET dispute_state = 'open' WHERE order_id = $1`, [second.orderId]);
  res = await call(app, { method: 'POST', url: `/v1/admin/orders/${second.orderId}/release`, as: 'boss_admin', payload: { reason: 'override attempt' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().transferred, false);
  assert.ok(res.json().blockers.includes('dispute_open'));
});

test('a failed transfer is recorded and a later evaluation retries it', async () => {
  const { orderId } = await settledOrder('tf_tess', 'buyer_tf');
  await shipAndDeliver(orderId, 'tf_tess');
  await call(app, { method: 'POST', url: `/v1/orders/${orderId}/accept`, as: 'buyer_tf' });
  // accept already transferred it; build a second order for the failure leg
  const second = await settledOrder('tf_tess', 'buyer_tf2');
  await shipAndDeliver(second.orderId, 'tf_tess');
  await pool.query(
    `UPDATE fulfillments SET state = 'accepted', accepted_at = now(), acceptance_source = 'buyer' WHERE order_id = $1`,
    [second.orderId],
  );
  await pool.query(`UPDATE orders SET status = 'accepted' WHERE id = $1`, [second.orderId]);
  stripeState.failNextTransfer = true;
  const failed = await evaluateRelease(pool, getStripe(), second.orderId);
  assert.equal(failed.transferred, false);
  const { rows: rel } = await pool.query('SELECT state, transfer_state FROM releases WHERE order_id = $1', [second.orderId]);
  assert.equal(rel[0].state, 'failed');
  assert.equal(rel[0].transfer_state, 'failed');
  const retried = await evaluateRelease(pool, getStripe(), second.orderId);
  assert.equal(retried.transferred, true);
});

test('commerce sweeps: windows convert and accepted orders release', async () => {
  const { orderId } = await settledOrder('sw_sven', 'buyer_sw');
  await shipAndDeliver(orderId, 'sw_sven');
  await pool.query(
    `UPDATE fulfillments SET acceptance_due_at = now() - interval '2 hours' WHERE order_id = $1`,
    [orderId],
  );
  const out = await runCommerceSweeps(pool, getStripe());
  assert.ok(out.windowsAccepted >= 1);
  assert.ok(out.transfersCompleted >= 1);
  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  assert.equal(o[0].status, 'released');
});

test('orders are invisible to third parties', async () => {
  const { orderId } = await settledOrder('pv_pia', 'buyer_pv');
  const stranger = await call(app, { method: 'GET', url: `/v1/orders/${orderId}`, as: 'stranger' });
  assert.equal(stranger.statusCode, 404);
  const buyer = await call(app, { method: 'GET', url: `/v1/orders/${orderId}`, as: 'buyer_pv' });
  assert.equal(buyer.statusCode, 200);
  const artist = await call(app, { method: 'GET', url: `/v1/orders/${orderId}`, as: 'pv_pia' });
  assert.equal(artist.statusCode, 200);
  const sales = await call(app, { method: 'GET', url: '/v1/orders/sales', as: 'pv_pia' });
  assert.equal(sales.json().orders.length, 1);
});
