// v91 — the unified intake layer (ChatGPT verdict REVIEW-VERDICT-V91).
// Covers the verdict's 18-point acceptance tracker as far as the local
// PGlite environment allows, plus failure injection against the atomic
// write-through law. Proofs that need production (a second physical
// device, the live Desk UI) are marked SHIP-LEG in the build report —
// their local halves (status read back through independent channels)
// are asserted here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';
import { installFakeStripe, stripeState } from './helpers/fakestripe.js';

stubClerk();
installFakeStripe();
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor, grantRole } = await import('./helpers/testapp.js');
const { makeArtist } = await import('./helpers/commerce.js');

let pool;
let app;
let keySeq = 0;
const key = (tag) => `test-${tag}-${++keySeq}`;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
  // An ops admin for the Desk legs.
  await call(app, { method: 'GET', url: '/v1/me', as: 'deskops' });
  await grantRole(pool, await accountIdFor(pool, 'deskops'), 'admin');
});

after(async () => {
  await app.close();
  await pool.end();
});

async function submitArtist(as, payload = {}, idem) {
  return call(app, {
    method: 'POST',
    url: '/v1/applications/artists',
    as,
    payload: {
      name: 'Intake Artist',
      category: 'Painting',
      work: 'Oils on canvas',
      idempotencyKey: idem || key('artist'),
      ...payload,
    },
  });
}
async function deskTransition(id, to, as = 'deskops') {
  return call(app, {
    method: 'POST',
    url: `/v1/admin/intake/${id}/transition`,
    as,
    payload: { to, reason: 'test transition' },
  });
}
async function deskDetail(id, as = 'deskops') {
  return call(app, { method: 'GET', url: `/v1/admin/intake/${id}`, as });
}
async function deskFind(reference) {
  const q = await call(app, {
    method: 'GET',
    url: `/v1/admin/intake/queue?q=${encodeURIComponent(reference)}`,
    as: 'deskops',
  });
  return q.json().submissions[0];
}
async function intakeRow(reference) {
  const { rows } = await pool.query('SELECT * FROM intake_submissions WHERE reference = $1', [reference]);
  return rows[0];
}

// Tracker 1 — artist application persists with reference + receipt.
test('artist application persists with a reference and a received event', async () => {
  const res = await submitArtist('doorartist');
  assert.equal(res.statusCode, 201, res.body);
  const sub = res.json().submission;
  assert.match(sub.reference, /^PAIRED-[A-Z2-9]{10}$/);
  assert.equal(sub.type, 'artist');
  assert.equal(sub.status, 'RECEIVED');
  assert.equal(sub.statusLabel, 'Received by PAIRED');

  const row = await intakeRow(sub.reference);
  assert.ok(row, 'intake row persisted');
  assert.equal(row.consent_at !== null, true, 'consent timestamp recorded');
  const { rows: events } = await pool.query(
    "SELECT * FROM intake_events WHERE submission_id = $1 AND kind = 'received'",
    [row.id],
  );
  assert.equal(events.length, 1, 'initial received event written (tracker 8)');

  const mine = await call(app, { method: 'GET', url: '/v1/me/applications', as: 'doorartist' });
  assert.ok(mine.json().applications.some((a) => a.reference === sub.reference));
});

// Tracker 2 — collector application (signed-in) persists with reference.
test('collector application persists for a signed-in collector', async () => {
  const res = await call(app, {
    method: 'POST',
    url: '/v1/applications/collectors',
    as: 'collector1',
    payload: { name: 'Collector One', interest: 'Original landscapes', idempotencyKey: key('col') },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.match(res.json().submission.reference, /^PAIRED-/);
  assert.equal(res.json().submission.statusLabel, 'Received by PAIRED');
});

// Tracker 3 + 11 — guest collector, accountless; enumeration-safe lookup.
test('guest collector submits accountless and looks up by reference + email', async () => {
  const res = await call(app, {
    method: 'POST',
    url: '/v1/applications/collectors',
    payload: {
      name: 'Guest Gwen',
      email: 'Gwen@Example.com ',
      interest: 'A first original',
      idempotencyKey: key('guest'),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const ref = res.json().submission.reference;
  const row = await intakeRow(ref);
  assert.equal(row.owner_account_id, null, 'guest row has no owner');
  assert.equal(row.contact_email, 'gwen@example.com', 'email normalized');

  const ok = await call(app, {
    method: 'POST',
    url: '/v1/intake/lookup',
    payload: { reference: ref, email: 'gwen@example.com' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().submission.status, 'RECEIVED');
  assert.equal(ok.json().submission.payload, undefined, 'lookup never returns the payload');

  // Enumeration safety: a wrong email and a nonexistent reference
  // return the IDENTICAL generic failure.
  const wrongEmail = await call(app, {
    method: 'POST',
    url: '/v1/intake/lookup',
    payload: { reference: ref, email: 'someoneelse@example.com' },
  });
  const noRef = await call(app, {
    method: 'POST',
    url: '/v1/intake/lookup',
    payload: { reference: 'PAIRED-ZZZZZZZZZZ', email: 'gwen@example.com' },
  });
  assert.equal(wrongEmail.statusCode, 404);
  assert.equal(noRef.statusCode, 404);
  assert.deepEqual(wrongEmail.json(), noRef.json(), 'identical generic failure — no enumeration');

  // The lookup is read-only: it cannot change the submission.
  const afterRow = await intakeRow(ref);
  assert.equal(afterRow.status, 'RECEIVED');
});

// Tracker 4 — collaboration persists and is retrievable.
test('collaboration application persists and is retrievable', async () => {
  const res = await call(app, {
    method: 'POST',
    url: '/v1/applications/collaborations',
    as: 'collab1',
    payload: { name: 'Collab Carla', craft: 'Ceramics', idempotencyKey: key('collab') },
  });
  assert.equal(res.statusCode, 201, res.body);
  const ref = res.json().submission.reference;
  const mine = await call(app, { method: 'GET', url: '/v1/me/applications', as: 'collab1' });
  assert.ok(mine.json().applications.some((a) => a.reference === ref && a.type === 'collaboration'));
  const desk = await deskFind(ref);
  assert.ok(desk, 'retrievable on the Desk too');
});

// Tracker 9 + 10 — idempotency: same key+payload → original; different
// payload → 409. Guests included (email scope, no NULL-owner hole).
test('idempotency: retry returns the original; conflicting retry is rejected', async () => {
  const k = key('idem');
  const first = await submitArtist('idemartist', {}, k);
  assert.equal(first.statusCode, 201);
  const retry = await submitArtist('idemartist', {}, k);
  assert.equal(retry.statusCode, 200, 'duplicate acknowledged, not recreated');
  assert.equal(retry.json().submission.reference, first.json().submission.reference);
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM intake_submissions WHERE idempotency_key = $1",
    [k],
  );
  assert.equal(rows[0].n, 1, 'exactly one row for the key');

  const conflict = await submitArtist('idemartist', { category: 'Sculpture' }, k);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'idempotency_conflict');

  // Guest scope: the same email + key dedupes without any account.
  const gk = key('gidem');
  const g1 = await call(app, {
    method: 'POST',
    url: '/v1/applications/collectors',
    payload: { name: 'Guest Ida', email: 'ida@example.com', idempotencyKey: gk },
  });
  const g2 = await call(app, {
    method: 'POST',
    url: '/v1/applications/collectors',
    payload: { name: 'Guest Ida', email: 'ida@example.com', idempotencyKey: gk },
  });
  assert.equal(g1.statusCode, 201);
  assert.equal(g2.statusCode, 200);
  assert.equal(g2.json().submission.reference, g1.json().submission.reference);
});

// Payload discipline: allowlist stripping + caps + required fields.
test('payload validation strips unknown fields and enforces caps', async () => {
  const stripped = await submitArtist('stripper', { hackerField: 'x', ssn: '000-00-0000' });
  assert.equal(stripped.statusCode, 201, stripped.body);
  const row = await intakeRow(stripped.json().submission.reference);
  assert.equal(row.payload.hackerField, undefined);
  assert.equal(row.payload.ssn, undefined, 'sensitive fields never enter the payload');

  const missing = await call(app, {
    method: 'POST',
    url: '/v1/applications/artists',
    as: 'noname',
    payload: { category: 'Painting', idempotencyKey: key('noname') },
  });
  assert.equal(missing.statusCode, 400);

  const huge = await submitArtist('huge', { note: 'x'.repeat(20000) });
  assert.equal(huge.statusCode, 400, 'payload cap enforced');
});

// Tracker 13 + 14 + 15 — Desk review: transitions write immutable
// events; the customer sees the new status; ACTION REQUIRED carries
// the action text.
test('desk transitions write events and the customer sees the update', async () => {
  const res = await submitArtist('flowartist');
  const ref = res.json().submission.reference;
  const deskRow = await deskFind(ref);

  const noReason = await call(app, {
    method: 'POST',
    url: `/v1/admin/intake/${deskRow.id}/transition`,
    as: 'deskops',
    payload: { to: 'UNDER_REVIEW' },
  });
  assert.equal(noReason.statusCode, 400, 'house law: admin actions require a reason');

  const illegal = await deskTransition(deskRow.id, 'APPROVED');
  assert.equal(illegal.statusCode, 409, 'RECEIVED cannot jump straight to APPROVED');
  assert.equal(illegal.json().error.code, 'invalid_transition');

  const moved = await deskTransition(deskRow.id, 'UNDER_REVIEW');
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().submission.statusLabel, 'Under review');

  const detail = await deskDetail(deskRow.id);
  const kinds = detail.json().events.map((e) => e.kind);
  assert.deepEqual(kinds, ['received', 'status'], 'every act is on the trail');

  // The trail is append-only: a direct UPDATE is refused by the DB.
  await assert.rejects(
    pool.query("UPDATE intake_events SET note = 'tampered' WHERE submission_id = $1", [deskRow.id]),
    /append-only/,
  );

  const ask = await call(app, {
    method: 'POST',
    url: `/v1/admin/intake/${deskRow.id}/request-info`,
    as: 'deskops',
    payload: { action: 'Please add a link to your portfolio.', reason: 'portfolio missing' },
  });
  assert.equal(ask.statusCode, 200, ask.body);
  assert.equal(ask.json().submission.status, 'ACTION_REQUIRED');
  assert.equal(ask.json().submission.actionNote, 'Please add a link to your portfolio.');

  // Tracker 15 + the local half of 12: the customer reads the updated
  // status (and the exact action ask) through their own channel.
  const mine = await call(app, { method: 'GET', url: '/v1/me/applications', as: 'flowartist' });
  const view = mine.json().applications.find((a) => a.reference === ref);
  assert.equal(view.status, 'ACTION_REQUIRED');
  assert.equal(view.statusLabel, 'Your response is needed');
  assert.equal(view.actionNote, 'Please add a link to your portfolio.');

  const approved = await deskTransition(deskRow.id, 'APPROVED');
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().submission.statusLabel, 'Approved');
});

// Verdict §D3 — an intake approval NEVER grants a role or membership.
test('an approved application grants no role, membership, or seller record', async () => {
  const res = await submitArtist('norole');
  const deskRow = await deskFind(res.json().submission.reference);
  await deskTransition(deskRow.id, 'UNDER_REVIEW');
  const ok = await deskTransition(deskRow.id, 'APPROVED');
  assert.equal(ok.statusCode, 200);
  const acctId = await accountIdFor(pool, 'norole');
  const { rows: roles } = await pool.query('SELECT role FROM account_roles WHERE account_id = $1', [acctId]);
  assert.deepEqual(roles.map((r) => r.role), ['buyer'], 'roles untouched by intake approval');
  const { rows: sellers } = await pool.query('SELECT account_id FROM artist_profiles WHERE account_id = $1', [acctId]);
  assert.equal(sellers.length, 0);
});

// Tracker 18 — CSV export is admin-only and carries no payload content.
test('csv export is admin-gated and privacy-restricted', async () => {
  const denied = await call(app, { method: 'GET', url: '/v1/admin/intake/export.csv', as: 'flowartist' });
  assert.equal(denied.statusCode, 403);
  const okCsv = await call(app, { method: 'GET', url: '/v1/admin/intake/export.csv?type=artist', as: 'deskops' });
  assert.equal(okCsv.statusCode, 200);
  assert.match(okCsv.headers['content-type'], /text\/csv/);
  assert.ok(okCsv.body.includes('reference,type,status,contact_email'));
  assert.ok(!okCsv.body.includes('Oils on canvas'), 'payload content is never exported');
});

// Desk queue search: by reference and by contact email.
test('desk queue searches by reference and by contact', async () => {
  const res = await submitArtist('searchme');
  const ref = res.json().submission.reference;
  const byRef = await deskFind(ref);
  assert.equal(byRef.reference, ref);
  const q = await call(app, {
    method: 'GET',
    url: '/v1/admin/intake/queue?type=artist&q=searchme%40example.test',
    as: 'deskops',
  });
  assert.ok(q.json().submissions.some((s) => s.reference === ref));
  assert.ok(q.json().counts.artist >= 1, 'counts come from persisted rows');
});

// ---------------------------------------------------------------------
// Commission flow: brief → publish → proposal → share → outcomes.
// Tracker 5, 6, 16, 17.
// ---------------------------------------------------------------------
async function postWrapperBrief(as, idem) {
  return call(app, {
    method: 'POST',
    url: '/v1/commission-briefs',
    as,
    payload: {
      title: 'Commission the intake way',
      budgetCents: 40000,
      deliverableType: 'physical',
      idempotencyKey: idem || key('brief'),
    },
  });
}
async function publishBrief(reference) {
  const deskRow = await deskFind(reference);
  const res = await deskTransition(deskRow.id, 'VISIBLE');
  assert.equal(res.statusCode, 200, res.body);
  return deskRow;
}

test('brief via the wrapper: canonical + intake, private until published', async () => {
  const res = await postWrapperBrief('wrapbuyer');
  assert.equal(res.statusCode, 201, res.body);
  const { brief, submission } = res.json();
  assert.equal(brief.status, 'open', 'canonical brief created by the one authoritative path');
  assert.equal(submission.status, 'RECEIVED');
  assert.match(submission.reference, /^PAIRED-/);

  // Tracker 16: a private (unpublished) brief never reaches the Board.
  let board = await call(app, { method: 'GET', url: '/v1/briefs' });
  assert.ok(!board.json().briefs.some((b) => b.id === brief.id));

  // The buyer's own status view carries it with its reference.
  const mine = await call(app, { method: 'GET', url: '/v1/me/commission-briefs', as: 'wrapbuyer' });
  const view = mine.json().briefs.find((b) => b.reference === submission.reference);
  assert.ok(view, 'own brief visible in the status view');
  assert.equal(view.statusLabel, 'Received by PAIRED');

  await publishBrief(submission.reference);
  board = await call(app, { method: 'GET', url: '/v1/briefs' });
  assert.ok(board.json().briefs.some((b) => b.id === brief.id), 'published brief is on the Board');
});

test('brief idempotency: same key returns the original brief', async () => {
  const k = key('briefidem');
  const a = await postWrapperBrief('idembuyer', k);
  const b = await postWrapperBrief('idembuyer', k);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 200);
  assert.equal(b.json().brief.id, a.json().brief.id);
  assert.equal(b.json().submission.reference, a.json().submission.reference);
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM briefs WHERE buyer_account_id = (SELECT id FROM accounts WHERE clerk_user_id = 'clerk_idembuyer')",
  );
  assert.equal(rows[0].n, 1, 'one canonical brief for the key');
});

test('proposal lifecycle: receipt does not advance the brief; sharing is explicit', async () => {
  const created = await postWrapperBrief('sharebuyer');
  const brief = created.json().brief;
  await publishBrief(created.json().submission.reference);

  await makeArtist(app, pool, 'proposer1');
  const prop = await call(app, {
    method: 'POST',
    url: `/v1/commission-briefs/${brief.id}/proposals`,
    as: 'proposer1',
    payload: { priceCents: 38000, message: 'I would love this one', idempotencyKey: key('prop') },
  });
  assert.equal(prop.statusCode, 201, prop.body);
  const propRef = prop.json().submission.reference;
  assert.equal(prop.json().submission.status, 'RECEIVED');
  assert.equal(prop.json().submission.statusLabel, 'Received');

  // Tracker 17, first half: receipt alone does NOT advance the brief.
  let briefRow = await intakeRow(created.json().submission.reference);
  assert.equal(briefRow.status, 'VISIBLE', 'brief unmoved by a received proposal');

  // A proposal cannot be accepted before it is shared (machine law).
  const propDesk = await deskFind(propRef);
  const jump = await deskTransition(propDesk.id, 'ACCEPTED');
  assert.equal(jump.statusCode, 409);

  // Sharing is the explicit event: the owner opens the pitch list.
  const seen = await call(app, { method: 'GET', url: `/v1/briefs/${brief.id}/pitches`, as: 'sharebuyer' });
  assert.equal(seen.statusCode, 200, seen.body);
  const propRow = await intakeRow(propRef);
  assert.equal(propRow.status, 'SHARED_WITH_BUYER');
  briefRow = await intakeRow(created.json().submission.reference);
  assert.equal(briefRow.status, 'PROPOSALS_RECEIVED', 'sharing advances the published brief one step');

  // Withdrawal mirrors to WITHDRAWN and cannot advance the brief.
  const wd = await call(app, {
    method: 'POST',
    url: `/v1/pitches/${prop.json().pitch.id}/withdraw`,
    as: 'proposer1',
  });
  assert.equal(wd.statusCode, 200);
  assert.equal((await intakeRow(propRef)).status, 'WITHDRAWN');
  assert.equal((await intakeRow(created.json().submission.reference)).status, 'PROPOSALS_RECEIVED');
});

test('award mirrors into intake: winner accepted, rival declined, brief accepted', async () => {
  const created = await postWrapperBrief('awardbuyer');
  const brief = created.json().brief;
  await publishBrief(created.json().submission.reference);

  await makeArtist(app, pool, 'awardwinner', { tier: 'paired' });
  await makeArtist(app, pool, 'awardrival');
  const win = await call(app, {
    method: 'POST',
    url: `/v1/commission-briefs/${brief.id}/proposals`,
    as: 'awardwinner',
    payload: { priceCents: 40000, idempotencyKey: key('win') },
  });
  const lose = await call(app, {
    method: 'POST',
    url: `/v1/commission-briefs/${brief.id}/proposals`,
    as: 'awardrival',
    payload: { priceCents: 39000, idempotencyKey: key('lose') },
  });
  assert.equal(win.statusCode, 201, win.body);
  assert.equal(lose.statusCode, 201, lose.body);

  // Owner reviews (shares) both, then accepts through the canonical door.
  await call(app, { method: 'GET', url: `/v1/briefs/${brief.id}/pitches`, as: 'awardbuyer' });
  const accept = await call(app, {
    method: 'POST',
    url: `/v1/pitches/${win.json().pitch.id}/accept`,
    as: 'awardbuyer',
  });
  assert.equal(accept.statusCode, 201, accept.body);

  assert.equal((await intakeRow(win.json().submission.reference)).status, 'ACCEPTED');
  assert.equal((await intakeRow(lose.json().submission.reference)).status, 'DECLINED');
  assert.equal((await intakeRow(created.json().submission.reference)).status, 'ACCEPTED');
  const mine = await call(app, { method: 'GET', url: '/v1/me/commission-briefs', as: 'awardbuyer' });
  const view = mine.json().briefs.find((b) => b.reference === created.json().submission.reference);
  assert.equal(view.statusLabel, 'Proposal accepted');
});

// ---------------------------------------------------------------------
// Founding: apply/status NOT replaced; intake adds reference + unified
// status; desk decisions mirror. Tracker 7.
// ---------------------------------------------------------------------
test('founding apply gains a reference and the desk decision mirrors', async () => {
  await call(app, { method: 'GET', url: '/v1/me', as: 'founder1' });
  const applied = await call(app, {
    method: 'POST',
    url: '/v1/founding/apply',
    as: 'founder1',
    payload: { note: 'Founding hopeful' },
  });
  assert.equal(applied.statusCode, 201, applied.body);
  const sub = applied.json().submission;
  assert.ok(sub?.reference?.startsWith('PAIRED-'), 'founding carries an intake reference');
  assert.equal(sub.status, 'RECEIVED');

  const mine = await call(app, { method: 'GET', url: '/v1/me/applications', as: 'founder1' });
  const view = mine.json().applications.find((a) => a.type === 'founding');
  assert.ok(view, 'founding appears in the unified status view');
  assert.equal(view.canonicalStatus, 'pending');

  const decided = await call(app, {
    method: 'POST',
    url: '/v1/admin/founding/decide',
    as: 'deskops',
    payload: { applicationId: applied.json().application.id, decision: 'approved', reason: 'test approval' },
  });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal((await intakeRow(sub.reference)).status, 'APPROVED', 'decision mirrored to intake');

  const status = await call(app, { method: 'GET', url: '/v1/founding/status', as: 'founder1' });
  assert.equal(status.json().application.status, 'approved', 'canonical status endpoint unchanged');
});

// ---------------------------------------------------------------------
// Failure injection (verdict §E): fail each write of the atomic triple
// in turn — canonical, intake, event — and prove no orphans survive
// on either side and no receipt is issued.
// ---------------------------------------------------------------------
test('failure injection: a failed write anywhere leaves no orphans', async () => {
  // One statement per query: the pool speaks the extended protocol,
  // which refuses multi-command strings.
  await pool.query('CREATE TABLE IF NOT EXISTS fi_flags (kind text PRIMARY KEY)');
  await pool.query(`CREATE OR REPLACE FUNCTION fi_guard() RETURNS trigger AS $fn$
    BEGIN
      IF EXISTS (SELECT 1 FROM fi_flags WHERE kind = TG_ARGV[0]) THEN
        RAISE EXCEPTION 'injected failure: %', TG_ARGV[0];
      END IF;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql`);
  await pool.query('DROP TRIGGER IF EXISTS fi_briefs ON briefs');
  await pool.query('DROP TRIGGER IF EXISTS fi_intake ON intake_submissions');
  await pool.query('DROP TRIGGER IF EXISTS fi_events ON intake_events');
  await pool.query("CREATE TRIGGER fi_briefs BEFORE INSERT ON briefs FOR EACH ROW EXECUTE FUNCTION fi_guard('canonical')");
  await pool.query("CREATE TRIGGER fi_intake BEFORE INSERT ON intake_submissions FOR EACH ROW EXECUTE FUNCTION fi_guard('intake')");
  await pool.query("CREATE TRIGGER fi_events BEFORE INSERT ON intake_events FOR EACH ROW EXECUTE FUNCTION fi_guard('event')");
  const counts = async () => {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM briefs) AS briefs,
              (SELECT count(*)::int FROM intake_submissions) AS intake,
              (SELECT count(*)::int FROM intake_events) AS events`,
    );
    return rows[0];
  };
  for (const kind of ['canonical', 'intake', 'event']) {
    const beforeCounts = await counts();
    await pool.query('INSERT INTO fi_flags (kind) VALUES ($1)', [kind]);
    try {
      const res = await postWrapperBrief('failbuyer');
      assert.equal(res.statusCode, 500, `${kind} failure surfaces as an error, never a receipt`);
      assert.equal(res.json().submission, undefined);
    } finally {
      await pool.query('DELETE FROM fi_flags WHERE kind = $1', [kind]);
    }
    assert.deepEqual(await counts(), beforeCounts, `${kind} failure: no orphans on either side`);
  }
  await pool.query('DROP TRIGGER IF EXISTS fi_briefs ON briefs');
  await pool.query('DROP TRIGGER IF EXISTS fi_intake ON intake_submissions');
  await pool.query('DROP TRIGGER IF EXISTS fi_events ON intake_events');
  await pool.query('DROP TABLE IF EXISTS fi_flags');
});

// ---------------------------------------------------------------------
// Migration 0009 backfill: pre-existing founding applications gain
// legacy intake records with their ORIGINAL timestamps (verdict A5).
// ---------------------------------------------------------------------
test('migration 0009 backfills founding applications as legacy records', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const migDir = path.join(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '../migrations',
  );
  const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    for (const f of files.filter((f) => f < '0009')) {
      await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }
    const acct = await db.query(
      `INSERT INTO accounts (clerk_user_id, email, display_name)
       VALUES ('clerk_legacy', 'legacy@example.com', 'Legacy Founder') RETURNING id`,
    );
    await db.query(
      `INSERT INTO founding_applications (account_id, note, status, created_at)
       VALUES ($1, 'early applicant', 'pending', '2025-01-15T10:00:00Z')`,
      [acct.rows[0].id],
    );
    await db.exec(fs.readFileSync(path.join(migDir, '0009_intake.sql'), 'utf8'));

    const { rows } = await db.query(
      "SELECT * FROM intake_submissions WHERE type = 'founding'",
    );
    assert.equal(rows.length, 1, 'one legacy intake record');
    const legacy = rows[0];
    assert.equal(legacy.is_legacy, true);
    assert.match(legacy.reference, /^PAIRED-LEGACY-/);
    assert.equal(legacy.status, 'RECEIVED', 'pending maps to RECEIVED');
    assert.equal(
      new Date(legacy.created_at).toISOString(),
      '2025-01-15T10:00:00.000Z',
      'historical timestamp preserved, never rewritten',
    );
    const { rows: ev } = await db.query(
      "SELECT * FROM intake_events WHERE submission_id = $1 AND kind = 'legacy_backfill'",
      [legacy.id],
    );
    assert.equal(ev.length, 1, 'the backfill itself is on the trail');
  } finally {
    await db.close();
  }
});
