// The Common Room (M5) — posts and replies on real accounts.
//
// Law: posting requires a real signed-in account; reading requires one
// too (the room is a members' room, not a public feed). A blocked
// account's posts are hidden from the blocker everywhere, and blocking
// severs the reply path in both directions. Reports land in the admin
// queue (src/routes/admin.js decides them). Moderation is human ops
// work — there is deliberately no automated moderation here (the
// consult deferred it); the only automatic guard is a basic posting
// cadence so one account cannot flood the room.
import { requireAuth } from '../auth.js';

const POST_MIN_INTERVAL_SECONDS = 10;
const BODY_MAX = 2000;

function badRequest(reply, message) {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}

function notFound(reply, what = 'Post') {
  return reply.code(404).send({ error: { code: 'not_found', message: `${what} not found` } });
}

function postView(row) {
  return {
    id: row.id,
    authorAccountId: row.account_id,
    authorName: row.author_name ?? null,
    parentId: row.parent_id,
    body: row.body,
    status: row.status,
    replyCount: row.reply_count ?? null,
    createdAt: row.created_at,
  };
}

async function blockedByMe(pool, me, authorId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM blocks WHERE account_id = $1 AND blocked_account_id = $2',
    [me, authorId],
  );
  return rows.length > 0;
}

async function blockedEitherWay(pool, a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM blocks
      WHERE (account_id = $1 AND blocked_account_id = $2)
         OR (account_id = $2 AND blocked_account_id = $1)`,
    [a, b],
  );
  return rows.length > 0;
}

export function registerRoomRoutes(app, pool) {
  const auth = requireAuth(pool);

  // POST /v1/room/posts — a top-level post, or a reply when parentId
  // names a top-level post. Threads are one level deep by design.
  app.post('/v1/room/posts', { preHandler: auth }, async (req, reply) => {
    const body = req.body || {};
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text || text.length > BODY_MAX) {
      return badRequest(reply, `body is required (1–${BODY_MAX} chars)`);
    }
    // Basic rate sanity: one account, one post per few seconds.
    const { rows: recent } = await pool.query(
      `SELECT 1 FROM room_posts
        WHERE account_id = $1
          AND created_at > now() - ($2 || ' seconds')::interval
        LIMIT 1`,
      [req.account.id, String(POST_MIN_INTERVAL_SECONDS)],
    );
    if (recent.length) {
      return reply.code(429).send({
        error: { code: 'rate_limited', message: 'You are posting too quickly — give it a few seconds' },
      });
    }
    let parent = null;
    if (body.parentId) {
      const { rows } = await pool.query('SELECT * FROM room_posts WHERE id = $1', [body.parentId]);
      parent = rows[0] || null;
      if (!parent || parent.status !== 'visible') return notFound(reply);
      if (parent.parent_id !== null) {
        return reply.code(422).send({
          error: { code: 'thread_depth', message: 'Replies attach to a top-level post' },
        });
      }
      if (await blockedEitherWay(pool, req.account.id, parent.account_id)) {
        return reply.code(403).send({
          error: { code: 'blocked', message: 'Replies are closed between blocked accounts' },
        });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO room_posts (account_id, parent_id, body) VALUES ($1, $2, $3)
       RETURNING *, (SELECT display_name FROM accounts WHERE id = $1) AS author_name`,
      [req.account.id, parent ? parent.id : null, text],
    );
    return reply.code(201).send({ post: postView({ ...rows[0], reply_count: 0 }) });
  });

  // GET /v1/room/posts — the room feed: visible top-level posts, newest
  // first, minus anyone I blocked. Reply counts exclude blocked authors
  // and non-visible replies — the count is what I would actually see.
  app.get('/v1/room/posts', { preHandler: auth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT p.*,
              a.display_name AS author_name,
              (SELECT count(*)::int FROM room_posts r
                WHERE r.parent_id = p.id AND r.status = 'visible'
                  AND NOT EXISTS (SELECT 1 FROM blocks b
                                   WHERE b.account_id = $1 AND b.blocked_account_id = r.account_id)
              ) AS reply_count
         FROM room_posts p
         JOIN accounts a ON a.id = p.account_id
        WHERE p.parent_id IS NULL AND p.status = 'visible'
          AND NOT EXISTS (SELECT 1 FROM blocks b
                           WHERE b.account_id = $1 AND b.blocked_account_id = p.account_id)
        ORDER BY p.created_at DESC
        LIMIT 100`,
      [req.account.id],
    );
    return { posts: rows.map(postView) };
  });

  // GET /v1/room/posts/:id — one thread: the post + its visible replies,
  // with the same block filtering. A post by someone I blocked reads as
  // not found — from my side of the room, it is not there.
  app.get('/v1/room/posts/:id', { preHandler: auth }, async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT p.*, a.display_name AS author_name
         FROM room_posts p JOIN accounts a ON a.id = p.account_id
        WHERE p.id = $1`,
      [req.params.id],
    );
    const post = rows[0];
    if (!post || post.status !== 'visible') return notFound(reply);
    if (post.parent_id !== null) return notFound(reply);
    if (await blockedByMe(pool, req.account.id, post.account_id)) return notFound(reply);
    const { rows: replies } = await pool.query(
      `SELECT p.*, a.display_name AS author_name
         FROM room_posts p JOIN accounts a ON a.id = p.account_id
        WHERE p.parent_id = $1 AND p.status = 'visible'
          AND NOT EXISTS (SELECT 1 FROM blocks b
                           WHERE b.account_id = $2 AND b.blocked_account_id = p.account_id)
        ORDER BY p.created_at ASC`,
      [post.id, req.account.id],
    );
    return {
      post: postView({ ...post, reply_count: replies.length }),
      replies: replies.map((r) => postView({ ...r, reply_count: null })),
    };
  });

  // POST /v1/room/reports — report a post or an account into the admin
  // queue. One open report per (reporter, target): a repeat returns the
  // existing report instead of piling up.
  app.post('/v1/room/reports', { preHandler: auth }, async (req, reply) => {
    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null;
    let targetKind = null;
    let postId = null;
    let targetAccountId = null;
    if (body.postId) {
      const { rows } = await pool.query('SELECT id, account_id FROM room_posts WHERE id = $1', [
        body.postId,
      ]);
      if (!rows.length) return notFound(reply);
      if (rows[0].account_id === req.account.id) {
        return reply.code(422).send({
          error: { code: 'own_content', message: 'You cannot report your own post' },
        });
      }
      targetKind = 'post';
      postId = rows[0].id;
    } else if (body.accountId) {
      if (body.accountId === req.account.id) {
        return reply.code(422).send({
          error: { code: 'own_content', message: 'You cannot report yourself' },
        });
      }
      const { rows } = await pool.query('SELECT id FROM accounts WHERE id = $1', [body.accountId]);
      if (!rows.length) return notFound(reply, 'Account');
      targetKind = 'account';
      targetAccountId = body.accountId;
    } else {
      return badRequest(reply, 'Body requires postId or accountId');
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO reports (reporter_account_id, target_kind, post_id, target_account_id, reason)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.account.id, targetKind, postId, targetAccountId, reason],
      );
      return reply.code(201).send({ report: reportView(rows[0]), deduped: false });
    } catch (err) {
      if (err.code === '23505') {
        const { rows } = await pool.query(
          `SELECT * FROM reports
            WHERE reporter_account_id = $1 AND state = 'open'
              AND (($2 = 'post' AND post_id = $3) OR ($2 = 'account' AND target_account_id = $4))
            LIMIT 1`,
          [req.account.id, targetKind, postId, targetAccountId],
        );
        if (rows.length) return { report: reportView(rows[0]), deduped: true };
      }
      throw err;
    }
  });

  // Blocks: mine to manage. Blocking is silent — the blocked account is
  // never notified by the API.
  app.post('/v1/room/blocks', { preHandler: auth }, async (req, reply) => {
    const target = req.body?.accountId;
    if (!target) return badRequest(reply, 'Body requires accountId');
    if (target === req.account.id) {
      return reply.code(422).send({
        error: { code: 'own_account', message: 'You cannot block yourself' },
      });
    }
    const { rows } = await pool.query('SELECT id FROM accounts WHERE id = $1', [target]);
    if (!rows.length) return notFound(reply, 'Account');
    await pool.query(
      `INSERT INTO blocks (account_id, blocked_account_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.account.id, target],
    );
    return { blocked: true, accountId: target };
  });

  app.delete('/v1/room/blocks/:accountId', { preHandler: auth }, async (req) => {
    await pool.query('DELETE FROM blocks WHERE account_id = $1 AND blocked_account_id = $2', [
      req.account.id,
      req.params.accountId,
    ]);
    return { blocked: false, accountId: req.params.accountId };
  });

  app.get('/v1/room/blocks', { preHandler: auth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT b.blocked_account_id, a.display_name, b.created_at
         FROM blocks b JOIN accounts a ON a.id = b.blocked_account_id
        WHERE b.account_id = $1
        ORDER BY b.created_at DESC`,
      [req.account.id],
    );
    return {
      blocks: rows.map((r) => ({
        accountId: r.blocked_account_id,
        displayName: r.display_name,
        createdAt: r.created_at,
      })),
    };
  });
}

export function reportView(row) {
  return {
    id: row.id,
    reporterAccountId: row.reporter_account_id,
    targetKind: row.target_kind,
    postId: row.post_id,
    targetAccountId: row.target_account_id,
    reason: row.reason,
    state: row.state,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}
