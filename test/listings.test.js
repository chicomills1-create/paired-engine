// Listings: owner isolation, publish guards, public reads, media namespace.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';

stubClerk();

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor } = await import('./helpers/testapp.js');

let pool;
let app;
let aliceListingId;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
});

after(async () => {
  await app.close();
  await pool.end();
});

async function createListing(as, payload) {
  return call(app, { method: 'POST', url: '/v1/listings', as, payload });
}

test('create makes a draft owned by the caller; the artist role is granted', async () => {
  const res = await createListing('alice', { title: 'Sunset Study', type: 'physical' });
  assert.equal(res.statusCode, 201);
  const listing = res.json().listing;
  aliceListingId = listing.id;
  assert.equal(listing.status, 'draft');
  assert.equal(listing.inventoryState, 'available');
  assert.equal(listing.accountId, await accountIdFor(pool, 'alice'));

  const { rows } = await pool.query(
    `SELECT role FROM account_roles WHERE account_id = $1 AND role = 'artist'`,
    [listing.accountId],
  );
  assert.equal(rows.length, 1);
});

test('price must be integer cents at create', async () => {
  for (const priceCents of [19.99, -5, '2000']) {
    const res = await createListing('alice', { title: 'Bad Price', priceCents });
    assert.equal(res.statusCode, 400, `priceCents=${priceCents}`);
    assert.equal(res.json().error.code, 'bad_request');
  }
});

test('a draft is invisible to non-owners and anonymous readers (404)', async () => {
  const asBob = await call(app, { method: 'GET', url: `/v1/listings/${aliceListingId}`, as: 'bob' });
  assert.equal(asBob.statusCode, 404);
  const anon = await call(app, { method: 'GET', url: `/v1/listings/${aliceListingId}` });
  assert.equal(anon.statusCode, 404);
  const asOwner = await call(app, { method: 'GET', url: `/v1/listings/${aliceListingId}`, as: 'alice' });
  assert.equal(asOwner.statusCode, 200);
  assert.equal(asOwner.json().listing.title, 'Sunset Study');
});

test('non-owners cannot mutate: PATCH, publish, archive, media all 404', async () => {
  const patch = await call(app, {
    method: 'PATCH', url: `/v1/listings/${aliceListingId}`, as: 'bob', payload: { title: 'Hijacked' },
  });
  assert.equal(patch.statusCode, 404);
  const publish = await call(app, { method: 'POST', url: `/v1/listings/${aliceListingId}/publish`, as: 'bob' });
  assert.equal(publish.statusCode, 404);
  const archive = await call(app, { method: 'POST', url: `/v1/listings/${aliceListingId}/archive`, as: 'bob' });
  assert.equal(archive.statusCode, 404);
  const bobId = await accountIdFor(pool, 'bob');
  const media = await call(app, {
    method: 'POST', url: `/v1/listings/${aliceListingId}/media`, as: 'bob',
    payload: { key: `accounts/${bobId}/x.jpg` },
  });
  assert.equal(media.statusCode, 404);

  const after = await call(app, { method: 'GET', url: `/v1/listings/${aliceListingId}`, as: 'alice' });
  assert.equal(after.json().listing.title, 'Sunset Study');
  assert.equal(after.json().listing.status, 'draft');
});

test('publish guards: no price, zero price, and no title all fail 422', async () => {
  const noPrice = await call(app, { method: 'POST', url: `/v1/listings/${aliceListingId}/publish`, as: 'alice' });
  assert.equal(noPrice.statusCode, 422);
  assert.equal(noPrice.json().error.code, 'publish_guard');

  await call(app, {
    method: 'PATCH', url: `/v1/listings/${aliceListingId}`, as: 'alice', payload: { priceCents: 0 },
  });
  const zeroPrice = await call(app, { method: 'POST', url: `/v1/listings/${aliceListingId}/publish`, as: 'alice' });
  assert.equal(zeroPrice.statusCode, 422);

  const untitled = await createListing('alice', { priceCents: 5000 });
  const noTitle = await call(app, {
    method: 'POST', url: `/v1/listings/${untitled.json().listing.id}/publish`, as: 'alice',
  });
  assert.equal(noTitle.statusCode, 422);
});

test('publishing through PATCH passes the same guards', async () => {
  const res = await call(app, {
    method: 'PATCH', url: `/v1/listings/${aliceListingId}`, as: 'alice',
    payload: { priceCents: 20000, status: 'published' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().listing.status, 'published');
  assert.equal(res.json().listing.priceCents, 20000);
  assert.ok(res.json().listing.publishedAt);
});

test('a published listing is public and listed under the artist', async () => {
  const anon = await call(app, { method: 'GET', url: `/v1/listings/${aliceListingId}` });
  assert.equal(anon.statusCode, 200);
  assert.equal(anon.json().listing.title, 'Sunset Study');

  const aliceId = await accountIdFor(pool, 'alice');
  const list = await call(app, { method: 'GET', url: `/v1/artists/${aliceId}/listings` });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().listings.map((l) => l.id), [aliceListingId]);
});

test('media attach: own namespace only, duplicates rejected', async () => {
  const aliceId = await accountIdFor(pool, 'alice');
  const bobId = await accountIdFor(pool, 'bob');

  const ok = await call(app, {
    method: 'POST', url: `/v1/listings/${aliceListingId}/media`, as: 'alice',
    payload: { key: `accounts/${aliceId}/photo-1.jpg` },
  });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().media.position, 0);

  const foreign = await call(app, {
    method: 'POST', url: `/v1/listings/${aliceListingId}/media`, as: 'alice',
    payload: { key: `accounts/${bobId}/photo-2.jpg` },
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error.code, 'media_namespace');

  const dupe = await call(app, {
    method: 'POST', url: `/v1/listings/${aliceListingId}/media`, as: 'alice',
    payload: { key: `accounts/${aliceId}/photo-1.jpg` },
  });
  assert.equal(dupe.statusCode, 409);

  const view = await call(app, { method: 'GET', url: `/v1/listings/${aliceListingId}` });
  assert.equal(view.json().listing.media.length, 1);
  assert.equal(view.json().listing.media[0].key, `accounts/${aliceId}/photo-1.jpg`);
});

test('archiving hides the listing from the public again', async () => {
  const res = await call(app, { method: 'POST', url: `/v1/listings/${aliceListingId}/archive`, as: 'alice' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().listing.status, 'archived');

  const anon = await call(app, { method: 'GET', url: `/v1/listings/${aliceListingId}` });
  assert.equal(anon.statusCode, 404);
  const aliceId = await accountIdFor(pool, 'alice');
  const list = await call(app, { method: 'GET', url: `/v1/artists/${aliceId}/listings` });
  assert.deepEqual(list.json().listings, []);
});
