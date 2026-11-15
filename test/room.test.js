// M5 — The Common Room: posts + replies on real accounts, block
// semantics (hidden from the blocker, replies severed both ways),
// reports into the admin queue, and human moderation with audit.
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
  await call(app, { method: 'GET', url: '/v1/studio/buyer', as: 'roomadmin' });
  await grantRole(pool, await accountIdFor(pool, 'roomadmin'), 'admin');
});

after(async () => {
  await app.close();
  await pool.end();
});

async function post(as, body, parentId) {
  return call(app, {
    method: 'POST',
    url: '/v1/room/posts',
    as,
    payload: parentId ? { body, parentId } : { body },
  });
}

test('posting requires an account; posts and replies read back as a thread', async () => {
  const anon = await call(app, { method: 'POST', url: '/v1/room/posts', payload: { body: 'hello' } });
  assert.equal(anon.statusCode, 401);
  const anonRead = await call(app, { method: 'GET', url: '/v1/room/posts' });
  assert.equal(anonRead.statusCode, 401);

  const empty = await post('poster1', '   ');
  assert.equal(empty.statusCode, 400);

  const p1 = await post('poster1', 'Opening night was unreal — thank you all');
  assert.equal(p1.statusCode, 201, p1.body);
  const postId = p1.json().post.id;

  const reply = await post('poster2', 'The light in the second room!', postId);
  assert.equal(reply.statusCode, 201, reply.body);

  const deep = await post('poster3', 'Nested too far', reply.json().post.id);
  assert.equal(deep.statusCode, 422);
  assert.equal(deep.json().error.code, 'thread_depth');

  const feed = await call(app, { method: 'GET', url: '/v1/room/posts', as: 'poster3' });
  const mine = feed.json().posts.find((p) => p.id === postId);
  assert.ok(mine);
  assert.equal(mine.replyCount, 1);
  assert.equal(mine.authorName, null); // display_name unset until set — the field is the record's

  const thread = await call(app, { method: 'GET', url: `/v1/room/posts/${postId}`, as: 'poster2' });
  assert.equal(thread.json().replies.length, 1);
  assert.equal(thread.json().replies[0].body, 'The light in the second room!');
});

test('the posting cadence is enforced (basic rate sanity)', async () => {
  const first = await post('speedy', 'One');
  assert.equal(first.statusCode, 201);
  const second = await post('speedy', 'Two, instantly');
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, 'rate_limited');

  // Age the first post past the window; posting opens again.
  await pool.query(
    `UPDATE room_posts SET created_at = now() - interval '11 seconds' WHERE account_id =
       (SELECT id FROM accounts WHERE clerk_user_id = 'clerk_speedy')`,
  );
  const third = await post('speedy', 'Three, after a breath');
  assert.equal(third.statusCode, 201);
});

test('blocking hides posts from the blocker and severs replies both ways', async () => {
  const aPost = await post('blocka', 'A post from A');
  const bPost = await post('blockb', 'A post from B');
  const aId = await accountIdFor(pool, 'blocka');
  const bId = await accountIdFor(pool, 'blockb');
  assert.ok(aId && bId);

  // Age both posts past the posting-cadence window so the replies below
  // exercise the BLOCK check, not the rate gate.
  await pool.query(
    `UPDATE room_posts SET created_at = now() - interval '11 seconds'
      WHERE account_id = ANY($1)`,
    [[aId, bId]],
  );

  const blocked = await call(app, {
    method: 'POST', url: '/v1/room/blocks', as: 'blockb', payload: { accountId: aId },
  });
  assert.equal(blocked.statusCode, 200);

  // B's feed no longer carries A's post; the thread reads as not found.
  const feed = await call(app, { method: 'GET', url: '/v1/room/posts', as: 'blockb' });
  assert.ok(!feed.json().posts.some((p) => p.id === aPost.json().post.id));
  const thread = await call(app, { method: 'GET', url: `/v1/room/posts/${aPost.json().post.id}`, as: 'blockb' });
  assert.equal(thread.statusCode, 404);

  // A cannot reply to B, and B cannot reply to A.
  const aReply = await post('blocka', 'A tries to reply to B', bPost.json().post.id);
  assert.equal(aReply.statusCode, 403);
  const bReply = await post('blockb', 'B tries to reply to A', aPost.json().post.id);
  assert.equal(bReply.statusCode, 403);

  // A's own view of the room is untouched.
  const aFeed = await call(app, { method: 'GET', url: '/v1/room/posts', as: 'blocka' });
  assert.ok(aFeed.json().posts.some((p) => p.id === bPost.json().post.id));

  const list = await call(app, { method: 'GET', url: '/v1/room/blocks', as: 'blockb' });
  assert.equal(list.json().blocks.length, 1);
  assert.equal(list.json().blocks[0].accountId, aId);

  const un = await call(app, { method: 'DELETE', url: `/v1/room/blocks/${aId}`, as: 'blockb' });
  assert.equal(un.json().blocked, false);
});

test('reports land in the admin queue, dedupe, and decide only with a reason', async () => {
  const p = await post('reported1', 'A post someone dislikes');
  const postId = p.json().post.id;

  const own = await call(app, {
    method: 'POST', url: '/v1/room/reports', as: 'reported1', payload: { postId },
  });
  assert.equal(own.statusCode, 422);

  const r1 = await call(app, {
    method: 'POST', url: '/v1/room/reports', as: 'reporter1',
    payload: { postId, reason: 'Spam links in the replies' },
  });
  assert.equal(r1.statusCode, 201, r1.body);
  assert.equal(r1.json().deduped, false);

  const r2 = await call(app, {
    method: 'POST', url: '/v1/room/reports', as: 'reporter1', payload: { postId },
  });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().deduped, true);
  assert.equal(r2.json().report.id, r1.json().report.id);

  const queue = await call(app, { method: 'GET', url: '/v1/admin/reports', as: 'roomadmin' });
  assert.ok(queue.json().reports.some((r) => r.id === r1.json().report.id));

  const noReason = await call(app, {
    method: 'POST', url: `/v1/admin/reports/${r1.json().report.id}/decide`, as: 'roomadmin',
    payload: { decision: 'dismissed' },
  });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.json().error.code, 'reason_required');

  const decided = await call(app, {
    method: 'POST', url: `/v1/admin/reports/${r1.json().report.id}/decide`, as: 'roomadmin',
    payload: { decision: 'dismissed', reason: 'Good-faith post; no rule broken' },
  });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal(decided.json().report.state, 'dismissed');

  const { rows } = await pool.query(
    `SELECT reason FROM audit_log WHERE action = 'report.decide' AND target = $1`,
    [`report:${r1.json().report.id}`],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'Good-faith post; no rule broken');

  const again = await call(app, {
    method: 'POST', url: `/v1/admin/reports/${r1.json().report.id}/decide`, as: 'roomadmin',
    payload: { decision: 'actioned', reason: 'Second look' },
  });
  assert.equal(again.statusCode, 409);
});

test('moderation: hide removes a post from the room; restore brings it back; both audited', async () => {
  const p = await post('modtarget', 'Borderline post');
  const postId = p.json().post.id;

  const nonAdmin = await call(app, {
    method: 'POST', url: `/v1/admin/room/posts/${postId}/moderate`, as: 'modtarget',
    payload: { action: 'hide', reason: 'self-mod attempt' },
  });
  assert.equal(nonAdmin.statusCode, 403);

  const noReason = await call(app, {
    method: 'POST', url: `/v1/admin/room/posts/${postId}/moderate`, as: 'roomadmin',
    payload: { action: 'hide' },
  });
  assert.equal(noReason.statusCode, 400);

  const hidden = await call(app, {
    method: 'POST', url: `/v1/admin/room/posts/${postId}/moderate`, as: 'roomadmin',
    payload: { action: 'hide', reason: 'Under review after reports' },
  });
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.equal(hidden.json().post.status, 'hidden');

  const feed = await call(app, { method: 'GET', url: '/v1/room/posts', as: 'poster1' });
  assert.ok(!feed.json().posts.some((x) => x.id === postId));
  const thread = await call(app, { method: 'GET', url: `/v1/room/posts/${postId}`, as: 'poster1' });
  assert.equal(thread.statusCode, 404);

  const restored = await call(app, {
    method: 'POST', url: `/v1/admin/room/posts/${postId}/moderate`, as: 'roomadmin',
    payload: { action: 'restore', reason: 'Review complete — no violation' },
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().post.status, 'visible');

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'room.moderate' AND target = $1`,
    [`room_post:${postId}`],
  );
  assert.equal(rows[0].n, 2);
});
