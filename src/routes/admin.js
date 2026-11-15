// Admin console API (M5) — the ops reads and decisions behind the
// Studio's human back office.
//
// Law (M0 + consult M5): every admin ACTION carries a reason, written to
// audit_log with the actor and timestamp — no reason, no action (400).
// Reads are admin-role only. The verification queue NEVER returns proof
// codes (the M2 rule: a proof code is visible to its artist alone, and
// the decide endpoint never echoes it either).
import { requireAuth, requireRole } from '../auth.js';
import { orderView } from './orders.js';
import { reportView } from './room.js';

/** The reason gate shared by every admin action in this module. */
export function requireReason(req, reply) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) {
    reply.code(400).send({
      error: {
        code: 'reason_required',
        message: 'A reason is required for admin actions (it is written to the audit log)',
      },
    });
    return null;
  }
  return reason.slice(0, 1000);
}

async function audit(pool, actorId, action, target, reason, meta = {}) {
  await pool.query(
    `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, action, target, reason, JSON.stringify(meta)],
  );
}

function exceptionView(row) {
  return {
    id: row.id,
    kind: row.kind,
    orderId: row.order_id,
    accountId: row.account_id,
    stripeObjectId: row.stripe_object_id,
    detail: row.detail,
    state: row.state,
    resolutionReason: row.resolution_reason,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerAdminRoutes(app, pool) {
  const auth = requireAuth(pool);
  const admin = requireRole('admin');
  const gate = [auth, admin];

  // GET /v1/admin/verifications/queue — the human-made review queue.
  // Default: the open states (submitted + under_review), oldest first —
  // the order a reviewer works them. ?state= reads one state exactly.
  app.get('/v1/admin/verifications/queue', { preHandler: gate }, async (req) => {
    const state = typeof req.query?.state === 'string' ? req.query.state : null;
    const { rows } = state
      ? await pool.query(
          `SELECT v.id, v.account_id, v.shop_url, v.state, v.evidence_notes,
                  v.submitted_at, v.decided_at, a.email, a.display_name
             FROM verification_requests v JOIN accounts a ON a.id = v.account_id
            WHERE v.state = $1
            ORDER BY v.submitted_at ASC LIMIT 200`,
          [state],
        )
      : await pool.query(
          `SELECT v.id, v.account_id, v.shop_url, v.state, v.evidence_notes,
                  v.submitted_at, v.decided_at, a.email, a.display_name
             FROM verification_requests v JOIN accounts a ON a.id = v.account_id
            WHERE v.state IN ('submitted', 'under_review')
            ORDER BY v.submitted_at ASC LIMIT 200`,
        );
    return {
      queue: rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        email: r.email,
        displayName: r.display_name,
        shopUrl: r.shop_url,
        state: r.state,
        evidenceNotes: r.evidence_notes,
        submittedAt: r.submitted_at,
        decidedAt: r.decided_at,
      })),
    };
  });

  // GET /v1/admin/founding/applications — the Founding 100 review list.
  // Decisions run through POST /v1/admin/founding/decide (M1) with its
  // atomic seat claim; ?status= filters (default: all, newest first).
  app.get('/v1/admin/founding/applications', { preHandler: gate }, async (req) => {
    const status = typeof req.query?.status === 'string' ? req.query.status : null;
    const { rows } = status
      ? await pool.query(
          `SELECT f.id, f.account_id, f.note, f.status, f.decided_at, f.created_at,
                  a.email, a.display_name,
                  (SELECT seat_no FROM founding_seats s WHERE s.account_id = f.account_id) AS seat_no
             FROM founding_applications f JOIN accounts a ON a.id = f.account_id
            WHERE f.status = $1
            ORDER BY f.created_at DESC LIMIT 200`,
          [status],
        )
      : await pool.query(
          `SELECT f.id, f.account_id, f.note, f.status, f.decided_at, f.created_at,
                  a.email, a.display_name,
                  (SELECT seat_no FROM founding_seats s WHERE s.account_id = f.account_id) AS seat_no
             FROM founding_applications f JOIN accounts a ON a.id = f.account_id
            ORDER BY f.created_at DESC LIMIT 200`,
        );
    const { rows: countRows } = await pool.query(
      'SELECT count(*)::int AS claimed FROM founding_seats WHERE account_id IS NOT NULL',
    );
    return {
      applications: rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        email: r.email,
        displayName: r.display_name,
        note: r.note,
        status: r.status,
        seatNo: r.seat_no,
        decidedAt: r.decided_at,
        createdAt: r.created_at,
      })),
      seatsClaimed: countRows[0].claimed,
      seatsTotal: 100,
    };
  });

  // GET /v1/admin/orders — every order with its full state (the M3 admin
  // reads): order status, payment, fulfillment, and the release record
  // with transfer_state and payout_state separate. ?status= filters.
  app.get('/v1/admin/orders', { preHandler: gate }, async (req) => {
    const status = typeof req.query?.status === 'string' ? req.query.status : null;
    const limit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 200);
    const { rows } = status
      ? await pool.query(
          'SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
          [status, limit],
        )
      : await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT $1', [limit]);
    const orders = [];
    for (const o of rows) orders.push(await orderView(pool, o));
    return { orders };
  });

  // GET /v1/admin/reports — the moderation queue (default: open).
  app.get('/v1/admin/reports', { preHandler: gate }, async (req) => {
    const state = typeof req.query?.state === 'string' ? req.query.state : 'open';
    const { rows } = await pool.query(
      `SELECT r.*, p.body AS post_body, p.status AS post_status,
              a.email AS reporter_email
         FROM reports r
         LEFT JOIN room_posts p ON p.id = r.post_id
         JOIN accounts a ON a.id = r.reporter_account_id
        WHERE r.state = $1
        ORDER BY r.created_at ASC LIMIT 200`,
      [state],
    );
    return {
      reports: rows.map((r) => ({
        ...reportView(r),
        reporterEmail: r.reporter_email,
        postBody: r.post_body ? String(r.post_body).slice(0, 280) : null,
        postStatus: r.post_status,
      })),
    };
  });

  // POST /v1/admin/reports/:id/decide — actioned | dismissed, with a
  // reason. Deciding a report does NOT itself moderate content: hiding
  // or removing a post is its own audited act (below), so the record
  // shows who did what, separately.
  app.post('/v1/admin/reports/:id/decide', { preHandler: gate }, async (req, reply) => {
    const decision = req.body?.decision;
    if (!['actioned', 'dismissed'].includes(decision)) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: "Body requires decision ('actioned'|'dismissed')" },
      });
    }
    const reason = requireReason(req, reply);
    if (reason === null) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM reports WHERE id = $1 FOR UPDATE', [
        req.params.id,
      ]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: { code: 'not_found', message: 'Report not found' } });
      }
      if (rows[0].state !== 'open') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: { code: 'already_decided', message: `Report is already ${rows[0].state}` },
        });
      }
      const { rows: updated } = await client.query(
        `UPDATE reports SET state = $1, decided_by = $2, decided_at = now()
          WHERE id = $3 RETURNING *`,
        [decision, req.account.id, req.params.id],
      );
      await audit(client, req.account.id, 'report.decide', `report:${req.params.id}`, reason, {
        decision,
        targetKind: rows[0].target_kind,
      });
      await client.query('COMMIT');
      return { report: reportView(updated[0]) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  // POST /v1/admin/room/posts/:id/moderate — hide | remove | restore a
  // room post, with a reason. Removed is terminal for display; hidden is
  // reversible via restore. The author's own record is never deleted.
  app.post('/v1/admin/room/posts/:id/moderate', { preHandler: gate }, async (req, reply) => {
    const action = req.body?.action;
    const transitions = { hide: 'hidden', remove: 'removed', restore: 'visible' };
    if (!transitions[action]) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: "Body requires action ('hide'|'remove'|'restore')" },
      });
    }
    const reason = requireReason(req, reply);
    if (reason === null) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM room_posts WHERE id = $1 FOR UPDATE', [
        req.params.id,
      ]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: { code: 'not_found', message: 'Post not found' } });
      }
      const post = rows[0];
      const next = transitions[action];
      const legal =
        (action === 'hide' && post.status === 'visible') ||
        (action === 'remove' && post.status !== 'removed') ||
        (action === 'restore' && post.status === 'hidden');
      if (!legal) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: {
            code: 'invalid_state',
            message: `Cannot ${action} a post in state '${post.status}'`,
          },
        });
      }
      const { rows: updated } = await client.query(
        'UPDATE room_posts SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [next, post.id],
      );
      await audit(client, req.account.id, 'room.moderate', `room_post:${post.id}`, reason, {
        action,
        from: post.status,
        to: next,
        authorAccountId: post.account_id,
      });
      await client.query('COMMIT');
      return {
        post: {
          id: updated[0].id,
          authorAccountId: updated[0].account_id,
          parentId: updated[0].parent_id,
          body: updated[0].body,
          status: updated[0].status,
          createdAt: updated[0].created_at,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  // GET /v1/admin/exceptions — the reconciliation / money exception
  // queue (default: open). Written by the M6 reconciliation job and by
  // any leg that meets money it cannot reconcile.
  app.get('/v1/admin/exceptions', { preHandler: gate }, async (req) => {
    const state = typeof req.query?.state === 'string' ? req.query.state : 'open';
    const { rows } = await pool.query(
      'SELECT * FROM exception_queue WHERE state = $1 ORDER BY created_at ASC LIMIT 200',
      [state],
    );
    return { exceptions: rows.map(exceptionView) };
  });

  // POST /v1/admin/exceptions/:id/acknowledge — a human has seen it.
  app.post('/v1/admin/exceptions/:id/acknowledge', { preHandler: gate }, async (req, reply) => {
    const reason = requireReason(req, reply);
    if (reason === null) return;
    const { rows } = await pool.query(
      `UPDATE exception_queue SET state = 'acknowledged', updated_at = now()
        WHERE id = $1 AND state = 'open' RETURNING *`,
      [req.params.id],
    );
    if (!rows.length) {
      const { rows: existing } = await pool.query('SELECT state FROM exception_queue WHERE id = $1', [
        req.params.id,
      ]);
      if (!existing.length) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Exception not found' } });
      }
      return reply.code(409).send({
        error: { code: 'invalid_state', message: `Exception is already ${existing[0].state}` },
      });
    }
    await audit(pool, req.account.id, 'exception.acknowledge', `exception:${req.params.id}`, reason, {});
    return { exception: exceptionView(rows[0]) };
  });

  // POST /v1/admin/exceptions/:id/resolve — the discrepancy is explained
  // or repaired; the resolution reason is the record of what was true.
  app.post('/v1/admin/exceptions/:id/resolve', { preHandler: gate }, async (req, reply) => {
    const reason = requireReason(req, reply);
    if (reason === null) return;
    const { rows } = await pool.query(
      `UPDATE exception_queue
          SET state = 'resolved', resolution_reason = $2, resolved_by = $3,
              resolved_at = now(), updated_at = now()
        WHERE id = $1 AND state IN ('open', 'acknowledged') RETURNING *`,
      [req.params.id, reason, req.account.id],
    );
    if (!rows.length) {
      const { rows: existing } = await pool.query('SELECT state FROM exception_queue WHERE id = $1', [
        req.params.id,
      ]);
      if (!existing.length) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Exception not found' } });
      }
      return reply.code(409).send({
        error: { code: 'invalid_state', message: `Exception is already ${existing[0].state}` },
      });
    }
    await audit(pool, req.account.id, 'exception.resolve', `exception:${req.params.id}`, reason, {});
    return { exception: exceptionView(rows[0]) };
  });
}
