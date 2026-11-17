// Stripe webhook application: settlement happens exactly once across
// duplicate and twin deliveries, disputes freeze only their own order's
// leg, post-transfer disputes open recovery cases (never a clawback),
// expired sessions cancel cleanly, and refunds land as records.
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
const {
  makeArtist,
  makeListing,
  checkoutOk,
  deliverStripeEvent,
  sessionCompletedEvent,
  nextEventId,
} = await import('./helpers/commerce.js');
const { evaluateRelease } = await import('../src/lib/release.js');
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

async function settledOrder(artistName, buyerName, { tier = 'paired', priceCents = 20000, type = 'physical' } = {}) {
  await makeArtist(app, pool, artistName, { tier });
  const listingId = await makeListing(app, artistName, { priceCents, type });
  const { order } = await checkoutOk(app, buyerName, listingId);
  const { rows } = await pool.query('SELECT stripe_checkout_session_id FROM orders WHERE id = $1', [order.id]);
  const sessionId = rows[0].stripe_checkout_session_id;
  const rec = stripeState.sessions.find((s) => s.session.id === sessionId);
  const paymentIntentId = rec.session.payment_intent;
  await deliverStripeEvent(pool, sessionCompletedEvent(order, sessionId, paymentIntentId));
  return { orderId: order.id, listingId, sessionId, paymentIntentId };
}

async function fulfillToAccepted(orderId, artistName, buyerName) {
  let res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/ship`, as: artistName, payload: { carrier: 'UPS', trackingNumber: '1Z999' } });
  assert.equal(res.statusCode, 200, res.body);
  res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/deliver`, as: artistName, payload: {} });
  assert.equal(res.statusCode, 200, res.body);
  res = await call(app, { method: 'POST', url: `/v1/orders/${orderId}/accept`, as: buyerName });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().order;
}

test('session.completed settles exactly once across duplicate + twin deliveries', async () => {
  const { orderId, sessionId, paymentIntentId } = await settledOrder('hook_hana', 'buyer_h1');
  let { rows: p } = await pool.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
  assert.equal(p[0].status, 'succeeded');
  assert.ok(p[0].settled_at);
  assert.equal(p[0].stripe_payment_intent_id, paymentIntentId);
  let { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  assert.equal(o[0].status, 'paid');
  let { rows: l } = await pool.query('SELECT kind, amount_cents FROM ledger_entries WHERE order_id = $1 ORDER BY kind', [orderId]);
  assert.deepEqual(l.map((x) => [x.kind, x.amount_cents]), [['platform_fee', 1000], ['sale_accrual', 19000]]);

  // Same event id redelivered (ignored at insert) AND the same session
  // under a fresh event id (applied, but state-guarded to a no-op), AND
  // the twin payment_intent.succeeded — still exactly one settlement.
  const order = { id: orderId, priceCents: 20000 };
  await deliverStripeEvent(pool, sessionCompletedEvent(order, sessionId, paymentIntentId));
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_pi'),
    type: 'payment_intent.succeeded',
    data: { object: { id: paymentIntentId, latest_charge: 'ch_twin', metadata: { order_id: orderId } } },
  });
  ({ rows: l } = await pool.query('SELECT * FROM ledger_entries WHERE order_id = $1', [orderId]));
  assert.equal(l.length, 2);
  ({ rows: p } = await pool.query('SELECT * FROM payments WHERE order_id = $1', [orderId]));
  assert.equal(p[0].stripe_charge_id, 'ch_twin'); // ids still get recorded
  const { rows: inv } = await pool.query('SELECT inventory_state FROM listings WHERE id = (SELECT listing_id FROM orders WHERE id = $1)', [orderId]);
  assert.equal(inv[0].inventory_state, 'sold');
});

test('payment_intent.succeeded alone settles an order', async () => {
  await makeArtist(app, pool, 'pi_pia', { tier: 'solo' });
  const listingId = await makeListing(app, 'pi_pia', { priceCents: 10000 });
  const { order } = await checkoutOk(app, 'buyer_pi', listingId);
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_pi'),
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_manual_1', latest_charge: 'ch_pi_1', metadata: { order_id: order.id } } },
  });
  const { rows: p } = await pool.query('SELECT * FROM payments WHERE order_id = $1', [order.id]);
  assert.equal(p[0].status, 'succeeded');
  assert.equal(p[0].stripe_charge_id, 'ch_pi_1');
  const { rows: l } = await pool.query('SELECT kind, amount_cents FROM ledger_entries WHERE order_id = $1 ORDER BY kind', [order.id]);
  assert.deepEqual(l.map((x) => [x.kind, x.amount_cents]), [['platform_fee', 800], ['sale_accrual', 9200]]);
});

test('a foreign checkout session (membership link) is recorded and ignored', async () => {
  const res = await deliverStripeEvent(pool, {
    id: nextEventId('evt_foreign'),
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_membership_link', payment_intent: 'pi_elsewhere', metadata: {} } },
  });
  assert.equal(res.failed, 0);
  const { rows } = await pool.query(
    `SELECT processed_at FROM event_inbox WHERE type = 'checkout.session.completed' AND payload->'data'->'object'->>'id' = 'cs_membership_link'`,
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0].processed_at);
});

test('dispute freezes ONLY its own order; a won dispute unfreezes it', async () => {
  const a = await settledOrder('scope_sam', 'buyer_s1');
  const b = await settledOrder('scope_sam', 'buyer_s2');
  // A second listing/order for the same artist is untouched by design;
  // both orders belong to scope_sam, buyers differ.
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_dp'),
    type: 'charge.dispute.created',
    data: { object: { id: 'dp_scope_1', charge: 'ch_none', payment_intent: a.paymentIntentId, amount: 20000, reason: 'fraudulent' } },
  });
  let { rows: rel } = await pool.query('SELECT state FROM releases WHERE order_id = $1', [a.orderId]);
  assert.equal(rel[0].state, 'blocked_dispute');

  // Order B fulfills and releases normally.
  const transfersBefore = stripeState.transfers.length;
  await fulfillToAccepted(b.orderId, 'scope_sam', 'buyer_s2');
  assert.equal(stripeState.transfers.length, transfersBefore + 1);

  // Order A fulfills but cannot release while the dispute is open.
  await fulfillToAccepted(a.orderId, 'scope_sam', 'buyer_s1');
  assert.equal(stripeState.transfers.length, transfersBefore + 1);
  const blocked = await evaluateRelease(pool, getStripe(), a.orderId);
  assert.equal(blocked.transferred, false);
  assert.ok(blocked.blockers.includes('dispute_open'));

  // Dispute won → freeze lifts → release fires.
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_dp'),
    type: 'charge.dispute.closed',
    data: { object: { id: 'dp_scope_1', charge: 'ch_none', payment_intent: a.paymentIntentId, status: 'won' } },
  });
  const { rows: p } = await pool.query('SELECT dispute_state FROM payments WHERE order_id = $1', [a.orderId]);
  assert.equal(p[0].dispute_state, 'won');
  const released = await evaluateRelease(pool, getStripe(), a.orderId);
  assert.equal(released.transferred, true);
  assert.equal(stripeState.transfers.length, transfersBefore + 2);
});

test('a post-transfer dispute opens a recovery case — never a clawback', async () => {
  const { orderId, paymentIntentId } = await settledOrder('rec_rhea', 'buyer_r1');
  await fulfillToAccepted(orderId, 'rec_rhea', 'buyer_r1');
  const { rows: rel } = await pool.query('SELECT transfer_state FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel[0].transfer_state, 'created');
  const transfersBefore = stripeState.transfers.length;

  await deliverStripeEvent(pool, {
    id: nextEventId('evt_dp'),
    type: 'charge.dispute.created',
    data: { object: { id: 'dp_rec_1', charge: 'ch_none', payment_intent: paymentIntentId, amount: 20000, reason: 'fraudulent' } },
  });
  const { rows: cases } = await pool.query('SELECT * FROM recovery_cases WHERE order_id = $1', [orderId]);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].trigger_kind, 'dispute');
  assert.equal(cases[0].state, 'open');
  // No clawback: no new transfer, no reversal entries.
  assert.equal(stripeState.transfers.length, transfersBefore);
  const { rows: neg } = await pool.query(
    `SELECT * FROM ledger_entries WHERE order_id = $1 AND kind IN ('recovery')`,
    [orderId],
  );
  assert.equal(neg.length, 0);
  const { rows: rel2 } = await pool.query('SELECT transfer_state FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel2[0].transfer_state, 'created');
});

test('an expired session cancels the order and releases the piece', async () => {
  await makeArtist(app, pool, 'exp_erin', {});
  const listingId = await makeListing(app, 'exp_erin', {});
  const { order } = await checkoutOk(app, 'buyer_e9', listingId);
  const { rows } = await pool.query('SELECT stripe_checkout_session_id FROM orders WHERE id = $1', [order.id]);
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_exp'),
    type: 'checkout.session.expired',
    data: { object: { id: rows[0].stripe_checkout_session_id, metadata: { order_id: order.id } } },
  });
  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(o[0].status, 'canceled');
  const { rows: l } = await pool.query('SELECT inventory_state FROM listings WHERE id = $1', [listingId]);
  assert.equal(l[0].inventory_state, 'available');
});

test('a full refund lands as records: payment, order, ledger', async () => {
  await makeArtist(app, pool, 'ref_ruth', {});
  const listingId = await makeListing(app, 'ref_ruth', { priceCents: 15000 });
  const { order } = await checkoutOk(app, 'buyer_rf', listingId);
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_pi'),
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_ref_1', latest_charge: 'ch_ref_1', metadata: { order_id: order.id } } },
  });
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_ref'),
    type: 'charge.refunded',
    data: { object: { id: 'ch_ref_1', payment_intent: 'pi_ref_1', amount_refunded: 15000 } },
  });
  const { rows: p } = await pool.query('SELECT * FROM payments WHERE order_id = $1', [order.id]);
  assert.equal(p[0].status, 'refunded');
  assert.equal(p[0].refunded_cents, 15000);
  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(o[0].status, 'refunded');
  const { rows: l } = await pool.query(
    `SELECT amount_cents FROM ledger_entries WHERE order_id = $1 AND kind = 'refund'`,
    [order.id],
  );
  assert.equal(l.length, 1);
  assert.equal(l[0].amount_cents, 15000);
});

test('transfer.paid advances the transfer status only — payout stays separate', async () => {
  const { orderId } = await settledOrder('tp_tara', 'buyer_t1');
  await fulfillToAccepted(orderId, 'tp_tara', 'buyer_t1');
  const { rows: rel } = await pool.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel[0].transfer_state, 'created');
  assert.equal(rel[0].payout_state, 'pending');
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_tp'),
    type: 'transfer.paid',
    data: { object: { id: rel[0].stripe_transfer_id } },
  });
  const { rows: rel2 } = await pool.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel2[0].transfer_state, 'paid');
  assert.equal(rel2[0].payout_state, 'pending'); // bank payout is its own status
});

test('transfer.created advances the transfer status only — payout stays separate; redelivery is a no-op', async () => {
  const { orderId } = await settledOrder('tc_tessa', 'buyer_tc1');
  await fulfillToAccepted(orderId, 'tc_tessa', 'buyer_tc1');
  const { rows: rel } = await pool.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel[0].transfer_state, 'created');
  assert.equal(rel[0].payout_state, 'pending');
  const event = {
    type: 'transfer.created',
    data: { object: { id: rel[0].stripe_transfer_id } },
  };
  await deliverStripeEvent(pool, { ...event, id: nextEventId('evt_tc') });
  const { rows: rel2 } = await pool.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel2[0].transfer_state, 'paid');
  assert.equal(rel2[0].payout_state, 'pending'); // bank payout is its own status

  // The same event under a FRESH event id actually reaches the handler
  // (the inbox dedupe cannot save us) — the state guard makes it a no-op.
  await deliverStripeEvent(pool, { ...event, id: nextEventId('evt_tc') });
  const { rows: rel3 } = await pool.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel3[0].transfer_state, 'paid');
  assert.equal(rel3[0].payout_state, 'pending');
  const { rows: side } = await pool.query(
    `SELECT * FROM exception_queue WHERE stripe_object_id = $1`,
    [rel[0].stripe_transfer_id],
  );
  assert.equal(side.length, 0);
});

test('transfer.created for an unknown transfer id is recorded and ignored', async () => {
  const res = await deliverStripeEvent(pool, {
    id: nextEventId('evt_tc'),
    type: 'transfer.created',
    data: { object: { id: 'tr_not_ours_1' } },
  });
  assert.equal(res.failed, 0);
  const { rows } = await pool.query(
    `SELECT * FROM exception_queue WHERE stripe_object_id = 'tr_not_ours_1'`,
  );
  assert.equal(rows.length, 0);
});

test('transfer.reversed on a paid release sets reversed + audit + one exception; redelivery adds nothing', async () => {
  const { orderId } = await settledOrder('tr_rhea', 'buyer_tr1');
  await fulfillToAccepted(orderId, 'tr_rhea', 'buyer_tr1');
  const { rows: rel } = await pool.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  const transferId = rel[0].stripe_transfer_id;
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_tc'),
    type: 'transfer.created',
    data: { object: { id: transferId } },
  });
  const { rows: paid } = await pool.query('SELECT transfer_state FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(paid[0].transfer_state, 'paid');

  const reversedEvent = {
    type: 'transfer.reversed',
    data: { object: { id: transferId, amount: 19000, amount_reversed: 19000, reversed: true } },
  };
  await deliverStripeEvent(pool, { ...reversedEvent, id: nextEventId('evt_tr') });
  const { rows: rel2 } = await pool.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel2[0].transfer_state, 'reversed');
  assert.equal(rel2[0].payout_state, 'pending'); // a reversal asserts nothing about the bank payout
  const { rows: audit } = await pool.query(
    `SELECT * FROM audit_log WHERE action = 'transfer.reversed' AND target = $1`,
    [`order:${orderId}`],
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].meta.stripeTransferId, transferId);
  assert.equal(audit[0].meta.amountReversedCents, 19000);
  const { rows: exc } = await pool.query(
    `SELECT * FROM exception_queue WHERE dedupe_key = $1`,
    [`transfer_reversed_after_release:${transferId}`],
  );
  assert.equal(exc.length, 1);
  assert.equal(exc[0].kind, 'transfer_reversed_after_release');
  assert.equal(exc[0].state, 'open');
  assert.equal(exc[0].order_id, orderId);

  // Redelivery under a fresh event id: state guard + dedupe key hold —
  // still exactly one audit row and one exception.
  await deliverStripeEvent(pool, { ...reversedEvent, id: nextEventId('evt_tr') });
  const { rows: rel3 } = await pool.query('SELECT transfer_state FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel3[0].transfer_state, 'reversed');
  const { rows: audit2 } = await pool.query(
    `SELECT * FROM audit_log WHERE action = 'transfer.reversed' AND target = $1`,
    [`order:${orderId}`],
  );
  assert.equal(audit2.length, 1);
  const { rows: exc2 } = await pool.query(
    `SELECT * FROM exception_queue WHERE dedupe_key = $1`,
    [`transfer_reversed_after_release:${transferId}`],
  );
  assert.equal(exc2.length, 1);
});

test('transfer.reversed also lands from the created state (reversal before confirmation)', async () => {
  const { orderId } = await settledOrder('tr_cato', 'buyer_tr2');
  await fulfillToAccepted(orderId, 'tr_cato', 'buyer_tr2');
  const { rows: rel } = await pool.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel[0].transfer_state, 'created');
  await deliverStripeEvent(pool, {
    id: nextEventId('evt_tr'),
    type: 'transfer.reversed',
    data: { object: { id: rel[0].stripe_transfer_id, amount: 19000, amount_reversed: 19000, reversed: true } },
  });
  const { rows: rel2 } = await pool.query('SELECT transfer_state FROM releases WHERE order_id = $1', [orderId]);
  assert.equal(rel2[0].transfer_state, 'reversed');
});

test('webhook route: bad signature 400, valid 200, redelivery deduped', async () => {
  const event = {
    id: 'evt_route_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_route', metadata: {} } },
  };
  const payload = JSON.stringify(event);
  const bad = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_bad' },
    payload,
  });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_valid' },
    payload,
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { received: true, duplicate: false });
  const dup = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_valid' },
    payload,
  });
  assert.deepEqual(dup.json(), { received: true, duplicate: true });
  const { rows } = await pool.query(`SELECT * FROM event_inbox WHERE event_id = 'evt_route_1'`);
  assert.equal(rows.length, 1);
});
