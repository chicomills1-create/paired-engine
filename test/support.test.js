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
    const res = await ask({
      name: `Asker ${i}`,
      email: `asker${i}@example.com`,
      question: `Question number ${i}?`,
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
