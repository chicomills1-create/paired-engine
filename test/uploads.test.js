// Uploads presign: fails closed without storage config; with config it
// issues account-namespaced keys and enforces the content-type allowlist.
// (Signing is offline — dummy credentials exercise the real code path.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';

stubClerk();

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor } = await import('./helpers/testapp.js');

let pool;
let app;

const S3_ENV = ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT'];

before(async () => {
  for (const key of S3_ENV) delete process.env[key];
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
});

after(async () => {
  for (const key of S3_ENV) delete process.env[key];
  await app.close();
  await pool.end();
});

test('without storage config the presign leg fails closed (503)', async () => {
  const res = await call(app, {
    method: 'POST', url: '/v1/uploads/presign', as: 'heidi', payload: { contentType: 'image/png' },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'not_configured');
});

test('the content-type allowlist is enforced before config is consulted', async () => {
  for (const contentType of ['image/gif', 'application/pdf', 'text/html', '']) {
    const res = await call(app, {
      method: 'POST', url: '/v1/uploads/presign', as: 'heidi', payload: { contentType },
    });
    assert.equal(res.statusCode, 400, `contentType=${contentType}`);
    assert.equal(res.json().error.code, 'bad_request');
  }
});

test('with config: namespaced key, signed URL, per-type extension', async () => {
  process.env.S3_BUCKET = 'paired-media-test';
  process.env.S3_REGION = 'us-east-2';
  process.env.S3_ACCESS_KEY_ID = 'AKIATEST000000000000';
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret-not-a-real-key';

  const heidiId = await accountIdFor(pool, 'heidi');
  const cases = [
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/webp', '.webp'],
  ];
  for (const [contentType, ext] of cases) {
    const res = await call(app, {
      method: 'POST', url: '/v1/uploads/presign', as: 'heidi', payload: { contentType },
    });
    assert.equal(res.statusCode, 200, contentType);
    const body = res.json();
    assert.match(body.key, new RegExp(`^accounts/${heidiId}/[0-9a-f-]{36}\\${ext}$`));
    assert.ok(body.url.includes('paired-media-test'), 'URL names the bucket');
    assert.ok(body.url.includes('X-Amz-Signature='), 'URL is signed');
    assert.equal(body.expiresIn, 900);
  }
});

test('presign requires authentication', async () => {
  const res = await call(app, {
    method: 'POST', url: '/v1/uploads/presign', payload: { contentType: 'image/png' },
  });
  assert.equal(res.statusCode, 401);
});
