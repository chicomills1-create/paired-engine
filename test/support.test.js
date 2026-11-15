// ASK PAIRED CURE — the support question record (mailto-class cure,
// desk order 2026-11-15).
//
// The form used to keep the question in the visitor's localStorage and
// hand off through mailto:. These legs prove the replacement: a PUBLIC
// POST stores the question server-side and returns a reference the ack
// can quote; validation refuses bad input with 400 and stores nothing;
// references are unique; the ops read is admin-only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';

stubClerk();

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor, grantRole } = await import('./helpers/testapp.js');

let pool;
let app;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
  // An admin reader and a plain signed-in non-admin.
  await call(app, { method: 'GET', url: '/v1/me', as: 'supportadmin' });
  await grantRole(pool, await accountIdFor(pool, 'supportadmin'), 'admin');
  await call(app, { method: 'GET', url: '/v1/me', as: 'plainvisitor' });
});

after(async () => {
  await app.close();
  await pool.end();
});

function ask(payload, as) {
  return call(app, { method: 'POST', url: '/v1/support/ask', as, payload });
}

test('public POST stores the question and returns a reference — no auth needed', async () => {
  const res = await ask({
    name: 'Casey Collector',
    email: 'casey@example.com',
    question: 'Do you ship originals to Canada?',
  });
  assert.equal(res.statusCode, 201, res.body);
  const { reference } = res.json();
  assert.match(reference, /^ASK-[A-HJ-KM-NP-Z2-9]{6}$/);

  const { rows } = await pool.query(
    'SELECT reference, name, email, question, status FROM support_questions WHERE reference = $1',
    [reference],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Casey Collector');
  assert.equal(rows[0].email, 'casey@example.com');
  assert.equal(rows[0].question, 'Do you ship originals to Canada?');
  assert.equal(rows[0].status, 'open');
});

test('validation failures are 400 and store nothing', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM support_questions')).rows[0].n;
  const bad = [
    [{ email: 'a@b.co', question: 'Hi?' }, 'name_required'],
    [{ name: '   ', email: 'a@b.co', question: 'Hi?' }, 'name_required'],
    [{ name: 'A'.repeat(121), email: 'a@b.co', question: 'Hi?' }, 'name_too_long'],
    [{ name: 'Jo', question: 'Hi?' }, 'email_required'],
    [{ name: 'Jo', email: 'not-an-email', question: 'Hi?' }, 'email_invalid'],
    [{ name: 'Jo', email: 'jo@example', question: 'Hi?' }, 'email_invalid'],
    [{ name: 'Jo', email: 'jo @example.com', question: 'Hi?' }, 'email_invalid'],
    [{ name: 'Jo', email: 'jo@example.com' }, 'question_required'],
    [{ name: 'Jo', email: 'jo@example.com', question: '  ' }, 'question_required'],
    [{ name: 'Jo', email: 'jo@example.com', question: 'x'.repeat(4001) }, 'question_too_long'],
    [{ name: 42, email: 'jo@example.com', question: 'Hi?' }, 'name_required'],
  ];
  for (const [payload, code] of bad) {
    const res = await ask(payload);
    assert.equal(res.statusCode, 400, `${code}: ${res.body}`);
    assert.equal(res.json().error.code, code);
  }
  const after = (await pool.query('SELECT count(*)::int AS n FROM support_questions')).rows[0].n;
  assert.equal(after, before, 'a rejected question is never stored');
});

test('references are unique across many questions', async () => {
  const refs = new Set();
  for (let i = 0; i < 40; i += 1) {
    // Each asker submits from their own source address — the ASK-01
    // write quota is per source, and forty distinct people are not
    // one flooder.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support/ask',
      remoteAddress: `203.0.113.${10 + i}`,
      headers: { 'content-type': 'application/json' },
      payload: {
        name: `Asker ${i}`,
        email: `asker${i}@example.com`,
        question: `Question number ${i}?`,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    refs.add(res.json().reference);
  }
  assert.equal(refs.size, 40);
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n, count(DISTINCT reference)::int AS d FROM support_questions',
  );
  assert.equal(rows[0].n, rows[0].d, 'the UNIQUE constraint agrees: no duplicate references');
});

test('admin read: 401 unauthenticated, 403 non-admin, 200 admin — newest first', async () => {
  const anon = await call(app, { method: 'GET', url: '/v1/admin/support/questions' });
  assert.equal(anon.statusCode, 401);

  const nonAdmin = await call(app, { method: 'GET', url: '/v1/admin/support/questions', as: 'plainvisitor' });
  assert.equal(nonAdmin.statusCode, 403);

  const res = await call(app, { method: 'GET', url: '/v1/admin/support/questions', as: 'supportadmin' });
  assert.equal(res.statusCode, 200, res.body);
  const { questions } = res.json();
  assert.ok(questions.length >= 41);
  const first = questions.find((q) => q.name === 'Casey Collector');
  assert.ok(first, 'the very first stored question is readable ops-side');
  assert.equal(first.email, 'casey@example.com');
  assert.equal(first.status, 'open');
  const stamps = questions.map((q) => new Date(q.createdAt).getTime());
  const sorted = [...stamps].sort((a, b) => b - a);
  assert.deepEqual(stamps, sorted, 'newest first');
});

test('admin read can filter by status', async () => {
  const res = await call(app, {
    method: 'GET', url: '/v1/admin/support/questions?status=answered', as: 'supportadmin',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().questions.length, 0);
});

// ---- ASK-01: abuse protection ----------------------------------------

test('link-stuffed questions are rejected as spam and store nothing', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM support_questions')).rows[0].n;
  const stuffed = await ask({
    name: 'Link Larry',
    email: 'larry@example.com',
    question: 'Deals! https://a.example.com http://b.example.com www.c.example.com https://d.example.com — act now',
  });
  assert.equal(stuffed.statusCode, 400, stuffed.body);
  assert.equal(stuffed.json().error.code, 'too_many_links');

  const urlName = await ask({
    name: 'https://spam.example.com',
    email: 'larry@example.com',
    question: 'A perfectly ordinary question?',
  });
  assert.equal(urlName.statusCode, 400, urlName.body);
  assert.equal(urlName.json().error.code, 'name_invalid');

  // A couple of links inside a real question are fine — the rule is
  // proportionate, not a blanket ban on links.
  const legit = await ask({
    name: 'Pat Painter',
    email: 'pat@example.com',
    question: 'My portfolio is at https://pat.example.com and my shop at https://shop.example.com — can I link both from my page?',
  });
  assert.equal(legit.statusCode, 201, legit.body);

  const after = (await pool.query('SELECT count(*)::int AS n FROM support_questions')).rows[0].n;
  assert.equal(after, before + 1, 'only the legitimate question was stored');
});

test('write quota: the 21st stored question from one source is 429; other sources are unaffected', async () => {
  const from = (ip, i) => app.inject({
    method: 'POST',
    url: '/v1/support/ask',
    remoteAddress: ip,
    headers: { 'content-type': 'application/json' },
    payload: {
      name: 'Floody Fran',
      email: 'fran@example.com',
      question: `A distinct question, number ${i}?`,
    },
  });
  for (let i = 0; i < 20; i += 1) {
    const res = await from('198.51.100.7', i);
    assert.equal(res.statusCode, 201, res.body);
  }
  const blocked = await from('198.51.100.7', 20);
  assert.equal(blocked.statusCode, 429, blocked.body);
  assert.equal(blocked.json().error.code, 'rate_limited');
  assert.ok(Number(blocked.headers['retry-after']) > 0, 'a Retry-After is quoted');

  const other = await from('198.51.100.8', 99);
  assert.equal(other.statusCode, 201, other.body);
});

// ---- ASK-02: the reference is a receipt, not a capability ------------

test('the reference is a receipt, not a lookup: no read path is keyed by it', async () => {
  const res = await ask({
    name: 'Receipt Ruth',
    email: 'ruth@example.com',
    question: 'Can anyone read this back with just my reference?',
  });
  assert.equal(res.statusCode, 201, res.body);
  const { reference } = res.json();
  for (const url of [`/v1/support/questions/${reference}`, `/v1/support/ask/${reference}`]) {
    const probe = await call(app, { method: 'GET', url });
    assert.equal(probe.statusCode, 404, `${url} must not exist`);
  }
});

// ---- ASK-03: duplicate suppression -----------------------------------

test('a client retry of the same question returns the original reference and stores one record', async () => {
  const payload = {
    name: 'Retry Rita',
    email: 'rita@example.com',
    question: 'Did my question about framing costs go through?',
  };
  const first = await ask(payload);
  assert.equal(first.statusCode, 201, first.body);
  const reference = first.json().reference;

  const retry = await ask(payload);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().reference, reference, 'the retry quotes the ORIGINAL reference');
  assert.equal(retry.json().duplicate, true);

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM support_questions WHERE email = $1 AND question = $2',
    [payload.email, payload.question],
  );
  assert.equal(rows[0].n, 1, 'the retry stored no second record');

  // Suppression is scoped to the identical question — a different
  // question from the same asker is a new record with a new reference.
  const different = await ask({ ...payload, question: 'A different question entirely?' });
  assert.equal(different.statusCode, 201, different.body);
  assert.notEqual(different.json().reference, reference);
});
