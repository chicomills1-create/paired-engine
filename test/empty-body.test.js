// M7-D1 — bodyless requests carrying a JSON content type.
// The shipped SPA sets Content-Type: application/json on EVERY pairedApi
// call, including POST/DELETE calls with no body at all (save, unsave,
// publish, archive…). Fastify's default JSON parser rejects an empty body
// with 400 FST_ERR_CTP_EMPTY_JSON_BODY before routing, so every one of
// those actions failed from the real UI while body-carrying calls worked.
// These tests send the exact defect shape: the JSON header, NO payload.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';

stubClerk();

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call } = await import('./helpers/testapp.js');

let pool;
let app;
let listingId;

/** The defect shape: JSON content type, no payload whatsoever. */
function bodyless({ method, url, as }) {
  const headers = { 'content-type': 'application/json' };
  if (as) headers.authorization = `Bearer tok_${as}`;
  return app.inject({ method, url, headers });
}

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
  const res = await call(app, {
    method: 'POST', url: '/v1/listings', as: 'alice',
    payload: { title: 'Empty Body Study', type: 'physical', priceCents: 2500 },
  });
  assert.equal(res.statusCode, 201);
  listingId = res.json().listing.id;
});

after(async () => {
  await app.close();
  await pool.end();
});

test('(a) POST save, JSON content type, no body → routes (200)', async () => {
  const res = await bodyless({ method: 'POST', url: `/v1/listings/${listingId}/save`, as: 'bob' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().saved, true);
});

test('(b) DELETE save, JSON content type, no body → routes (200)', async () => {
  const res = await bodyless({ method: 'DELETE', url: `/v1/listings/${listingId}/save`, as: 'bob' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().saved, false);
});

test('(c) POST publish, JSON content type, no body → routes (200)', async () => {
  const res = await bodyless({ method: 'POST', url: `/v1/listings/${listingId}/publish`, as: 'alice' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().listing.status, 'published');
});

test('(d) a malformed JSON body still errors 400', async () => {
  const res = await app.inject({
    method: 'POST', url: `/v1/listings/${listingId}/save`,
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok_bob' },
    payload: '{not json',
  });
  assert.equal(res.statusCode, 400);
});
