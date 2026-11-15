// M5 — Admin console: verification queue (no proof codes, ever), the
// Founding 100 list + decide with its ATOMIC seat claim — including the
// exactly-once proof carried as a remainder since M1: with one seat
// left, the first approval claims it, the second is refused, the loser
// stays pending, and the counter can never pass 100.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';
import { installFakeStripe } from './helpers/fakestripe.js';

stubClerk();
installFakeStripe();
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor, grantRole } = await import('./helpers/testapp.js');
const { makeArtist, makeListing, checkoutOk } = await import('./helpers/commerce.js');

let pool;
let app;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
  await call(app, { method: 'GET', url: '/v1/artist/profile', as: 'opsadmin' });
  await grantRole(pool, await accountIdFor(pool, 'opsadmin'), 'admin');
});

after(async () => {
  await app.close();
  await pool.end();
});

async function apply(as) {
  return call(app, { method: 'POST', url: '/v1/founding/apply', as, payload: { note: 'Founding hopeful' } });
}

async function decide(applicationId, payload) {
  return call(app, {
    method: 'POST', url: '/v1/admin/founding/decide', as: 'opsadmin',
    payload: { applicationId, ...payload },
  });
}

test('the verification queue lists open requests and never a proof code', async () => {
  await call(app, {
    method: 'POST', url: '/v1/artist/verification', as: 'hopeful1',
    payload: { shopUrl: 'https://shop.example/hopeful1', proofCode: 'PAIRED-SECRET1' },
  });
  await call(app, {
    method: 'POST', url: '/v1/artist/verification', as: 'hopeful2',
    payload: { shopUrl: 'https://shop.example/hopeful2', proofCode: 'PAIRED-SECRET2' },
  });

  const denied = await call(app, { method: 'GET', url: '/v1/admin/verifications/queue', as: 'hopeful1' });
  assert.equal(denied.statusCode, 403);

  const queue = await call(app, { method: 'GET', url: '/v1/admin/verifications/queue', as: 'opsadmin' });
  assert.equal(queue.statusCode, 200);
  assert.equal(queue.json().queue.length, 2);
  assert.ok(queue.json().queue.every((q) => q.state === 'submitted'));
  assert.ok(!JSON.stringify(queue.json()).includes('PAIRED-SECRET'), 'proof codes never leave the artist');
});

test('founding: list, reason-required decide, and the first seat', async () => {
  const appRes = await apply('founderhopeful');
  assert.equal(appRes.statusCode, 201, appRes.body);
  const applicationId = appRes.json().application.id;

  const list = await call(app, {
    method: 'GET', url: '/v1/admin/founding/applications?status=pending', as: 'opsadmin',
  });
  assert.equal(list.json().seatsClaimed, 0);
  assert.ok(list.json().applications.some((a) => a.id === applicationId));

  const noReason = await decide(applicationId, { decision: 'approved' });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.json().error.code, 'reason_required');

  const ok = await decide(applicationId, { decision: 'approved', reason: 'Portfolio verified by hand' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().seatNo, 1);

  const after = await call(app, { method: 'GET', url: '/v1/admin/founding/applications', as: 'opsadmin' });
  assert.equal(after.json().seatsClaimed, 1);
  const mine = after.json().applications.find((a) => a.id === applicationId);
  assert.equal(mine.status, 'approved');
  assert.equal(mine.seatNo, 1);

  const { rows } = await pool.query(
    `SELECT reason FROM audit_log WHERE action = 'founding.decide' AND target = $1`,
    [`founding_application:${applicationId}`],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'Portfolio verified by hand');
});

test('the last seat resolves exactly once (the M1 remainder, proven on PGlite)', async () => {
  // Fill seats 2..99 with filler accounts so exactly one seat remains.
  for (let i = 2; i <= 99; i += 1) {
    const { rows } = await pool.query(
      `INSERT INTO accounts (clerk_user_id, email) VALUES ($1, $2) RETURNING id`,
      [`clerk_filler${i}`, `filler${i}@example.test`],
    );
    await pool.query('UPDATE founding_seats SET account_id = $1, claimed_at = now() WHERE seat_no = $2', [
      rows[0].id, i,
    ]);
  }
  const { rows: count } = await pool.query(
    'SELECT count(*)::int AS n FROM founding_seats WHERE account_id IS NOT NULL',
  );
  assert.equal(count[0].n, 99);

  const a1 = (await apply('lastseat1')).json().application.id;
  const a2 = (await apply('lastseat2')).json().application.id;

  // The claim is ONE guarded UPDATE inside the decision transaction
  // (lowest free seat, claimed in the same statement that checks it) —
  // the first approval takes seat 100; the second approval's claim
  // matches no free seat and is refused. On the production pool the two
  // transactions additionally serialize on the seat row itself.
  const winner = await decide(a1, { decision: 'approved', reason: 'First to the last seat' });
  assert.equal(winner.statusCode, 200, winner.body);
  assert.equal(winner.json().seatNo, 100);

  const loser = await decide(a2, { decision: 'approved', reason: 'Second to the last seat' });
  assert.equal(loser.statusCode, 409, loser.body);
  assert.equal(loser.json().error.code, 'seats_exhausted');

  const { rows: finalCount } = await pool.query(
    'SELECT count(*)::int AS n FROM founding_seats WHERE account_id IS NOT NULL',
  );
  assert.equal(finalCount[0].n, 100, 'the counter stops at 100 — never 101');

  const { rows: apps } = await pool.query(
    'SELECT status FROM founding_applications WHERE id = ANY($1)',
    [[a1, a2]],
  );
  assert.deepEqual(apps.map((a) => a.status).sort(), ['approved', 'pending'],
    'the loser stays pending — not approved, not rejected, no seat');
});

test('with all seats claimed, further approvals are refused and rejections still work', async () => {
  const a = (await apply('onemore')).json().application.id;
  const approve = await decide(a, { decision: 'approved', reason: 'Worth a seat if one existed' });
  assert.equal(approve.statusCode, 409);
  assert.equal(approve.json().error.code, 'seats_exhausted');

  const reject = await decide(a, { decision: 'rejected', reason: 'Cohort is full for this round' });
  assert.equal(reject.statusCode, 200);
  assert.equal(reject.json().seatNo, null);
});

test('the admin orders read carries full money state; non-admins are refused', async () => {
  await makeArtist(app, pool, 'adminviewartist');
  const listingId = await makeListing(app, 'adminviewartist', {});
  const { order } = await checkoutOk(app, 'adminviewbuyer', listingId);

  const denied = await call(app, { method: 'GET', url: '/v1/admin/orders', as: 'adminviewbuyer' });
  assert.equal(denied.statusCode, 403);

  const res = await call(app, { method: 'GET', url: '/v1/admin/orders', as: 'opsadmin' });
  assert.equal(res.statusCode, 200);
  const row = res.json().orders.find((o) => o.id === order.id);
  assert.ok(row);
  assert.equal(row.status, 'checkout_open');
  assert.ok(row.payment && row.fulfillment && row.release);
  assert.ok('transferState' in row.release && 'payoutState' in row.release);

  const filtered = await call(app, {
    method: 'GET', url: '/v1/admin/orders?status=checkout_open', as: 'opsadmin',
  });
  assert.ok(filtered.json().orders.every((o) => o.status === 'checkout_open'));
});
