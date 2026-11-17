// M4 — Briefs, pitches, and the commission loop: brief → pitch → accept
// → order → start → deliver → revision → redeliver → accept → release,
// through the M3 machinery (same fee snapshot, same release engine).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';
import { installFakeStripe, stripeState } from './helpers/fakestripe.js';

stubClerk();
installFakeStripe();
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call } = await import('./helpers/testapp.js');
const { makeArtist, deliverStripeEvent, sessionCompletedEvent } = await import('./helpers/commerce.js');

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

async function postBrief(as, payload = {}) {
  return call(app, {
    method: 'POST',
    url: '/v1/briefs',
    as,
    // A mural is a physical deliverable; the declaration is the
    // commission's tax classification input (§3) and pitch-accept
    // fails closed without it.
    payload: { title: 'A mural for the studio wall', budgetCents: 30000, deliverableType: 'physical', ...payload },
  });
}

async function pitch(briefId, as, payload = {}) {
  return call(app, {
    method: 'POST',
    url: `/v1/briefs/${briefId}/pitches`,
    as,
    payload: { priceCents: 30000, message: 'I can start Monday', ...payload },
  });
}

test('brief creation validates the budget and lands on the board', async () => {
  const bad = await postBrief('buyer1', { budgetCents: 0 });
  assert.equal(bad.statusCode, 400);

  const noTitle = await postBrief('buyer1', { title: '  ' });
  assert.equal(noTitle.statusCode, 400);

  const ok = await postBrief('buyer1');
  assert.equal(ok.statusCode, 201, ok.body);
  const brief = ok.json().brief;
  assert.equal(brief.status, 'open');
  assert.equal(brief.budgetCents, 30000);
  assert.equal(brief.pitchCount, 0);

  const board = await call(app, { method: 'GET', url: '/v1/briefs' });
  assert.ok(board.json().briefs.some((b) => b.id === brief.id));
});

test('the owner can cancel an open brief; it leaves the board', async () => {
  const created = await postBrief('buyer2');
  const brief = created.json().brief;

  const stranger = await call(app, { method: 'POST', url: `/v1/briefs/${brief.id}/cancel`, as: 'buyer1' });
  assert.equal(stranger.statusCode, 404);

  const canceled = await call(app, { method: 'POST', url: `/v1/briefs/${brief.id}/cancel`, as: 'buyer2' });
  assert.equal(canceled.statusCode, 200);
  assert.equal(canceled.json().brief.status, 'canceled');

  const board = await call(app, { method: 'GET', url: '/v1/briefs' });
  assert.ok(!board.json().briefs.some((b) => b.id === brief.id));

  // Pitching a canceled brief is pitching nothing.
  const p = await pitch(brief.id, 'someartist');
  assert.equal(p.statusCode, 404);
});

test('pitch rules: no self-pitch, one pitch per artist, pitches stay private', async () => {
  const brief = (await postBrief('buyer3')).json().brief;

  const self = await pitch(brief.id, 'buyer3');
  assert.equal(self.statusCode, 422);
  assert.equal(self.json().error.code, 'own_brief');

  await makeArtist(app, pool, 'pitcher1');
  const first = await pitch(brief.id, 'pitcher1');
  assert.equal(first.statusCode, 201, first.body);

  const dupe = await pitch(brief.id, 'pitcher1', { priceCents: 25000 });
  assert.equal(dupe.statusCode, 409);
  assert.equal(dupe.json().error.code, 'pitch_exists');

  const badPrice = await pitch(brief.id, 'pitcher2', { priceCents: -5 });
  assert.equal(badPrice.statusCode, 400);

  // A third party cannot read the pitches; the owner can; the artist
  // sees only their own.
  const third = await call(app, { method: 'GET', url: `/v1/briefs/${brief.id}/pitches`, as: 'buyer1' });
  assert.equal(third.statusCode, 403);
  const owners = await call(app, { method: 'GET', url: `/v1/briefs/${brief.id}/pitches`, as: 'buyer3' });
  assert.equal(owners.json().pitches.length, 1);
  const mine = await call(app, { method: 'GET', url: `/v1/briefs/${brief.id}/pitches`, as: 'pitcher1' });
  assert.equal(mine.json().pitches.length, 1);
  assert.equal(mine.json().pitches[0].priceCents, 30000);

  // Withdraw works while pending.
  const wd = await call(app, {
    method: 'POST',
    url: `/v1/pitches/${first.json().pitch.id}/withdraw`,
    as: 'pitcher1',
  });
  assert.equal(wd.statusCode, 200);
  assert.equal(wd.json().pitch.status, 'withdrawn');
});

test('the accept door rechecks verification and the payout path', async () => {
  const brief = (await postBrief('buyer4')).json().brief;

  // Unverified artist: pitch lands, accept refuses on artist_verified.
  await makeArtist(app, pool, 'unverified', { verified: false });
  const p1 = (await pitch(brief.id, 'unverified')).json().pitch;
  const r1 = await call(app, { method: 'POST', url: `/v1/pitches/${p1.id}/accept`, as: 'buyer4' });
  assert.equal(r1.statusCode, 422, r1.body);
  assert.ok(r1.json().error.failed.includes('artist_verified'));

  // Verified but no live payout path.
  await makeArtist(app, pool, 'nopath', { connectState: 'not_started', manualRail: false });
  const p2 = (await pitch(brief.id, 'nopath')).json().pitch;
  const r2 = await call(app, { method: 'POST', url: `/v1/pitches/${p2.id}/accept`, as: 'buyer4' });
  assert.equal(r2.statusCode, 422, r2.body);
  assert.ok(r2.json().error.failed.includes('artist_payout_path_live'));

  // Nothing was awarded by the refusals.
  const { rows } = await pool.query('SELECT status FROM briefs WHERE id = $1', [brief.id]);
  assert.equal(rows[0].status, 'open');
});

test('accept creates the commission order with the immutable fee snapshot', async () => {
  const brief = (await postBrief('buyer5')).json().brief;
  await makeArtist(app, pool, 'winner', { tier: 'paired' });
  await makeArtist(app, pool, 'runnerup');
  const winPitch = (await pitch(brief.id, 'winner', { priceCents: 30000 })).json().pitch;
  const losePitch = (await pitch(brief.id, 'runnerup', { priceCents: 28000 })).json().pitch;

  const res = await call(app, { method: 'POST', url: `/v1/pitches/${winPitch.id}/accept`, as: 'buyer5' });
  assert.equal(res.statusCode, 201, res.body);
  const { order, checkoutUrl } = res.json();
  assert.ok(checkoutUrl.includes('cs_test_'));
  assert.equal(order.kind, 'commission');
  assert.equal(order.listingId, null);
  assert.equal(order.priceCents, 30000);
  assert.deepEqual(order.feeSnapshot, {
    tier: 'paired',
    entitledTier: 'paired',
    rateBps: 500,
    calcVersion: 'v1',
    artistShareCents: 28500,
    platformShareCents: 1500,
  });
  assert.equal(order.fulfillment.kind, 'commission');
  assert.equal(order.fulfillment.state, 'awaiting_start');

  const { rows: b } = await pool.query('SELECT status, awarded_pitch_id FROM briefs WHERE id = $1', [brief.id]);
  assert.equal(b[0].status, 'awarded');
  assert.equal(b[0].awarded_pitch_id, winPitch.id);
  const { rows: ps } = await pool.query('SELECT id, status, order_id FROM pitches WHERE id = ANY($1)', [
    [winPitch.id, losePitch.id],
  ]);
  const byId = Object.fromEntries(ps.map((p) => [p.id, p]));
  assert.equal(byId[winPitch.id].status, 'accepted');
  assert.equal(byId[winPitch.id].order_id, order.id);
  assert.equal(byId[losePitch.id].status, 'rejected');

  const session = stripeState.sessions.at(-1);
  assert.equal(session.params.metadata.pitch_id, winPitch.id);
  assert.equal(session.params.metadata.order_id, order.id);
});

test('the full commission loop: settle → start → deliver → revise → redeliver → accept → release', async () => {
  const brief = (await postBrief('buyer6')).json().brief;
  await makeArtist(app, pool, 'loopartist', { tier: 'solo' });
  const p = (await pitch(brief.id, 'loopartist', { priceCents: 30000 })).json().pitch;
  const accepted = await call(app, { method: 'POST', url: `/v1/pitches/${p.id}/accept`, as: 'buyer6' });
  assert.equal(accepted.statusCode, 201, accepted.body);
  const order = accepted.json().order;
  const session = stripeState.sessions.at(-1).session;

  // Settle the payment through the real webhook inbox.
  await deliverStripeEvent(pool, sessionCompletedEvent(order, session.id, session.payment_intent));
  const { rows: pay } = await pool.query('SELECT status FROM payments WHERE order_id = $1', [order.id]);
  assert.equal(pay[0].status, 'succeeded');

  const start = await call(app, { method: 'POST', url: `/v1/orders/${order.id}/start`, as: 'loopartist' });
  assert.equal(start.statusCode, 200, start.body);
  assert.equal(start.json().order.fulfillment.state, 'in_progress');
  assert.equal(start.json().order.status, 'fulfilling');

  const d1 = await call(app, {
    method: 'POST', url: `/v1/orders/${order.id}/deliver`, as: 'loopartist', payload: { note: 'First pass delivered' },
  });
  assert.equal(d1.statusCode, 200, d1.body);
  assert.equal(d1.json().order.status, 'delivered');

  const rev = await call(app, {
    method: 'POST', url: `/v1/orders/${order.id}/request-revision`, as: 'buyer6', payload: { note: 'Deepen the blues' },
  });
  assert.equal(rev.statusCode, 200, rev.body);
  assert.equal(rev.json().order.fulfillment.state, 'revision_requested');

  const d2 = await call(app, {
    method: 'POST', url: `/v1/orders/${order.id}/deliver`, as: 'loopartist', payload: { note: 'Blues deepened' },
  });
  assert.equal(d2.statusCode, 200, d2.body);
  assert.equal(d2.json().order.status, 'delivered');

  const acc = await call(app, { method: 'POST', url: `/v1/orders/${order.id}/accept`, as: 'buyer6' });
  assert.equal(acc.statusCode, 200, acc.body);
  const finalOrder = acc.json().order;
  assert.equal(finalOrder.status, 'released');
  // Transfer and payout remain SEPARATE states (M0): the transfer exists,
  // the bank payout is still pending confirmation.
  assert.equal(finalOrder.release.transferState, 'created');
  assert.equal(finalOrder.release.payoutState, 'pending');

  // Solo tier: the artist's share of $300.00 is $276.00 — one transfer.
  assert.equal(stripeState.transfers.length, 1);
  assert.equal(stripeState.transfers[0].params.amount, 27600);
  const { rows: ledger } = await pool.query(
    `SELECT kind, amount_cents FROM ledger_entries WHERE order_id = $1 AND kind = 'transfer'`,
    [order.id],
  );
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].amount_cents, 27600);
});

test('a second accept on an awarded brief is refused; exactly one order exists', async () => {
  const brief = (await postBrief('buyer7')).json().brief;
  await makeArtist(app, pool, 'racer1');
  await makeArtist(app, pool, 'racer2');
  const p1 = (await pitch(brief.id, 'racer1')).json().pitch;
  const p2 = (await pitch(brief.id, 'racer2')).json().pitch;

  const first = await call(app, { method: 'POST', url: `/v1/pitches/${p1.id}/accept`, as: 'buyer7' });
  assert.equal(first.statusCode, 201, first.body);
  const second = await call(app, { method: 'POST', url: `/v1/pitches/${p2.id}/accept`, as: 'buyer7' });
  assert.equal(second.statusCode, 422, second.body);
  assert.ok(second.json().error.failed.includes('brief_open'));

  const { rows: orders } = await pool.query(
    `SELECT count(*)::int AS n FROM orders WHERE kind = 'commission' AND buyer_account_id =
       (SELECT id FROM accounts WHERE clerk_user_id = 'clerk_buyer7')`,
  );
  assert.equal(orders[0].n, 1);
  const { rows: accepted } = await pool.query(
    `SELECT count(*)::int AS n FROM pitches WHERE brief_id = $1 AND status = 'accepted'`,
    [brief.id],
  );
  assert.equal(accepted[0].n, 1);
});

test('a Stripe failure at accept unwinds the award completely', async () => {
  const brief = (await postBrief('buyer8')).json().brief;
  await makeArtist(app, pool, 'unlucky');
  await makeArtist(app, pool, 'bystander');
  const p1 = (await pitch(brief.id, 'unlucky')).json().pitch;
  const p2 = (await pitch(brief.id, 'bystander')).json().pitch;

  stripeState.failNextSessionCreate = true;
  const res = await call(app, { method: 'POST', url: `/v1/pitches/${p1.id}/accept`, as: 'buyer8' });
  assert.equal(res.statusCode, 502, res.body);

  const { rows: b } = await pool.query('SELECT status, awarded_pitch_id FROM briefs WHERE id = $1', [brief.id]);
  assert.equal(b[0].status, 'open');
  assert.equal(b[0].awarded_pitch_id, null);
  const { rows: ps } = await pool.query('SELECT id, status, order_id FROM pitches WHERE id = ANY($1)', [
    [p1.id, p2.id],
  ]);
  for (const row of ps) {
    assert.equal(row.status, 'pending');
    assert.equal(row.order_id, null);
  }
  const { rows: o } = await pool.query(
    `SELECT status FROM orders WHERE kind = 'commission' AND buyer_account_id =
       (SELECT id FROM accounts WHERE clerk_user_id = 'clerk_buyer8')`,
  );
  assert.equal(o.length, 1);
  assert.equal(o[0].status, 'canceled');
});
