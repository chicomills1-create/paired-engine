// SOUND build — music listings on the shared machinery.
// Covers: the 0% fee snapshot at every tier · audio presign allowlist ·
// release create/attach/publish gates (tracks, rights declaration,
// originals-only hold, tier capacity, storage) · public catalog privacy
// (track metadata yes, audio URLs no) · multi-sale checkout (music is
// not one-of-one) · settlement auto-delivery · the buyer's shelf with
// signed download URLs · release of 100% of the price.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';
import { installFakeStripe, stripeState } from './helpers/fakestripe.js';

stubClerk();
installFakeStripe();
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec' + String.fromCharCode(95) + 'test';

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor } = await import('./helpers/testapp.js');
const { makeArtist, deliverStripeEvent, sessionCompletedEvent } = await import('./helpers/commerce.js');
const { feeSnapshotForListing, musicFeeSnapshot, MUSIC_CALC_VERSION } = await import('../src/lib/fees.js');
const { evaluateRelease } = await import('../src/lib/release.js');
const { getStripe } = await import('../src/stripe.js');
const { setHeadObjectProbe } = await import('../src/lib/storage.js');

// SND-04: attach now verifies the stored object via HEAD whenever
// storage is configured. This suite fabricates keys for objects it
// never PUTs, so it installs the storage probe: every fabricated key
// "exists" with a plausible content type for its extension and NO
// reported size — the declared sizes therefore stand, exactly what
// these tests assert. (The size-wins / not-found / type-mismatch
// branches are proven in test/snd-controls.test.js.)
const PROBE_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
  ogg: 'audio/ogg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};
setHeadObjectProbe(async (key) => {
  const ext = String(key).split('.').pop().toLowerCase();
  return { sizeBytes: null, contentType: PROBE_TYPES[ext] || null };
});

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

function configureS3() {
  process.env.S3_BUCKET = 'paired-media-test';
  process.env.S3_REGION = 'us-east-2';
  process.env.S3_ACCESS_KEY_ID = 'AKIA' + 'TEST000000000000';
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret-not-a-real-key';
}

async function makeRelease(as, payload = {}) {
  const res = await call(app, {
    method: 'POST',
    url: '/v1/listings',
    as,
    payload: {
      medium: 'music',
      title: 'First Light',
      priceCents: 1000,
      releaseType: 'single',
      genre: 'Soul',
      artistCredit: as,
      rightsRecording: true,
      rightsComposition: true,
      contentKind: 'original',
      ...payload,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().listing;
}

async function attach(as, listingId, kind, extra = {}) {
  const accountId = await accountIdFor(pool, as);
  const ext = kind === 'audio' ? 'mp3' : kind === 'cover' ? 'jpg' : 'png';
  return call(app, {
    method: 'POST',
    url: `/v1/listings/${listingId}/media`,
    as,
    payload: {
      key: `accounts/${accountId}/${Math.random().toString(36).slice(2)}.${ext}`,
      kind,
      ...extra,
    },
  });
}

async function attachTrack(as, listingId, { title = 'Track', sizeBytes = 5_000_000, durationSec = 200 } = {}) {
  const res = await attach(as, listingId, 'audio', { title, sizeBytes, durationSec });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().media;
}

// --- Fee math ---------------------------------------------------------------

test('music fee snapshot: 0% at every tier, artist keeps the full price', () => {
  for (const tier of ['solo', 'paired', 'ensemble']) {
    const snap = feeSnapshotForListing({ medium: 'music', tier, entitledTier: tier, priceCents: 20000 });
    assert.equal(snap.rateBps, 0, tier);
    assert.equal(snap.artistShareCents, 20000, tier);
    assert.equal(snap.platformShareCents, 0, tier);
    assert.equal(snap.calcVersion, MUSIC_CALC_VERSION, tier);
  }
  const founding = feeSnapshotForListing({ medium: 'music', tier: 'founding', entitledTier: 'paired', priceCents: 999 });
  assert.equal(founding.artistShareCents, 999);
  // Visual listings still snapshot under the tier rates through the same door.
  const visual = feeSnapshotForListing({ medium: 'visual', tier: 'solo', entitledTier: 'solo', priceCents: 20000 });
  assert.equal(visual.rateBps, 800);
  assert.throws(() => musicFeeSnapshot({ tier: 'solo', priceCents: -1 }), /priceCents/);
});

// --- Presign ----------------------------------------------------------------

test('audio presign fails closed without storage config (503)', async () => {
  const res = await call(app, {
    method: 'POST', url: '/v1/uploads/presign', as: 'presign_paula',
    payload: { contentType: 'audio/mpeg', kind: 'audio' },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'not_configured');
});

test('audio presign: allowlist per kind, namespaced keys, right extensions', async () => {
  configureS3();
  const paulaId = await accountIdFor(pool, 'presign_paula');
  const cases = [
    ['audio/mpeg', '.mp3'],
    ['audio/wav', '.wav'],
    ['audio/x-wav', '.wav'],
    ['audio/flac', '.flac'],
    ['audio/mp4', '.m4a'],
    ['audio/ogg', '.ogg'],
  ];
  for (const [contentType, ext] of cases) {
    const res = await call(app, {
      method: 'POST', url: '/v1/uploads/presign', as: 'presign_paula',
      payload: { contentType, kind: 'audio' },
    });
    assert.equal(res.statusCode, 200, contentType);
    const body = res.json();
    assert.match(body.key, new RegExp(`^accounts/${paulaId}/[0-9a-f-]{36}\\${ext}$`));
    assert.equal(body.kind, 'audio');
    assert.ok(body.url.includes('X-Amz-Signature='));
  }
  // The kind allowlists do not cross: audio type at the image door and
  // an image type at the audio door are both refused, as are non-media.
  for (const payload of [
    { contentType: 'audio/mpeg' },
    { contentType: 'audio/mpeg', kind: 'image' },
    { contentType: 'image/png', kind: 'audio' },
    { contentType: 'application/pdf', kind: 'audio' },
    { contentType: 'audio/mpeg', kind: 'video' },
  ]) {
    const res = await call(app, { method: 'POST', url: '/v1/uploads/presign', as: 'presign_paula', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  // The image door keeps its exact M2 behavior.
  const img = await call(app, {
    method: 'POST', url: '/v1/uploads/presign', as: 'presign_paula', payload: { contentType: 'image/png' },
  });
  assert.equal(img.statusCode, 200);
  assert.equal(img.json().kind, 'image');
});

// --- Create + attach ----------------------------------------------------------

test('a music listing is born digital with its release record', async () => {
  await makeArtist(app, pool, 'musa', { tier: 'paired' });
  const listing = await makeRelease('musa', { type: 'physical' });
  assert.equal(listing.medium, 'music');
  assert.equal(listing.type, 'digital', 'music forces digital delivery');
  assert.equal(listing.category, 'Music');
  assert.equal(listing.release.releaseType, 'single');
  assert.equal(listing.release.rightsDeclared, true);
  assert.deepEqual(listing.tracks, []);
});

test('media kinds: audio + cover attach to music only; metadata rides the row', async () => {
  const visual = await call(app, {
    method: 'POST', url: '/v1/listings', as: 'musa', payload: { title: 'A Painting', priceCents: 5000 },
  });
  const visualId = visual.json().listing.id;
  const badAudio = await attach('musa', visualId, 'audio', { title: 'Nope' });
  assert.equal(badAudio.statusCode, 400);
  const badCover = await attach('musa', visualId, 'cover', {});
  assert.equal(badCover.statusCode, 400);
  const okImage = await attach('musa', visualId, 'image', {});
  assert.equal(okImage.statusCode, 201);

  const release = await makeRelease('musa', { title: 'Attach Test' });
  const track = await attachTrack('musa', release.id, { title: 'Song One', sizeBytes: 12345, durationSec: 187 });
  assert.equal(track.title, 'Song One');
  assert.equal(track.sizeBytes, 12345);
  assert.equal(track.durationSec, 187);
  const cover = await attach('musa', release.id, 'cover', {});
  assert.equal(cover.statusCode, 201);
});

// --- Publish gates ------------------------------------------------------------

test('publish gate: a release needs at least one track', async () => {
  const release = await makeRelease('musa', { title: 'No Tracks Yet' });
  const res = await call(app, { method: 'POST', url: `/v1/listings/${release.id}/publish`, as: 'musa' });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, 'publish_guard');
  assert.match(res.json().error.message, /at least one track/);
});

test('publish gate: both rights legs must be declared', async () => {
  const release = await makeRelease('musa', { title: 'Undeclared', rightsComposition: false });
  await attachTrack('musa', release.id);
  const res = await call(app, { method: 'POST', url: `/v1/listings/${release.id}/publish`, as: 'musa' });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error.message, /RIGHTS DECLARATION INCOMPLETE/);
});

test('publish gate: covers HOLD for rights review — the hold is a record', async () => {
  const release = await makeRelease('musa', { title: 'A Cover', contentKind: 'cover' });
  await attachTrack('musa', release.id);
  const res = await call(app, { method: 'POST', url: `/v1/listings/${release.id}/publish`, as: 'musa' });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error.message, /ORIGINALS-ONLY AT LAUNCH/);
  const { rows } = await pool.query('SELECT status, rights_state FROM listings WHERE id = $1', [release.id]);
  assert.equal(rows[0].status, 'draft');
  assert.equal(rows[0].rights_state, 'held_for_review');
});

test('capacity: Solo holds 5 tracks of singles — the 6th track cannot publish', async () => {
  await makeArtist(app, pool, 'solo_sue', { tier: 'solo' });
  const first = await makeRelease('solo_sue', { title: 'Five Pack' });
  for (let i = 0; i < 5; i++) await attachTrack('solo_sue', first.id, { title: `T${i}` });
  const pub = await call(app, { method: 'POST', url: `/v1/listings/${first.id}/publish`, as: 'solo_sue' });
  assert.equal(pub.statusCode, 200, pub.body);

  const second = await makeRelease('solo_sue', { title: 'One Too Many' });
  await attachTrack('solo_sue', second.id);
  const res = await call(app, { method: 'POST', url: `/v1/listings/${second.id}/publish`, as: 'solo_sue' });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error.message, /CAPACITY/);
});

test("capacity: Solo's one album is allowed while nothing else is live", async () => {
  await makeArtist(app, pool, 'album_al', { tier: 'solo' });
  const album = await makeRelease('album_al', { title: 'The Album', releaseType: 'album' });
  for (let i = 0; i < 8; i++) await attachTrack('album_al', album.id, { title: `A${i}` });
  const pub = await call(app, { method: 'POST', url: `/v1/listings/${album.id}/publish`, as: 'album_al' });
  assert.equal(pub.statusCode, 200, pub.body);

  const single = await makeRelease('album_al', { title: 'Extra Single' });
  await attachTrack('album_al', single.id);
  const res = await call(app, { method: 'POST', url: `/v1/listings/${single.id}/publish`, as: 'album_al' });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error.message, /CAPACITY/);
});

test('capacity: declared master sizes enforce the storage cap', async () => {
  await makeArtist(app, pool, 'heavy_hank', { tier: 'paired' });
  const release = await makeRelease('heavy_hank', { title: 'Too Heavy' });
  await attachTrack('heavy_hank', release.id, { sizeBytes: 11 * 1024 * 1024 * 1024 });
  const res = await call(app, { method: 'POST', url: `/v1/listings/${release.id}/publish`, as: 'heavy_hank' });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error.message, /STORAGE/);
});

// --- Catalog privacy ----------------------------------------------------------

let flowReleaseId;

test('the public catalog shows track metadata and NO audio URLs', async () => {
  const release = await makeRelease('musa', { title: 'Catalog Piece' });
  await attachTrack('musa', release.id, { title: 'Alpha' });
  await attachTrack('musa', release.id, { title: 'Beta' });
  const pub = await call(app, { method: 'POST', url: `/v1/listings/${release.id}/publish`, as: 'musa' });
  assert.equal(pub.statusCode, 200, pub.body);
  flowReleaseId = release.id;

  const anon = await call(app, { method: 'GET', url: '/v1/sound/releases' });
  assert.equal(anon.statusCode, 200);
  const found = anon.json().releases.find((r) => r.id === release.id);
  assert.ok(found, 'published release is in the catalog');
  assert.deepEqual(found.tracks.map((t) => t.title), ['Alpha', 'Beta']);
  for (const m of found.media.filter((x) => x.kind === 'audio')) {
    assert.equal(m.url, null, 'anonymous reads never carry a full-track URL');
  }
  // The owner, and only the owner, sees audio URLs on the listing view.
  const owner = await call(app, { method: 'GET', url: `/v1/listings/${release.id}`, as: 'musa' });
  for (const m of owner.json().listing.media.filter((x) => x.kind === 'audio')) {
    assert.ok(m.url && m.url.includes('X-Amz-Signature='), 'owner audio URL is signed');
  }
});

// --- The money flow -----------------------------------------------------------

test('music checkout: 0% snapshot, no reservation, and a second buyer can buy', async () => {
  const one = await call(app, { method: 'POST', url: `/v1/listings/${flowReleaseId}/checkout`, as: 'fan_one' });
  assert.equal(one.statusCode, 201, one.body);
  const order = one.json().order;
  assert.equal(order.kind, 'digital');
  assert.deepEqual(order.feeSnapshot, {
    tier: 'paired',
    entitledTier: 'paired',
    rateBps: 0,
    calcVersion: MUSIC_CALC_VERSION,
    artistShareCents: 1000,
    platformShareCents: 0,
  });
  const { rows } = await pool.query(
    'SELECT reservation_ref, reservation_expires_at FROM orders WHERE id = $1',
    [order.id],
  );
  assert.equal(rows[0].reservation_ref, null);
  assert.equal(rows[0].reservation_expires_at, null);

  const two = await call(app, { method: 'POST', url: `/v1/listings/${flowReleaseId}/checkout`, as: 'fan_two' });
  assert.equal(two.statusCode, 201, two.body);

  const { rows: l } = await pool.query('SELECT inventory_state FROM listings WHERE id = $1', [flowReleaseId]);
  assert.equal(l[0].inventory_state, 'available', 'music never reserves or depletes');
});

test('settlement auto-delivers; the shelf unlocks with signed track URLs', async () => {
  const { rows: open } = await pool.query(
    `SELECT * FROM orders WHERE listing_id = $1 AND status = 'checkout_open' ORDER BY created_at ASC`,
    [flowReleaseId],
  );
  assert.equal(open.length, 2);
  const order = open[0];
  const rec = stripeState.sessions.find((s) => s.session.id === order.stripe_checkout_session_id);
  await deliverStripeEvent(pool, sessionCompletedEvent(order, order.stripe_checkout_session_id, rec.session.payment_intent));

  const { rows: o } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(o[0].status, 'delivered');
  const { rows: f } = await pool.query('SELECT state, delivery_ref FROM fulfillments WHERE order_id = $1', [order.id]);
  assert.equal(f[0].state, 'delivered');
  assert.equal(f[0].delivery_ref, `listing:${flowReleaseId}`);
  const { rows: l } = await pool.query('SELECT inventory_state FROM listings WHERE id = $1', [flowReleaseId]);
  assert.equal(l[0].inventory_state, 'available', 'settlement never marks music sold');

  // The settled buyer owns it on the shelf; the unsettled buyer does not.
  const buyerId = order.buyer_account_id;
  const { rows: acct } = await pool.query('SELECT clerk_user_id FROM accounts WHERE id = $1', [buyerId]);
  const buyerName = acct[0].clerk_user_id.replace('clerk_', '');
  const shelf = await call(app, { method: 'GET', url: '/v1/sound/shelf', as: buyerName });
  assert.equal(shelf.statusCode, 200);
  assert.equal(shelf.json().shelf.length, 1);
  const entry = shelf.json().shelf[0];
  assert.equal(entry.orderId, order.id);
  assert.equal(entry.tracks.length, 2);
  for (const t of entry.tracks) assert.ok(t.downloadUrl && t.downloadUrl.includes('X-Amz-Signature='));

  const other = await call(app, { method: 'GET', url: '/v1/sound/shelf', as: 'fan_two' });
  assert.equal(other.json().shelf.length, 0, 'an unpaid checkout unlocks nothing');

  // Download logging rides the existing digital endpoint.
  const dl = await call(app, { method: 'POST', url: `/v1/orders/${order.id}/download`, as: buyerName });
  assert.equal(dl.statusCode, 200, dl.body);
  assert.equal(dl.json().order.fulfillment.downloads, 1);

  // Acceptance, then the release pays 100% of the price — to the cent.
  const acc = await call(app, { method: 'POST', url: `/v1/orders/${order.id}/accept`, as: buyerName });
  assert.equal(acc.statusCode, 200, acc.body);
  const rel = await evaluateRelease(pool, getStripe(), order.id);
  assert.equal(rel.transferred, true);
  const transfer = stripeState.transfers.at(-1);
  assert.equal(transfer.params.amount, 1000, 'the artist receives 100% of the listed price');
  const { rows: fee } = await pool.query(
    `SELECT amount_cents FROM ledger_entries WHERE order_id = $1 AND kind = 'platform_fee'`,
    [order.id],
  );
  assert.equal(fee[0].amount_cents, 0);
});

test('the Sound studio face reports releases + capacity from the record', async () => {
  const res = await call(app, { method: 'GET', url: '/v1/sound/studio', as: 'musa' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.capacity.tier, 'paired');
  assert.equal(body.capacity.tracks, 50);
  assert.ok(body.capacity.used.tracks >= 2);
  assert.ok(body.releases.some((r) => r.id === flowReleaseId && r.status === 'published'));
});

test('buy-door recheck still guards music: an unverified artist cannot sell', async () => {
  await makeArtist(app, pool, 'unverified_uma', { verified: false });
  const release = await makeRelease('unverified_uma', { title: 'Uma Sings' });
  await attachTrack('unverified_uma', release.id);
  const pub = await call(app, { method: 'POST', url: `/v1/listings/${release.id}/publish`, as: 'unverified_uma' });
  assert.equal(pub.statusCode, 200, pub.body);
  const res = await call(app, { method: 'POST', url: `/v1/listings/${release.id}/checkout`, as: 'fan_one' });
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.failed.includes('artist_verified'));
});
