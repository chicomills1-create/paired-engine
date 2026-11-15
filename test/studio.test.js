// M4 — The Studio, both faces: saves, follows, view events, posted-where
// state, the commissions pipeline, and Sales & Earnings — every value
// traced to a server record.
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
const { makeArtist, makeListing, checkoutOk, deliverStripeEvent, sessionCompletedEvent } =
  await import('./helpers/commerce.js');

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

test('saves are idempotent and surface on the buyer face with live public state', async () => {
  await makeArtist(app, pool, 'saverartist');
  const listingId = await makeListing(app, 'saverartist', {});

  const s1 = await call(app, { method: 'POST', url: `/v1/listings/${listingId}/save`, as: 'fan1' });
  assert.equal(s1.statusCode, 200);
  assert.equal(s1.json().saved, true);
  const s2 = await call(app, { method: 'POST', url: `/v1/listings/${listingId}/save`, as: 'fan1' });
  assert.equal(s2.statusCode, 200);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM saves WHERE listing_id = $1', [listingId]);
  assert.equal(rows[0].n, 1, 'saving twice is one fact');

  let studio = await call(app, { method: 'GET', url: '/v1/studio/buyer', as: 'fan1' });
  assert.equal(studio.json().saved.length, 1);
  assert.equal(studio.json().saved[0].id, listingId);
  assert.equal(studio.json().saved[0].currentlyPublic, true);

  // The artist archives the piece: the save remains, honestly labeled.
  await call(app, { method: 'POST', url: `/v1/listings/${listingId}/archive`, as: 'saverartist' });
  studio = await call(app, { method: 'GET', url: '/v1/studio/buyer', as: 'fan1' });
  assert.equal(studio.json().saved.length, 1);
  assert.equal(studio.json().saved[0].currentlyPublic, false);

  const un = await call(app, { method: 'DELETE', url: `/v1/listings/${listingId}/save`, as: 'fan1' });
  assert.equal(un.json().saved, false);
  studio = await call(app, { method: 'GET', url: '/v1/studio/buyer', as: 'fan1' });
  assert.equal(studio.json().saved.length, 0);

  const missing = await call(app, {
    method: 'POST',
    url: '/v1/listings/00000000-0000-0000-0000-000000000000/save',
    as: 'fan1',
  });
  assert.equal(missing.statusCode, 404);
});

test('follows: rules, the buyer list, and the seller follower count', async () => {
  await makeArtist(app, pool, 'followedartist');
  const artistId = await accountIdFor(pool, 'followedartist');
  // Resolve fan2's account with a first authenticated call, then read it.
  await call(app, { method: 'GET', url: '/v1/studio/buyer', as: 'fan2' });
  const fanId = await accountIdFor(pool, 'fan2');
  assert.ok(fanId);

  const self = await call(app, { method: 'POST', url: `/v1/artists/${fanId}/follow`, as: 'fan2' });
  assert.equal(self.statusCode, 422);

  const ghost = await call(app, {
    method: 'POST',
    url: '/v1/artists/00000000-0000-0000-0000-000000000000/follow',
    as: 'fan2',
  });
  assert.equal(ghost.statusCode, 404);

  const ok = await call(app, { method: 'POST', url: `/v1/artists/${artistId}/follow`, as: 'fan2' });
  assert.equal(ok.statusCode, 200);
  await call(app, { method: 'POST', url: `/v1/artists/${artistId}/follow`, as: 'fan2' });

  const buyer = await call(app, { method: 'GET', url: '/v1/studio/buyer', as: 'fan2' });
  assert.equal(buyer.json().following.length, 1);
  assert.equal(buyer.json().following[0].accountId, artistId);
  assert.equal(buyer.json().following[0].verified, true);

  const seller = await call(app, { method: 'GET', url: '/v1/studio/seller', as: 'followedartist' });
  assert.equal(seller.json().totals.followers, 1);

  await call(app, { method: 'DELETE', url: `/v1/artists/${artistId}/follow`, as: 'fan2' });
  const after = await call(app, { method: 'GET', url: '/v1/studio/buyer', as: 'fan2' });
  assert.equal(after.json().following.length, 0);
});

test('views: public reads record events; owner reads and rapid repeats do not inflate', async () => {
  await makeArtist(app, pool, 'viewedartist');
  const listingId = await makeListing(app, 'viewedartist', {});

  // Anonymous read counts.
  await call(app, { method: 'GET', url: `/v1/listings/${listingId}` });
  // The owner's own read does not.
  await call(app, { method: 'GET', url: `/v1/listings/${listingId}`, as: 'viewedartist' });
  // A signed-in viewer counts once per dedupe window.
  await call(app, { method: 'GET', url: `/v1/listings/${listingId}`, as: 'looker' });
  await call(app, { method: 'GET', url: `/v1/listings/${listingId}`, as: 'looker' });
  const explicit = await call(app, { method: 'POST', url: `/v1/listings/${listingId}/view`, as: 'looker' });
  assert.equal(explicit.json().recorded, false);
  assert.equal(explicit.json().reason, 'recent_view');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM listing_views WHERE listing_id = $1',
    [listingId],
  );
  assert.equal(rows[0].n, 2, 'one anonymous + one signed-in view');

  const seller = await call(app, { method: 'GET', url: '/v1/studio/seller', as: 'viewedartist' });
  const mine = seller.json().listings.find((l) => l.id === listingId);
  assert.equal(mine.viewsCount, 2);
  assert.equal(seller.json().totals.views, 2);
});

test('seller face: posted-where state and per-listing saves count', async () => {
  await makeArtist(app, pool, 'posterartist');
  const publishedId = await makeListing(app, 'posterartist', { title: 'On the wall' });
  const draftId = await makeListing(app, 'posterartist', { title: 'In the drawer', publish: false });
  await call(app, { method: 'POST', url: `/v1/listings/${publishedId}/save`, as: 'fan3' });
  await call(app, { method: 'POST', url: `/v1/listings/${publishedId}/save`, as: 'fan4' });

  const seller = await call(app, { method: 'GET', url: '/v1/studio/seller', as: 'posterartist' });
  const byId = Object.fromEntries(seller.json().listings.map((l) => [l.id, l]));
  assert.equal(byId[publishedId].postedWhere, 'public');
  assert.equal(byId[publishedId].savesCount, 2);
  assert.equal(byId[draftId].postedWhere, 'studio_only');
  assert.equal(seller.json().totals.listings, 2);
  assert.equal(seller.json().totals.published, 1);
  assert.equal(seller.json().totals.saves, 2);
});

test('seller face: the commissions pipeline counts trace to pitch records', async () => {
  await makeArtist(app, pool, 'pipeartist');
  const briefRes = await call(app, {
    method: 'POST', url: '/v1/briefs', as: 'pipebuyer',
    payload: { title: 'Pipeline brief', budgetCents: 10000 },
  });
  const briefId = briefRes.json().brief.id;
  await call(app, {
    method: 'POST', url: `/v1/briefs/${briefId}/pitches`, as: 'pipeartist',
    payload: { priceCents: 9000, message: 'On it' },
  });

  const seller = await call(app, { method: 'GET', url: '/v1/studio/seller', as: 'pipeartist' });
  assert.equal(seller.json().commissions.pitched, 1);
  assert.equal(seller.json().commissions.accepted, 0);

  const buyer = await call(app, { method: 'GET', url: '/v1/studio/buyer', as: 'pipebuyer' });
  const mine = buyer.json().briefs.find((b) => b.id === briefId);
  assert.equal(mine.pitchCount, 1);
});

test('Sales & Earnings: fee snapshot math per order, transfer and payout separate', async () => {
  await makeArtist(app, pool, 'earner', { tier: 'solo' });
  const listingId = await makeListing(app, 'earner', { priceCents: 20000 });

  // A checkout that never settles is not earnings.
  const open = await checkoutOk(app, 'earlybuyer', listingId);
  let seller = await call(app, { method: 'GET', url: '/v1/studio/seller', as: 'earner' });
  assert.equal(seller.json().earnings.orders.length, 0);
  assert.equal(seller.json().earnings.grossCents, 0);

  const session = stripeState.sessions.at(-1).session;
  await deliverStripeEvent(pool, sessionCompletedEvent(open.order, session.id, session.payment_intent));

  seller = await call(app, { method: 'GET', url: '/v1/studio/seller', as: 'earner' });
  assert.equal(seller.json().earnings.orders.length, 1);
  const row = seller.json().earnings.orders[0];
  assert.equal(row.id, open.order.id);
  assert.equal(row.feeSnapshot.artistShareCents, 18400);
  assert.equal(row.feeSnapshot.platformShareCents, 1600);
  assert.equal(row.feeSnapshot.rateBps, 800);
  assert.ok('transferState' in row.release && 'payoutState' in row.release);
  assert.equal(seller.json().earnings.grossCents, 20000);
  assert.equal(seller.json().earnings.settledArtistShareCents, 18400);

  // The buyer face carries the same order.
  const buyer = await call(app, { method: 'GET', url: '/v1/studio/buyer', as: 'earlybuyer' });
  assert.ok(buyer.json().orders.some((o) => o.id === open.order.id));
});
