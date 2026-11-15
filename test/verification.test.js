// Verification state machine: submit → (under_review) → verified | rejected.
// The profile flag derives ONLY from a verified record; one open request
// per account; decisions are admin-only and audited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';

stubClerk();

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor, grantRole } = await import('./helpers/testapp.js');

let pool;
let app;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
  // Create the admin account (first authenticated call resolves it), then
  // grant the admin role directly — roles are server-owned data.
  await call(app, { method: 'GET', url: '/v1/artist/profile', as: 'admin1' });
  await grantRole(pool, await accountIdFor(pool, 'admin1'), 'admin');
});

after(async () => {
  await app.close();
  await pool.end();
});

async function submit(as, shopUrl = 'https://example-etsy.test/shop', proofCode = 'PAIRED-ABC123') {
  return call(app, {
    method: 'POST',
    url: '/v1/artist/verification',
    as,
    payload: { shopUrl, proofCode },
  });
}

async function decide(as, verificationId, decision, evidenceNotes) {
  return call(app, {
    method: 'POST',
    url: '/v1/admin/verifications/decide',
    as,
    payload: { verificationId, decision, evidenceNotes },
  });
}

test('unauthenticated calls are rejected', async () => {
  const res = await call(app, { method: 'GET', url: '/v1/artist/verification' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'unauthorized');
});

test('submit creates a submitted request; profile stays unverified', async () => {
  const res = await submit('alice');
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.verification.state, 'submitted');
  assert.equal(body.verification.shopUrl, 'https://example-etsy.test/shop');

  const status = await call(app, { method: 'GET', url: '/v1/artist/verification', as: 'alice' });
  assert.equal(status.json().verification.state, 'submitted');
  assert.equal(status.json().verified, false);

  const profile = await call(app, { method: 'GET', url: '/v1/artist/profile', as: 'alice' });
  assert.equal(profile.json().profile, null); // no profile row yet, flag reads false
});

test('a second open request is rejected with 409', async () => {
  const res = await submit('alice');
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'verification_open');
});

test('submit validates its body', async () => {
  const res = await call(app, {
    method: 'POST',
    url: '/v1/artist/verification',
    as: 'carol',
    payload: { shopUrl: '', proofCode: '' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'bad_request');
});

test('non-admin cannot decide', async () => {
  const status = await call(app, { method: 'GET', url: '/v1/artist/verification', as: 'alice' });
  const id = status.json().verification.id;
  const res = await decide('alice', id, 'verified');
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'forbidden');
});

test('under_review then verified: the profile flag turns on, audit row written', async () => {
  const status = await call(app, { method: 'GET', url: '/v1/artist/verification', as: 'alice' });
  const id = status.json().verification.id;

  const review = await decide('admin1', id, 'under_review', 'Opened for review — shop reachable');
  assert.equal(review.statusCode, 200);
  assert.equal(review.json().verification.state, 'under_review');
  assert.equal(review.json().verified, false);

  const done = await decide('admin1', id, 'verified', 'Proof code matched the shop banner');
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().verification.state, 'verified');
  assert.equal(done.json().verified, true);
  assert.ok(done.json().verification.decidedAt);

  const profile = await call(app, { method: 'GET', url: '/v1/artist/profile', as: 'alice' });
  assert.equal(profile.json().profile.verified, true);

  const { rows } = await pool.query(
    `SELECT action, meta FROM audit_log WHERE action = 'verification.decide' ORDER BY created_at`,
  );
  assert.ok(rows.length >= 2);
  assert.equal(rows[rows.length - 1].meta.decision, 'verified');
});

test('a decided request cannot be decided again', async () => {
  const status = await call(app, { method: 'GET', url: '/v1/artist/verification', as: 'alice' });
  const res = await decide('admin1', status.json().verification.id, 'rejected');
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'already_decided');
});

test('rejection leaves the flag off and frees the account to re-apply', async () => {
  const sub = await submit('bob');
  assert.equal(sub.statusCode, 201);
  const id = sub.json().verification.id;

  const done = await decide('admin1', id, 'rejected', 'Proof code not visible on the shop');
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().verified, false);

  const profile = await call(app, { method: 'GET', url: '/v1/artist/profile', as: 'bob' });
  assert.equal(profile.json().profile.verified, false);

  const again = await submit('bob', 'https://example-etsy.test/shop2', 'PAIRED-XYZ789');
  assert.equal(again.statusCode, 201);
  assert.equal(again.json().verification.state, 'submitted');
});

test('the artist can never set verified through the profile route', async () => {
  const res = await call(app, {
    method: 'PATCH',
    url: '/v1/artist/profile',
    as: 'bob',
    payload: { displayName: 'Bob', verified: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().profile.verified, false);
  assert.equal(res.json().profile.displayName, 'Bob');
});

test('a decision without evidence notes is refused (M5 reason law)', async () => {
  const sub = await submit('dave', 'https://example-etsy.test/dave', 'PAIRED-DV0001');
  assert.equal(sub.statusCode, 201);
  const id = sub.json().verification.id;

  const noNotes = await decide('admin1', id, 'verified');
  assert.equal(noNotes.statusCode, 400);
  assert.equal(noNotes.json().error.code, 'reason_required');

  const blankNotes = await decide('admin1', id, 'verified', '   ');
  assert.equal(blankNotes.statusCode, 400);
  assert.equal(blankNotes.json().error.code, 'reason_required');

  // The request is untouched by the refused decisions.
  const status = await call(app, { method: 'GET', url: '/v1/artist/verification', as: 'dave' });
  assert.equal(status.json().verification.state, 'submitted');
  assert.equal(status.json().verified, false);
});
