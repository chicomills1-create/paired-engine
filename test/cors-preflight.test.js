// M7-D5 — CORS preflight must advertise the methods the API serves.
// The engine registered @fastify/cors with no methods option, so every
// preflight answered access-control-allow-methods: GET,HEAD,POST — and
// every browser DELETE/PATCH from pairedart.com (unsave, unfollow,
// unpublish, listing/profile edits) was blocked before it left the
// browser, while the endpoints themselves answered 200 to non-browser
// callers. This test exercises the REAL production builder (src/server.js
// buildServer), not the test harness — the harness registers no CORS at
// all, which is exactly the blind spot that let D5 ship.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// buildServer() validates DATABASE_URL eagerly (the pool itself is lazy
// and a preflight never queries) — give it a syntactically valid dummy.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://127.0.0.1:5432/unused-cors-test';

const { buildServer } = await import('../src/server.js');

let app;

before(async () => {
  app = buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
});

function preflight(method, origin) {
  return app.inject({
    method: 'OPTIONS',
    url: '/v1/listings',
    headers: {
      origin: origin || 'https://pairedart.com',
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,content-type',
    },
  });
}

test('preflight for DELETE advertises DELETE and PATCH to the site origin', async () => {
  const res = await preflight('DELETE');
  assert.equal(res.statusCode, 204);
  const allow = res.headers['access-control-allow-methods'] || '';
  assert.ok(allow.includes('DELETE'), `allow-methods was: ${allow}`);
  assert.ok(allow.includes('PATCH'), `allow-methods was: ${allow}`);
  assert.equal(res.headers['access-control-allow-origin'], 'https://pairedart.com');
});

test('preflight for PATCH advertises PATCH', async () => {
  const res = await preflight('PATCH');
  assert.equal(res.statusCode, 204);
  const allow = res.headers['access-control-allow-methods'] || '';
  assert.ok(allow.includes('PATCH'), `allow-methods was: ${allow}`);
});

test('preflight from a disallowed origin gets no allow-origin', async () => {
  const res = await preflight('DELETE', 'https://evil.example');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
