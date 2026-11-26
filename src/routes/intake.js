// Intake routes (v91) — the customer submission surfaces, the guest
// status lookup, the /v1/me status views, and the ops Intake Desk API.
//
// ChatGPT verdict of record: REVIEW-VERDICT-V91-2026-11-26.
//  - Applications: POST /v1/applications/{artists,collectors,collaborations}
//    (collectors also accept guests — verdict §B; the reference + email
//    pair is the guest's retrieval credential, never a write key).
//  - Commissions: POST /v1/commission-briefs and
//    POST /v1/commission-briefs/:id/proposals DELEGATE to the canonical
//    brief/pitch inserts in routes/briefs.js — one authoritative path,
//    no second commission system (verdict §D1).
//  - Desk: /v1/admin/intake/* under the existing admin authority
//    (requireAuth + requireRole('admin'), reason-gated actions, every
//    act on the append-only event trail). An intake status change can
//    NEVER grant a role, a membership, or a seller record (§D3) —
//    this module writes only intake_submissions + intake_events.
import { createHash, timingSafeEqual } from 'node:crypto';
import { requireAuth, requireRole } from '../auth.js';
import { optionalAuth } from './listings.js';
import { requireReason } from './admin.js';
import {
  createIntake,
  transitionIntake,
  appendIntakeEvent,
  validatePayload,
  normalizeEmail,
  validEmail,
  submissionView,
  deskSubmissionView,
  intakeEventView,
  intakeError,
} from '../lib/intake.js';
import {
  briefView,
  pitchView,
  parseBriefFields,
  insertBriefWithIntake,
  insertPitchWithIntake,
} from './briefs.js';

function badRequest(reply, message) {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}
function notFound(reply, what = 'Submission') {
  return reply.code(404).send({ error: { code: 'not_found', message: `${what} not found` } });
}
function sendErr(reply, err) {
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  return reply.code(status).send({
    error: {
      code: status === 500 ? 'internal_error' : err.code || 'request_error',
      message: status === 500 ? 'Internal error' : err.message,
    },
  });
}

// Rate limiting (verdict §B + §D): in-process sliding windows, the
// house pattern from support.js — the API runs as a single instance.
// Submissions: a generous human ceiling per source. Guest lookups:
// tight, per source AND per reference, because the lookup pair is a
// credential and must not be grindable.
const SUBMIT_WINDOW_MS = 10 * 60 * 1000;
const SUBMIT_MAX = 30;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const LOOKUP_MAX_PER_SOURCE = 30;
const LOOKUP_MAX_PER_REFERENCE = 10;
const windows = new Map();
function hitLimit(bucket, key, max, windowMs) {
  const now = Date.now();
  const k = `${bucket}:${key}`;
  const kept = (windows.get(k) || []).filter((t) => now - t < windowMs);
  if (kept.length >= max) {
    windows.set(k, kept);
    return Math.ceil((kept[0] + windowMs - now) / 1000);
  }
  kept.push(now);
  windows.set(k, kept);
  return 0;
}
function sourceOf(req) {
  return req.ip || 'unknown';
}

function idempotencyKeyOf(req) {
  const fromHeader = req.headers['idempotency-key'];
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim().slice(0, 200);
  const fromBody = req.body?.idempotencyKey;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim().slice(0, 200);
  return null;
}

/** Shared application-submission flow for the three doors. */
async function submitApplication(pool, req, reply, { type, authRequired }) {
  const retry = hitLimit('submit', sourceOf(req), SUBMIT_MAX, SUBMIT_WINDOW_MS);
  if (retry) {
    return reply.code(429).send({
      error: { code: 'rate_limited', message: `Too many submissions — try again in ${retry} seconds` },
    });
  }
  const body = req.body || {};
  const key = idempotencyKeyOf(req);
  if (!key) return badRequest(reply, 'An idempotencyKey is required for submissions');
  let payload;
  try {
    payload = validatePayload(type, body.payload ?? body);
  } catch (err) {
    return sendErr(reply, err);
  }
  const account = authRequired ? req.account : req.account || null;
  let contactEmail = account?.email ? normalizeEmail(account.email) : '';
  if (account && !contactEmail) {
    // Soft-auth account objects carry no email claim — read the
    // canonical address from the account row instead of failing.
    const { rows } = await pool.query('SELECT email FROM accounts WHERE id = $1', [account.id]);
    contactEmail = normalizeEmail(rows[0]?.email || '');
  }
  if (!contactEmail) {
    contactEmail = normalizeEmail(body.email || payload.email || '');
  }
  if (!validEmail(contactEmail)) {
    return badRequest(reply, 'A valid contact email is required');
  }
  const scope = account ? `acct:${account.id}` : `guest:${contactEmail}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { submission, duplicate } = await createIntake(client, {
      type,
      ownerAccountId: account ? account.id : null,
      contactEmail,
      payload,
      consentAt: new Date().toISOString(),
      source: typeof body.source === 'string' ? body.source.slice(0, 40) : 'site',
      idempotencyScope: scope,
      idempotencyKey: key,
    });
    await client.query('COMMIT');
    return reply.code(duplicate ? 200 : 201).send({ submission: submissionView(submission) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendErr(reply, err);
  } finally {
    client.release();
  }
}

export function registerIntakeRoutes(app, pool) {
  const auth = requireAuth(pool);
  const softAuth = optionalAuth(pool);
  const gate = [auth, requireRole('admin')];

  // --- The three doors -------------------------------------------------
  app.post('/v1/applications/artists', { preHandler: auth }, async (req, reply) =>
    submitApplication(pool, req, reply, { type: 'artist', authRequired: true }),
  );
  // Collectors: account OR guest (verdict §B). optionalAuth resolves
  // the account when a token rides along; a guest's scope is their
  // normalized email, so guest idempotency holds too (verdict A4).
  app.post('/v1/applications/collectors', { preHandler: softAuth }, async (req, reply) =>
    submitApplication(pool, req, reply, { type: 'collector', authRequired: false }),
  );
  app.post('/v1/applications/collaborations', { preHandler: auth }, async (req, reply) =>
    submitApplication(pool, req, reply, { type: 'collaboration', authRequired: true }),
  );

  // --- Commission wrappers (delegate to the canonical inserts) --------
  app.post('/v1/commission-briefs', { preHandler: auth }, async (req, reply) => {
    const body = req.body || {};
    const { fields, error } = parseBriefFields(body);
    if (error) return badRequest(reply, error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { brief, submission, duplicate } = await insertBriefWithIntake(client, {
        buyer: req.account,
        fields,
        idempotencyKey: idempotencyKeyOf(req),
      });
      await client.query('COMMIT');
      return reply
        .code(duplicate ? 200 : 201)
        .send({ brief: briefView(brief, 0), submission: submissionView(submission) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return sendErr(reply, err);
    } finally {
      client.release();
    }
  });

  app.post('/v1/commission-briefs/:id/proposals', { preHandler: auth }, async (req, reply) => {
    const { rows: briefs } = await pool.query('SELECT * FROM briefs WHERE id = $1', [req.params.id]);
    const brief = briefs[0];
    if (!brief || brief.status !== 'open') return notFound(reply, 'Brief');
    if (brief.buyer_account_id === req.account.id) {
      return reply.code(422).send({
        error: { code: 'own_brief', message: 'You cannot pitch your own brief' },
      });
    }
    const body = req.body || {};
    if (!Number.isInteger(body.priceCents) || body.priceCents <= 0) {
      return badRequest(reply, 'priceCents must be a positive integer (cents)');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { pitch, submission, duplicate } = await insertPitchWithIntake(client, {
        brief,
        artist: req.account,
        priceCents: body.priceCents,
        message: typeof body.message === 'string' ? body.message.slice(0, 4000) : null,
        idempotencyKey: idempotencyKeyOf(req),
      });
      await client.query('COMMIT');
      return reply
        .code(duplicate ? 200 : 201)
        .send({ pitch: pitchView(pitch), submission: submissionView(submission) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        return reply.code(409).send({
          error: { code: 'pitch_exists', message: 'You already pitched this brief' },
        });
      }
      return sendErr(reply, err);
    } finally {
      client.release();
    }
  });

  // --- Customer status views -------------------------------------------
  // My applications: artist/collector/collaboration submissions PLUS
  // founding applications (canonical rows surface through their intake
  // records — backfilled for pre-v91 rows by migration 0009, written
  // through for new ones — verdict A5: /v1/me/applications includes
  // pre-existing founding applications), newest first.
  app.get('/v1/me/applications', { preHandler: auth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT s.*, f.status AS founding_status
         FROM intake_submissions s
         LEFT JOIN founding_applications f
           ON s.canonical_table = 'founding_applications' AND f.id = s.canonical_id
        WHERE s.owner_account_id = $1
          AND s.type IN ('artist', 'collector', 'collaboration', 'founding')
        ORDER BY s.created_at DESC LIMIT 100`,
      [req.account.id],
    );
    return {
      applications: rows.map((r) => {
        const view = submissionView(r);
        if (r.type === 'founding') view.canonicalStatus = r.founding_status || null;
        return view;
      }),
    };
  });

  // My commission briefs: my intake-held briefs with their unified
  // status, PLUS legacy briefs (pre-intake canonical rows, reference
  // null, canonical status mapped for display).
  app.get('/v1/me/commission-briefs', { preHandler: auth }, async (req) => {
    const { rows: mine } = await pool.query(
      `SELECT s.*, b.title AS brief_title, b.status AS brief_status
         FROM intake_submissions s
         JOIN briefs b ON b.id = s.canonical_id
        WHERE s.owner_account_id = $1 AND s.type = 'brief'
        ORDER BY s.created_at DESC LIMIT 100`,
      [req.account.id],
    );
    const { rows: legacy } = await pool.query(
      `SELECT b.* FROM briefs b
        WHERE b.buyer_account_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM intake_submissions s
             WHERE s.canonical_table = 'briefs' AND s.canonical_id = b.id)
        ORDER BY b.created_at DESC LIMIT 100`,
      [req.account.id],
    );
    const briefs = mine.map((r) => ({
      ...submissionView(r),
      title: r.brief_title,
      briefStatus: r.brief_status,
    }));
    for (const b of legacy) {
      briefs.push({
        reference: null,
        type: 'brief',
        status: b.status === 'awarded' ? 'ACCEPTED' : b.status === 'canceled' ? 'CLOSED' : 'VISIBLE',
        statusLabel:
          b.status === 'awarded'
            ? 'Proposal accepted'
            : b.status === 'canceled'
              ? 'Closed'
              : 'Published on the Commission Board',
        receivedAt: b.created_at,
        updatedAt: b.updated_at,
        actionNote: null,
        payload: { title: b.title, budgetCents: b.budget_cents, category: b.category },
        canonicalId: b.id,
        legacy: true,
        title: b.title,
        briefStatus: b.status,
      });
    }
    briefs.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    return { briefs };
  });

  // --- Guest status lookup (verdict §B) ---------------------------------
  // Reference + email is a limited retrieval credential: read-only,
  // rate-limited per source and per reference, constant-shape failure
  // (the SAME 404 for a nonexistent reference and a wrong email — no
  // enumeration, and nothing reveals whether an email has submitted).
  app.post('/v1/intake/lookup', async (req, reply) => {
    const body = req.body || {};
    const reference = typeof body.reference === 'string' ? body.reference.trim().toUpperCase() : '';
    const email = normalizeEmail(body.email || '');
    const generic = () =>
      reply.code(404).send({
        error: {
          code: 'not_found',
          message: 'No submission matches that reference and email. Check both and try again.',
        },
      });
    if (!reference || !validEmail(email)) return generic();
    if (hitLimit('lookup-src', sourceOf(req), LOOKUP_MAX_PER_SOURCE, LOOKUP_WINDOW_MS)) {
      return reply.code(429).send({
        error: { code: 'rate_limited', message: 'Too many lookups — try again in a few minutes' },
      });
    }
    if (hitLimit('lookup-ref', reference, LOOKUP_MAX_PER_REFERENCE, LOOKUP_WINDOW_MS)) {
      return reply.code(429).send({
        error: { code: 'rate_limited', message: 'Too many lookups for that reference — try again in a few minutes' },
      });
    }
    const { rows } = await pool.query('SELECT * FROM intake_submissions WHERE reference = $1', [
      reference,
    ]);
    const row = rows[0];
    if (!row || !row.contact_email) return generic();
    const a = createHash('sha256').update(normalizeEmail(row.contact_email)).digest();
    const b = createHash('sha256').update(email).digest();
    if (!timingSafeEqual(a, b)) return generic();
    // Read-only proof: reference, type, status, timestamps, the action
    // ask when one is outstanding — never the payload, never the owner.
    return {
      submission: {
        reference: row.reference,
        type: row.type,
        status: row.status,
        statusLabel: submissionView(row).statusLabel,
        receivedAt: row.created_at,
        updatedAt: row.updated_at,
        actionNote: row.status === 'ACTION_REQUIRED' ? row.action_note : null,
      },
    };
  });

  // --- The Intake Desk (ops) ---------------------------------------------
  // GET /v1/admin/intake/queue?type=&status=&q= — per-type queues,
  // reference search, contact/account search. Counts come from the
  // rows themselves; nothing here is manufactured.
  app.get('/v1/admin/intake/queue', { preHandler: gate }, async (req) => {
    const type = typeof req.query?.type === 'string' ? req.query.type : null;
    const status = typeof req.query?.status === 'string' ? req.query.status : null;
    const q = typeof req.query?.q === 'string' ? req.query.q.trim() : null;
    const limit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 200);
    const clauses = [];
    const params = [];
    if (type) { params.push(type); clauses.push(`type = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      clauses.push(
        `(reference ILIKE $${params.length} OR contact_email ILIKE $${params.length} OR owner_account_id::text = $${params.length + 1})`,
      );
      params.push(q);
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM intake_submissions
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    const { rows: counts } = await pool.query(
      `SELECT type, count(*)::int AS n FROM intake_submissions GROUP BY type`,
    );
    return {
      submissions: rows.map(deskSubmissionView),
      counts: Object.fromEntries(counts.map((c) => [c.type, c.n])),
    };
  });

  // GET /v1/admin/intake/:id — one submission + its full event trail +
  // linked records (a brief's proposals, a proposal's brief).
  app.get('/v1/admin/intake/:id', { preHandler: gate }, async (req, reply) => {
    const { rows } = await pool.query('SELECT * FROM intake_submissions WHERE id = $1', [
      req.params.id,
    ]);
    if (!rows.length) return notFound(reply);
    const sub = rows[0];
    const { rows: events } = await pool.query(
      'SELECT * FROM intake_events WHERE submission_id = $1 ORDER BY created_at ASC',
      [sub.id],
    );
    const linked = { brief: null, proposals: [] };
    if (sub.type === 'brief') {
      const { rows: props } = await pool.query(
        'SELECT * FROM intake_submissions WHERE linked_submission_id = $1 ORDER BY created_at ASC',
        [sub.id],
      );
      linked.proposals = props.map(deskSubmissionView);
    }
    if (sub.type === 'proposal' && sub.linked_submission_id) {
      const { rows: briefRows } = await pool.query(
        'SELECT * FROM intake_submissions WHERE id = $1',
        [sub.linked_submission_id],
      );
      linked.brief = briefRows[0] ? deskSubmissionView(briefRows[0]) : null;
    }
    return {
      submission: deskSubmissionView(sub),
      events: events.map(intakeEventView),
      linked,
    };
  });

  async function deskAct(req, reply, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return sendErr(reply, err);
    } finally {
      client.release();
    }
  }

  // POST /v1/admin/intake/:id/transition — a status move on the type's
  // machine (illegal → 409), reason-gated, event-written. Moving a
  // brief to VISIBLE is the publication act. This endpoint can never
  // touch roles, memberships, or seller records.
  app.post('/v1/admin/intake/:id/transition', { preHandler: gate }, async (req, reply) => {
    const reason = requireReason(req, reply);
    if (reason === null) return;
    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    if (!to) return badRequest(reply, 'Body requires to (the target status)');
    return deskAct(req, reply, async (client) => {
      const { submission } = await transitionIntake(client, {
        id: req.params.id,
        to,
        actorType: 'ops',
        actorAccountId: req.account.id,
        note: reason,
      });
      return { submission: deskSubmissionView(submission) };
    });
  });

  // POST /v1/admin/intake/:id/request-info — ACTION REQUIRED with the
  // exact action the customer must take (never a bare status).
  app.post('/v1/admin/intake/:id/request-info', { preHandler: gate }, async (req, reply) => {
    const reason = requireReason(req, reply);
    if (reason === null) return;
    const action = typeof req.body?.action === 'string' ? req.body.action.trim() : '';
    if (!action) {
      return badRequest(reply, 'Body requires action — what the customer must do');
    }
    return deskAct(req, reply, async (client) => {
      const { submission } = await transitionIntake(client, {
        id: req.params.id,
        to: 'ACTION_REQUIRED',
        actorType: 'ops',
        actorAccountId: req.account.id,
        kind: 'request_info',
        note: reason,
        actionNote: action.slice(0, 1000),
      });
      return { submission: deskSubmissionView(submission) };
    });
  });

  // POST /v1/admin/intake/:id/assign — reviewer assignment (audited).
  app.post('/v1/admin/intake/:id/assign', { preHandler: gate }, async (req, reply) => {
    const reason = requireReason(req, reply);
    if (reason === null) return;
    const assignee = typeof req.body?.assigneeAccountId === 'string' ? req.body.assigneeAccountId : null;
    return deskAct(req, reply, async (client) => {
      const { rows } = await client.query(
        'UPDATE intake_submissions SET assigned_to = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [req.params.id, assignee],
      );
      if (!rows.length) throw intakeError(404, 'not_found', 'Submission not found');
      await appendIntakeEvent(client, {
        id: req.params.id,
        actorType: 'ops',
        actorAccountId: req.account.id,
        kind: 'assign',
        note: `${reason} (assigned to ${assignee || 'nobody'})`,
      });
      return { submission: deskSubmissionView(rows[0]) };
    });
  });

  // POST /v1/admin/intake/:id/note — an ops note on the trail.
  app.post('/v1/admin/intake/:id/note', { preHandler: gate }, async (req, reply) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!note) return badRequest(reply, 'Body requires note');
    return deskAct(req, reply, async (client) => {
      await appendIntakeEvent(client, {
        id: req.params.id,
        actorType: 'ops',
        actorAccountId: req.account.id,
        kind: 'note',
        note: note.slice(0, 2000),
      });
      const { rows } = await client.query('SELECT * FROM intake_submissions WHERE id = $1', [
        req.params.id,
      ]);
      return { submission: deskSubmissionView(rows[0]) };
    });
  });

  // POST /v1/admin/intake/:id/close — close with a recorded reason.
  app.post('/v1/admin/intake/:id/close', { preHandler: gate }, async (req, reply) => {
    const reason = requireReason(req, reply);
    if (reason === null) return;
    return deskAct(req, reply, async (client) => {
      const { rows: cur } = await client.query('SELECT type FROM intake_submissions WHERE id = $1', [
        req.params.id,
      ]);
      if (!cur.length) throw intakeError(404, 'not_found', 'Submission not found');
      if (cur[0].type === 'proposal') {
        throw intakeError(
          409,
          'invalid_transition',
          'Proposals close through their own lifecycle (accepted / not selected / withdrawn), not the desk close',
        );
      }
      const { submission } = await transitionIntake(client, {
        id: req.params.id,
        to: 'CLOSED',
        actorType: 'ops',
        actorAccountId: req.account.id,
        kind: 'close',
        note: reason,
        closeReason: reason,
      });
      return { submission: deskSubmissionView(submission) };
    });
  });

  // GET /v1/admin/intake/export.csv — privacy-restricted export:
  // references, types, statuses, contact + timestamps. Payload content
  // is deliberately NOT exported (it stays behind the per-record read).
  app.get('/v1/admin/intake/export.csv', { preHandler: gate }, async (req, reply) => {
    const type = typeof req.query?.type === 'string' ? req.query.type : null;
    const { rows } = type
      ? await pool.query(
          'SELECT reference, type, status, contact_email, source, created_at, updated_at FROM intake_submissions WHERE type = $1 ORDER BY created_at ASC LIMIT 5000',
          [type],
        )
      : await pool.query(
          'SELECT reference, type, status, contact_email, source, created_at, updated_at FROM intake_submissions ORDER BY created_at ASC LIMIT 5000',
        );
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['reference,type,status,contact_email,source,received_at,updated_at'];
    for (const r of rows) {
      lines.push(
        [r.reference, r.type, r.status, r.contact_email, r.source, r.created_at?.toISOString?.() || r.created_at, r.updated_at?.toISOString?.() || r.updated_at]
          .map(esc)
          .join(','),
      );
    }
    return reply
      .header('content-type', 'text/csv')
      .header('content-disposition', 'attachment; filename="paired-intake-export.csv"')
      .send(lines.join('\n'));
  });
}
