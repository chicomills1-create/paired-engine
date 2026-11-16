// SND CONTROLS — the five ChatGPT-required Sound controls, graded and
// proven against the shipped build (PR #7 conditions, 2026-11-15):
//   SND-01 rights gate at publish AND at checkout, declaration record
//   SND-02 cover hold: cannot be laundered, reviewer clears, changes reopen
//   SND-03 entitlement follows VERIFIED payment, never session completion
//   SND-04 quotas: stored-object sizes, publish-time enforcement, no
//          phantom capacity from abandoned work
//   SND-05 refund / dispute / takedown / suspension consequences
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';
import { installFakeStripe, stripeState } from './helpers/fakestripe.js';

stubClerk();
installFakeStripe();
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec' + String.fromCharCode(95) + 'test';

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor, grantRole } = await import('./helpers/testapp.js');
const { makeArtist, deliverStripeEvent, sessionCompletedEvent, nextEventId } = await import(
  './helpers/commerce.js'
);
const { musicPublishCheck } = await import('../src/lib/music.js');
const { setHeadObjectProbe } = await import('../src/lib/storage.js');

let pool;
let app;

// The HEAD probe (SND-04) delegates to a mutable behavior so each test
// can stage the stored object it needs. Default: the object exists,
// its type matches its extension, and it reports no size (the declared
// size then stands — the posture sound.test.js relies on).
const PROBE_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
  ogg: 'audio/ogg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};
let probeImpl = async (key) => {
  const ext = String(key).split('.').pop().toLowerCase();
  return { sizeBytes: null, contentType: PROBE_TYPES[ext] || null };
};
setHeadObjectProbe((key) => probeImpl(key));

const S3_ENV = ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT'];

before(async () => {
  process.env.S3_BUCKET = 'paired-media-test';
  process.env.S3_REGION = 'us-east-2';
  process.env.S3_ACCESS_KEY_ID = 'AKIA' + 'TEST000000000000';
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret-not-a-real-key';
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
  await call(app, { method: 'GET', url: '/v1/artist/profile', as: 'snd_admin' });
  await grantRole(pool, await accountIdFor(pool, 'snd_admin'), 'admin');
});

after(async () => {
  setHeadObjectProbe(null);
  for (const key of S3_ENV) delete process.env[key];
  await app.close();
  await pool.end();
});

async function makeRelease(as, payload = {}) {
  const res = await call(app, {
    method: 'POST',
    url: '/v1/listings',
    as,
    payload: {
      medium: 'music',
      title: 'Control Release',
      priceCents: 1000,
      releaseType: 'single',
      rightsRecording: true,
      rightsComposition: true,
      contentKind: 'original',
      ...payload,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().listing;
}

async function attachTrack(as, listingId, { title = 'Track', sizeBytes = 5_000_000 } = {}) {
  const accountId = await accountIdFor(pool, as);
  const res = await call(app, {
    method: 'POST',
    url: `/v1/listings/${listingId}/media`,
    as,
    payload: {
      key: `accounts/${accountId}/${Math.random().toString(36).slice(2)}track.mp3`,
      kind: 'audio',
      title,
      sizeBytes,
      durationSec: 180,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().media;
}

async function publishOk(as, listingId) {
  const res = await call(app, { method: 'POST', url: `/v1/listings/${listingId}/publish`, as });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().listing;
}

async function listingRow(id) {
  const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [id]);
  return rows[0];
}

async function musicOrder(artistName, buyerName, listingId) {
  const res = await call(app, {
    method: 'POST',
    url: `/v1/listings/${listingId}/checkout`,
    as: buyerName,
  });
  assert.equal(res.statusCode, 201, res.body);
  const order = res.json().order;
  const { rows } = await pool.query(
    'SELECT stripe_checkout_session_id FROM orders WHERE id = $1',
    [order.id],
  );
  const sessionId = rows[0].stripe_checkout_session_id;
  const rec = stripeState.sessions.find((s) => s.session.id === sessionId);
  return { order, sessionId, paymentIntentId: rec.session.payment_intent };
}

async function shelfCount(buyerName) {
  const res = await call(app, { method: 'GET', url: '/v1/sound/shelf', as: buyerName });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().shelf.length;
}

// --- SND-01 -----------------------------------------------------------------

test('SND-01: the rights declaration is preserved in the audit record from creation', async () => {
  await makeArtist(app, pool, 'snd01_artist', { tier: 'paired' });
  const release = await makeRelease('snd01_artist');
  const { rows } = await pool.query(
    `SELECT action, meta FROM audit_log WHERE action = 'listing.rights_declaration' AND target = $1`,
    [`listing:${release.id}`],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.rightsRecording, true);
  assert.equal(rows[0].meta.rightsComposition, true);
});

test('SND-01: withdrawing a rights leg on a LIVE release takes it down and closes the door', async () => {
  const release = await makeRelease('snd01_artist', { title: 'Live Then Withdrawn' });
  await attachTrack('snd01_artist', release.id);
  await publishOk('snd01_artist', release.id);

  const patch = await call(app, {
    method: 'PATCH',
    url: `/v1/listings/${release.id}`,
    as: 'snd01_artist',
    payload: { rightsComposition: false },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal(patch.json().listing.status, 'draft', 'a withdrawn declaration unpublishes the release');

  const { rows: unpub } = await pool.query(
    `SELECT reason FROM audit_log WHERE action = 'listing.rights_gate_unpublish' AND target = $1`,
    [`listing:${release.id}`],
  );
  assert.equal(unpub.length, 1);
  assert.match(unpub[0].reason, /withdrawn/);

  const buy = await call(app, {
    method: 'POST',
    url: `/v1/listings/${release.id}/checkout`,
    as: 'snd01_fan',
  });
  assert.equal(buy.statusCode, 422);
});

test('SND-01: the buy-door recheck itself refuses a published release whose rights left force', async () => {
  const release = await makeRelease('snd01_artist', { title: 'Recheck Target' });
  await attachTrack('snd01_artist', release.id);
  await publishOk('snd01_artist', release.id);

  // State drift the PATCH cure cannot see (e.g. an admin hold landing
  // directly): the recheck is the second, independent line.
  await pool.query(`UPDATE listings SET rights_state = 'held_for_review' WHERE id = $1`, [release.id]);
  const held = await call(app, {
    method: 'POST',
    url: `/v1/listings/${release.id}/checkout`,
    as: 'snd01_fan',
  });
  assert.equal(held.statusCode, 422);
  assert.ok(held.json().error.failed.includes('music_rights_in_force'));

  await pool.query(
    `UPDATE listings SET rights_state = 'declared', rights_recording = false WHERE id = $1`,
    [release.id],
  );
  const revoked = await call(app, {
    method: 'POST',
    url: `/v1/listings/${release.id}/checkout`,
    as: 'snd01_fan',
  });
  assert.equal(revoked.statusCode, 422);
  assert.ok(revoked.json().error.failed.includes('music_rights_in_force'));
});

test('SND-01/SND-05: a suspended artist sells nothing until reinstated', async () => {
  const release = await makeRelease('snd01_artist', { title: 'Suspension Target' });
  await attachTrack('snd01_artist', release.id);
  await publishOk('snd01_artist', release.id);
  const artistId = await accountIdFor(pool, 'snd01_artist');

  await pool.query(`UPDATE accounts SET status = 'suspended' WHERE id = $1`, [artistId]);
  const buy = await call(app, {
    method: 'POST',
    url: `/v1/listings/${release.id}/checkout`,
    as: 'snd01_fan',
  });
  assert.equal(buy.statusCode, 422);
  assert.ok(buy.json().error.failed.includes('artist_account_active'));

  await pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [artistId]);
  const ok = await call(app, {
    method: 'POST',
    url: `/v1/listings/${release.id}/checkout`,
    as: 'snd01_fan',
  });
  assert.equal(ok.statusCode, 201, ok.body);
});

// --- SND-02 -----------------------------------------------------------------

test('SND-02: a held cover cannot launder its hold by flipping the declared kind', async () => {
  await makeArtist(app, pool, 'snd02_artist', { tier: 'paired' });
  const release = await makeRelease('snd02_artist', { title: 'Held Cover', contentKind: 'cover' });
  await attachTrack('snd02_artist', release.id);
  const first = await call(app, {
    method: 'POST',
    url: `/v1/listings/${release.id}/publish`,
    as: 'snd02_artist',
  });
  assert.equal(first.statusCode, 422);
  assert.equal((await listingRow(release.id)).rights_state, 'held_for_review');

  const flip = await call(app, {
    method: 'PATCH',
    url: `/v1/listings/${release.id}`,
    as: 'snd02_artist',
    payload: { contentKind: 'original' },
  });
  assert.equal(flip.statusCode, 200, flip.body);
  const second = await call(app, {
    method: 'POST',
    url: `/v1/listings/${release.id}/publish`,
    as: 'snd02_artist',
  });
  assert.equal(second.statusCode, 422, 'the hold is a state, not a label');
  assert.match(second.json().error.message, /RIGHTS REVIEW HOLD/);
  assert.equal((await listingRow(release.id)).status, 'draft');
});

test('SND-02: the reviewer queue shows the hold; a reasoned clear lets the cover publish', async () => {
  const release = await makeRelease('snd02_artist', { title: 'Clearable Cover', contentKind: 'cover' });
  await attachTrack('snd02_artist', release.id);
  await call(app, { method: 'POST', url: `/v1/listings/${release.id}/publish`, as: 'snd02_artist' });

  const denied = await call(app, { method: 'GET', url: '/v1/admin/listings/rights-holds', as: 'snd02_artist' });
  assert.equal(denied.statusCode, 403);
  const queue = await call(app, { method: 'GET', url: '/v1/admin/listings/rights-holds', as: 'snd_admin' });
  assert.equal(queue.statusCode, 200);
  assert.ok(queue.json().holds.some((h) => h.id === release.id));

  const noReason = await call(app, {
    method: 'POST',
    url: `/v1/admin/listings/${release.id}/rights-review`,
    as: 'snd_admin',
    payload: { decision: 'clear' },
  });
  assert.equal(noReason.statusCode, 400);

  const cleared = await call(app, {
    method: 'POST',
    url: `/v1/admin/listings/${release.id}/rights-review`,
    as: 'snd_admin',
    payload: { decision: 'clear', reason: 'Licence for the underlying composition verified' },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().listing.rightsState, 'cleared');

  await publishOk('snd02_artist', release.id);
  const catalog = await call(app, { method: 'GET', url: '/v1/sound/releases' });
  assert.ok(catalog.json().releases.some((r) => r.id === release.id), 'cleared cover is public');
});

test('SND-02: changing a cleared release reopens its review', async () => {
  const release = await makeRelease('snd02_artist', { title: 'Reopen By Patch', contentKind: 'cover' });
  await attachTrack('snd02_artist', release.id);
  await call(app, { method: 'POST', url: `/v1/listings/${release.id}/publish`, as: 'snd02_artist' });
  await call(app, {
    method: 'POST',
    url: `/v1/admin/listings/${release.id}/rights-review`,
    as: 'snd_admin',
    payload: { decision: 'clear', reason: 'Verified' },
  });
  await publishOk('snd02_artist', release.id);

  const patch = await call(app, {
    method: 'PATCH',
    url: `/v1/listings/${release.id}`,
    as: 'snd02_artist',
    payload: { contentKind: 'remix' },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal(patch.json().listing.status, 'draft', 'the changed release comes down');
  assert.equal(patch.json().listing.release.rightsState, 'held_for_review');
});

test('SND-02: attaching new content to a cleared release reopens its review', async () => {
  const release = await makeRelease('snd02_artist', { title: 'Reopen By Attach', contentKind: 'cover' });
  await attachTrack('snd02_artist', release.id);
  await call(app, { method: 'POST', url: `/v1/listings/${release.id}/publish`, as: 'snd02_artist' });
  await call(app, {
    method: 'POST',
    url: `/v1/admin/listings/${release.id}/rights-review`,
    as: 'snd_admin',
    payload: { decision: 'clear', reason: 'Verified' },
  });
  assert.equal((await listingRow(release.id)).rights_state, 'cleared');

  await attachTrack('snd02_artist', release.id, { title: 'Bonus Track' });
  assert.equal((await listingRow(release.id)).rights_state, 'held_for_review');
  const { rows } = await pool.query(
    `SELECT 1 FROM audit_log WHERE action = 'listing.rights_review_reopened' AND target = $1`,
    [`listing:${release.id}`],
  );
  assert.equal(rows.length, 1);
});

// --- SND-03 -----------------------------------------------------------------

function sessionEvent(type, { sessionId, paymentIntentId, orderId, paymentStatus }) {
  return {
    id: nextEventId('evt_snd03'),
    type,
    data: {
      object: {
        id: sessionId,
        payment_status: paymentStatus,
        payment_intent: paymentIntentId,
        metadata: { order_id: orderId },
      },
    },
  };
}

test("SND-03: session completion with payment_status 'unpaid' grants nothing; the async success settles", async () => {
  await makeArtist(app, pool, 'snd03_artist', { tier: 'paired' });
  const release = await makeRelease('snd03_artist', { title: 'Delayed Pay' });
  await attachTrack('snd03_artist', release.id);
  await publishOk('snd03_artist', release.id);
  const { order, sessionId, paymentIntentId } = await musicOrder('snd03_artist', 'snd03_fan', release.id);

  const res = await deliverStripeEvent(
    pool,
    sessionEvent('checkout.session.completed', {
      sessionId, paymentIntentId, orderId: order.id, paymentStatus: 'unpaid',
    }),
  );
  assert.equal(res.failed, 0);
  const { rows: p } = await pool.query('SELECT status FROM payments WHERE order_id = $1', [order.id]);
  assert.notEqual(p[0].status, 'succeeded', 'no settlement on an unpaid completion');
  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(o[0].status, 'checkout_open');
  const { rows: f } = await pool.query('SELECT state FROM fulfillments WHERE order_id = $1', [order.id]);
  assert.equal(f[0].state, 'awaiting_delivery', 'no delivery before the money');
  assert.equal(await shelfCount('snd03_fan'), 0, 'no shelf unlock before the money');

  await deliverStripeEvent(
    pool,
    sessionEvent('checkout.session.async_payment_succeeded', {
      sessionId, paymentIntentId, orderId: order.id, paymentStatus: 'paid',
    }),
  );
  const { rows: o2 } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(o2[0].status, 'delivered');
  assert.equal(await shelfCount('snd03_fan'), 1, 'the verified payment unlocks the shelf');
});

test('SND-03: an async payment failure closes the checkout and grants nothing', async () => {
  const release = await makeRelease('snd03_artist', { title: 'Delayed Fail' });
  await attachTrack('snd03_artist', release.id);
  await publishOk('snd03_artist', release.id);
  const { order, sessionId, paymentIntentId } = await musicOrder('snd03_artist', 'snd03_fan2', release.id);

  await deliverStripeEvent(
    pool,
    sessionEvent('checkout.session.completed', {
      sessionId, paymentIntentId, orderId: order.id, paymentStatus: 'unpaid',
    }),
  );
  await deliverStripeEvent(
    pool,
    sessionEvent('checkout.session.async_payment_failed', {
      sessionId, paymentIntentId, orderId: order.id, paymentStatus: 'unpaid',
    }),
  );
  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(o[0].status, 'canceled');
  assert.equal(await shelfCount('snd03_fan2'), 0);
});

test("SND-03: a session completed with payment_status 'paid' settles immediately", async () => {
  const release = await makeRelease('snd03_artist', { title: 'Instant Pay' });
  await attachTrack('snd03_artist', release.id);
  await publishOk('snd03_artist', release.id);
  const { order, sessionId, paymentIntentId } = await musicOrder('snd03_artist', 'snd03_fan3', release.id);
  await deliverStripeEvent(
    pool,
    sessionEvent('checkout.session.completed', {
      sessionId, paymentIntentId, orderId: order.id, paymentStatus: 'paid',
    }),
  );
  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(o[0].status, 'delivered');
  assert.equal(await shelfCount('snd03_fan3'), 1);
});

// --- SND-04 -----------------------------------------------------------------

test("SND-04: attach stores the STORED OBJECT's size — the declaration cannot inflate or deflate it", async () => {
  await makeArtist(app, pool, 'snd04_artist', { tier: 'paired' });
  const release = await makeRelease('snd04_artist', { title: 'Weighed Master' });
  probeImpl = async () => ({ sizeBytes: 4242, contentType: 'audio/mpeg' });
  try {
    const media = await attachTrack('snd04_artist', release.id, { sizeBytes: 999_999_999 });
    assert.equal(media.sizeBytes, 4242, 'the stored size is the object size');
  } finally {
    probeImpl = async (key) => {
      const ext = String(key).split('.').pop().toLowerCase();
      return { sizeBytes: null, contentType: PROBE_TYPES[ext] || null };
    };
  }
  const { rows } = await pool.query(
    'SELECT size_bytes FROM listing_media WHERE listing_id = $1',
    [release.id],
  );
  assert.equal(Number(rows[0].size_bytes), 4242);
});

test('SND-04: an object that was never uploaded cannot be attached', async () => {
  const release = await makeRelease('snd04_artist', { title: 'Ghost Upload' });
  probeImpl = async () => {
    const err = new Error('not found');
    err.code = 'object_not_found';
    throw err;
  };
  try {
    const accountId = await accountIdFor(pool, 'snd04_artist');
    const res = await call(app, {
      method: 'POST',
      url: `/v1/listings/${release.id}/media`,
      as: 'snd04_artist',
      payload: { key: `accounts/${accountId}/ghost.mp3`, kind: 'audio', title: 'Ghost' },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'media_not_uploaded');
  } finally {
    probeImpl = async (key) => {
      const ext = String(key).split('.').pop().toLowerCase();
      return { sizeBytes: null, contentType: PROBE_TYPES[ext] || null };
    };
  }
});

test('SND-04: a stored object of the wrong type cannot attach as a track', async () => {
  const release = await makeRelease('snd04_artist', { title: 'Wrong Type' });
  probeImpl = async () => ({ sizeBytes: 100, contentType: 'application/pdf' });
  try {
    const accountId = await accountIdFor(pool, 'snd04_artist');
    const res = await call(app, {
      method: 'POST',
      url: `/v1/listings/${release.id}/media`,
      as: 'snd04_artist',
      payload: { key: `accounts/${accountId}/sneaky.mp3`, kind: 'audio', title: 'Sneaky' },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'media_type_mismatch');
  } finally {
    probeImpl = async (key) => {
      const ext = String(key).split('.').pop().toLowerCase();
      return { sizeBytes: null, contentType: PROBE_TYPES[ext] || null };
    };
  }
});

test('SND-04: the cap is enforced at publish time against live state — a stale pass cannot publish twice', async () => {
  await makeArtist(app, pool, 'snd04_solo', { tier: 'solo' });
  const a = await makeRelease('snd04_solo', { title: 'Race A' });
  for (let i = 0; i < 3; i++) await attachTrack('snd04_solo', a.id, { title: `A${i}` });
  const b = await makeRelease('snd04_solo', { title: 'Race B' });
  for (let i = 0; i < 3; i++) await attachTrack('snd04_solo', b.id, { title: `B${i}` });

  // The race, staged: evaluated against the same empty catalog, BOTH
  // releases pass the gate (3 + 3 tracks, cap 5 — each read is stale
  // the moment the other publishes).
  const tierInfo = { tier: 'solo', entitledTier: 'solo' };
  const checkA = await musicPublishCheck(pool, { listing: await listingRow(a.id), ...tierInfo });
  const checkB = await musicPublishCheck(pool, { listing: await listingRow(b.id), ...tierInfo });
  assert.equal(checkA.ok, true);
  assert.equal(checkB.ok, true);

  // The endpoint re-evaluates under the artist lock at publish time:
  // exactly one of them can land.
  await publishOk('snd04_solo', a.id);
  const second = await call(app, {
    method: 'POST',
    url: `/v1/listings/${b.id}/publish`,
    as: 'snd04_solo',
  });
  assert.equal(second.statusCode, 422);
  assert.match(second.json().error.message, /CAPACITY/);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(t.track_count), 0)::int AS total FROM (
       SELECT (SELECT count(*) FROM listing_media m WHERE m.listing_id = l.id AND m.kind = 'audio') AS track_count
         FROM listings l WHERE l.account_id = $1 AND l.medium = 'music' AND l.status = 'published'
     ) t`,
    [await accountIdFor(pool, 'snd04_solo')],
  );
  assert.equal(rows[0].total, 3, 'the live catalog never exceeds the cap');
});

test('SND-04: drafts and archived releases consume no capacity — abandoned work frees the artist', async () => {
  await makeArtist(app, pool, 'snd04_free', { tier: 'solo' });
  const big = await makeRelease('snd04_free', { title: 'Five Pack' });
  for (let i = 0; i < 5; i++) await attachTrack('snd04_free', big.id, { title: `F${i}` });
  await publishOk('snd04_free', big.id);

  const next = await makeRelease('snd04_free', { title: 'Next One' });
  await attachTrack('snd04_free', next.id);
  const blocked = await call(app, {
    method: 'POST',
    url: `/v1/listings/${next.id}/publish`,
    as: 'snd04_free',
  });
  assert.equal(blocked.statusCode, 422);

  await call(app, { method: 'POST', url: `/v1/listings/${big.id}/archive`, as: 'snd04_free' });
  await publishOk('snd04_free', next.id);
});

// --- SND-05 -----------------------------------------------------------------

test('SND-05: a full refund revokes the buyer’s shelf access', async () => {
  await makeArtist(app, pool, 'snd05_artist', { tier: 'paired' });
  const release = await makeRelease('snd05_artist', { title: 'Refundable' });
  await attachTrack('snd05_artist', release.id);
  await publishOk('snd05_artist', release.id);
  const { order, sessionId, paymentIntentId } = await musicOrder('snd05_artist', 'snd05_fan', release.id);
  await deliverStripeEvent(pool, sessionCompletedEvent(order, sessionId, paymentIntentId));
  assert.equal(await shelfCount('snd05_fan'), 1);

  await deliverStripeEvent(pool, {
    id: nextEventId('evt_snd05_refund'),
    type: 'charge.refunded',
    data: {
      object: { id: 'ch_snd05', payment_intent: paymentIntentId, amount_refunded: 1000 },
    },
  });
  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(o[0].status, 'refunded');
  assert.equal(await shelfCount('snd05_fan'), 0, 'refunded money ends the entitlement');
});

test('SND-05: a dispute freezes the music transfer leg; winning unfreezes it', async () => {
  const release = await makeRelease('snd05_artist', { title: 'Disputed' });
  await attachTrack('snd05_artist', release.id);
  await publishOk('snd05_artist', release.id);
  const { order, sessionId, paymentIntentId } = await musicOrder('snd05_artist', 'snd05_fan2', release.id);
  await deliverStripeEvent(pool, sessionCompletedEvent(order, sessionId, paymentIntentId));

  await deliverStripeEvent(pool, {
    id: nextEventId('evt_snd05_dp'),
    type: 'charge.dispute.created',
    data: {
      object: {
        id: 'dp_snd05', charge: 'ch_snd05_dp', payment_intent: paymentIntentId,
        amount: 1000, reason: 'fraudulent',
      },
    },
  });
  const { rows: rel } = await pool.query('SELECT state FROM releases WHERE order_id = $1', [order.id]);
  assert.equal(rel[0].state, 'blocked_dispute', 'the music leg freezes like any other order');

  await deliverStripeEvent(pool, {
    id: nextEventId('evt_snd05_dp_closed'),
    type: 'charge.dispute.closed',
    data: {
      object: {
        id: 'dp_snd05', charge: 'ch_snd05_dp', payment_intent: paymentIntentId,
        amount: 1000, status: 'won',
      },
    },
  });
  const { rows: rel2 } = await pool.query('SELECT state FROM releases WHERE order_id = $1', [order.id]);
  assert.equal(rel2[0].state, 'awaiting_conditions');
});

test('SND-05: the admin rights hold is a takedown — the release comes down, unsellable, audited', async () => {
  const release = await makeRelease('snd05_artist', { title: 'Takedown Target' });
  await attachTrack('snd05_artist', release.id);
  await publishOk('snd05_artist', release.id);
  const catalogBefore = await call(app, { method: 'GET', url: '/v1/sound/releases' });
  assert.ok(catalogBefore.json().releases.some((r) => r.id === release.id));

  const denied = await call(app, {
    method: 'POST',
    url: `/v1/admin/listings/${release.id}/rights-review`,
    as: 'snd05_artist',
    payload: { decision: 'hold', reason: 'artist cannot self-hold' },
  });
  assert.equal(denied.statusCode, 403);

  const held = await call(app, {
    method: 'POST',
    url: `/v1/admin/listings/${release.id}/rights-review`,
    as: 'snd_admin',
    payload: { decision: 'hold', reason: 'Copyright claim received — release held pending review' },
  });
  assert.equal(held.statusCode, 200, held.body);
  assert.equal(held.json().listing.status, 'draft');
  assert.equal(held.json().listing.rightsState, 'held_for_review');

  const catalogAfter = await call(app, { method: 'GET', url: '/v1/sound/releases' });
  assert.ok(!catalogAfter.json().releases.some((r) => r.id === release.id), 'held release leaves the catalog');
  const buy = await call(app, {
    method: 'POST',
    url: `/v1/listings/${release.id}/checkout`,
    as: 'snd05_fan',
  });
  assert.equal(buy.statusCode, 422);

  const { rows } = await pool.query(
    `SELECT reason, meta FROM audit_log WHERE action = 'listing.rights_hold' AND target = $1`,
    [`listing:${release.id}`],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.unpublished, true);
});
