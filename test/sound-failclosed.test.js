// SOUND fail-closed — production's actual posture until Stripe keys
// land at the activation gate: a music checkout answers the honest
// 503, records intent in the audit log, and creates NO order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';

stubClerk();
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor } = await import('./helpers/testapp.js');
const { makeArtist } = await import('./helpers/commerce.js');

let pool;
let app;
let releaseId;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
  await makeArtist(app, pool, 'dormant_dana', { tier: 'paired' });
  const danaId = await accountIdFor(pool, 'dormant_dana');
  const created = await call(app, {
    method: 'POST',
    url: '/v1/listings',
    as: 'dormant_dana',
    payload: {
      medium: 'music',
      title: 'Dormant Release',
      priceCents: 1200,
      rightsRecording: true,
      rightsComposition: true,
      contentKind: 'original',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  releaseId = created.json().listing.id;
  const media = await call(app, {
    method: 'POST',
    url: `/v1/listings/${releaseId}/media`,
    as: 'dormant_dana',
    payload: { key: `accounts/${danaId}/track.mp3`, kind: 'audio', title: 'Song', sizeBytes: 1000, durationSec: 60 },
  });
  assert.equal(media.statusCode, 201, media.body);
  const pub = await call(app, { method: 'POST', url: `/v1/listings/${releaseId}/publish`, as: 'dormant_dana' });
  assert.equal(pub.statusCode, 200, pub.body);
});

after(async () => {
  await app.close();
  await pool.end();
});

test('music checkout without Stripe configured: 503, intent only, zero orders', async () => {
  const res = await call(app, { method: 'POST', url: `/v1/listings/${releaseId}/checkout`, as: 'dana_fan' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'not_configured');
  const { rows: orders } = await pool.query('SELECT * FROM orders');
  assert.equal(orders.length, 0);
  const { rows: audit } = await pool.query(
    `SELECT * FROM audit_log WHERE action = 'checkout.attempt' AND reason = 'stripe_not_configured'`,
  );
  assert.equal(audit.length, 1);
});
