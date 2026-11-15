// Checkout + Stripe webhook WITHOUT Stripe configured (production's
// actual posture until keys land): every money leg fails closed, intent
// is recorded in the audit log, and NO order / reservation is created.
// The webhook route runs the REAL signature verification here — a
// correctly signed event is accepted into the inbox, a bad one is 400.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { stubClerk } from './helpers/testapp.js';

stubClerk();
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call } = await import('./helpers/testapp.js');
const { makeArtist, makeListing } = await import('./helpers/commerce.js');

let pool;
let app;
let listingId;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
  await makeArtist(app, pool, 'nopay_artist', { connectState: 'active' });
  listingId = await makeListing(app, 'nopay_artist', { priceCents: 20000 });
});

after(async () => {
  await app.close();
  await pool.end();
});

test('checkout fails closed with 503 and records intent only', async () => {
  const res = await call(app, { method: 'POST', url: `/v1/listings/${listingId}/checkout`, as: 'nopay_buyer' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'not_configured');

  const { rows: orders } = await pool.query('SELECT * FROM orders');
  assert.equal(orders.length, 0); // no order was fabricated
  const { rows: listing } = await pool.query('SELECT inventory_state FROM listings WHERE id = $1', [listingId]);
  assert.equal(listing[0].inventory_state, 'available'); // nothing reserved
  const { rows: audit } = await pool.query(
    `SELECT * FROM audit_log WHERE action = 'checkout.attempt'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, 'stripe_not_configured');
});

test('stripe webhook without a secret is 500 not_configured', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    payload: JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } }),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, 'not_configured');
});

test('stripe webhook verifies real signatures and dedupes deliveries', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_real';
  const payload = JSON.stringify({
    id: 'evt_signed_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_unknown', metadata: {} } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_test_real').update(`${ts}.${payload}`).digest('hex');
  const headers = { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` };

  const ok = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers, payload });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { received: true, duplicate: false });

  const dup = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers, payload });
  assert.equal(dup.statusCode, 200);
  assert.deepEqual(dup.json(), { received: true, duplicate: true });

  const { rows } = await pool.query(`SELECT * FROM event_inbox WHERE source = 'stripe'`);
  assert.equal(rows.length, 1);

  const bad = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` },
    payload,
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'bad_signature');
});
