// Briefs + pitches — the commission board (M4).
//
// A buyer posts a brief with a real budget; artists pitch with a real
// price; the buyer accepts one pitch and the commission order is created
// through the M3 checkout machinery (src/lib/commissions.js). Ownership
// law as everywhere: actors resolve from the token, never the body.
// Pitch contents are NOT public: the brief's owner sees every pitch on
// their brief, an artist sees their own, everyone else sees counts only.
import { requireAuth } from '../auth.js';
import { getStripe } from '../stripe.js';
import { createCommissionCheckout } from '../lib/commissions.js';
import {
  attachIntake,
  intakeForCanonical,
  transitionIntake,
  shareProposalWithBuyer,
  submissionView,
  payloadHash,
  BRIEF_PUBLIC_STATES,
} from '../lib/intake.js';
import { orderView } from './orders.js';
import { optionalAuth } from './listings.js';

function badRequest(reply, message) {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}

function notFound(reply, what = 'Brief') {
  return reply.code(404).send({ error: { code: 'not_found', message: `${what} not found` } });
}

function sendErr(reply, err) {
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  const body = {
    error: {
      code: status === 500 ? 'internal_error' : err.code || 'request_error',
      message: status === 500 ? 'Internal error' : err.message,
    },
  };
  if (Array.isArray(err.failed)) body.error.failed = err.failed;
  return reply.code(status).send(body);
}

export function briefView(row, pitchCount = null) {
  return {
    id: row.id,
    buyerAccountId: row.buyer_account_id,
    title: row.title,
    description: row.description,
    budgetCents: row.budget_cents,
    category: row.category,
    deliverableType: row.deliverable_type ?? null,
    status: row.status,
    closedAt: row.closed_at ?? null,
    closedBy: row.closed_by ?? null,
    awardedPitchId: row.awarded_pitch_id,
    pitchCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function pitchView(row) {
  return {
    id: row.id,
    briefId: row.brief_id,
    artistAccountId: row.artist_account_id,
    priceCents: row.price_cents,
    message: row.message,
    status: row.status,
    orderId: row.order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getBrief(pool, id) {
  const { rows } = await pool.query('SELECT * FROM briefs WHERE id = $1', [id]);
  return rows[0] || null;
}

async function pitchCount(pool, briefId) {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM pitches WHERE brief_id = $1',
    [briefId],
  );
  return rows[0].n;
}

/**
 * The ONE canonical brief insert (v91): used by POST /v1/briefs and by
 * the intake wrapper POST /v1/commission-briefs, always on a
 * transaction client, always followed by the intake attach inside the
 * same transaction — a brief can never exist without its intake
 * record, nor an intake record without its brief (verdict A1).
 * Idempotency: when the caller supplies a key, a duplicate returns the
 * ORIGINAL brief + submission and writes nothing new.
 */
export async function insertBriefWithIntake(client, { buyer, fields, idempotencyKey = null }) {
  const payload = {
    title: fields.title,
    description: fields.description ?? undefined,
    budgetCents: fields.budgetCents,
    category: fields.category ?? undefined,
    deliverableType: fields.deliverableType ?? undefined,
    size: fields.size ?? undefined,
    timeline: fields.timeline ?? undefined,
    deadline: fields.deadline ?? undefined,
    briefType: fields.briefType ?? undefined,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const scope = `acct:${buyer.id}`;
  const preKey = idempotencyKey || null;
  let brief;
  let submission;
  let duplicate = false;
  if (preKey) {
    // Peek first: a duplicate must not create a second canonical brief.
    const { rows: prior } = await client.query(
      'SELECT * FROM intake_submissions WHERE idempotency_scope = $1 AND idempotency_key = $2',
      [scope, preKey],
    );
    if (prior.length) {
      if (prior[0].payload_hash !== payloadHash(payload)) {
        const err = new Error('This idempotency key was already used with a different submission');
        err.statusCode = 409;
        err.code = 'idempotency_conflict';
        throw err;
      }
      const { rows: b } = await client.query('SELECT * FROM briefs WHERE id = $1', [
        prior[0].canonical_id,
      ]);
      return { brief: b[0], submission: prior[0], duplicate: true };
    }
  }
  const { rows } = await client.query(
    `INSERT INTO briefs (buyer_account_id, title, description, budget_cents, category, deliverable_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      buyer.id,
      fields.title,
      fields.description ?? null,
      fields.budgetCents,
      fields.category ?? null,
      fields.deliverableType ?? null,
    ],
  );
  brief = rows[0];
  ({ submission, duplicate } = await attachIntake(client, {
    type: 'brief',
    ownerAccountId: buyer.id,
    contactEmail: buyer.email || null,
    payload,
    consentAt: new Date().toISOString(),
    idempotencyScope: scope,
    idempotencyKey: preKey || `brief:${brief.id}`,
    canonicalTable: 'briefs',
    canonicalId: brief.id,
  }));
  return { brief, submission, duplicate };
}

/**
 * The ONE canonical pitch insert (v91): used by POST
 * /v1/briefs/:id/pitches and by the intake wrapper POST
 * /v1/commission-briefs/:id/proposals, on a transaction client, with
 * the proposal's intake record attached in the same transaction,
 * linked to the brief's intake record when one exists.
 */
export async function insertPitchWithIntake(client, { brief, artist, priceCents, message, idempotencyKey = null }) {
  const payload = { priceCents, message: message ?? undefined };
  if (payload.message === undefined) delete payload.message;
  const scope = `acct:${artist.id}`;
  if (idempotencyKey) {
    const { rows: prior } = await client.query(
      'SELECT * FROM intake_submissions WHERE idempotency_scope = $1 AND idempotency_key = $2',
      [scope, idempotencyKey],
    );
    if (prior.length) {
      if (prior[0].payload_hash !== payloadHash(payload)) {
        const err = new Error('This idempotency key was already used with a different submission');
        err.statusCode = 409;
        err.code = 'idempotency_conflict';
        throw err;
      }
      const { rows: p } = await client.query('SELECT * FROM pitches WHERE id = $1', [
        prior[0].canonical_id,
      ]);
      return { pitch: p[0], submission: prior[0], duplicate: true };
    }
  }
  const { rows } = await client.query(
    `INSERT INTO pitches (brief_id, artist_account_id, price_cents, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [brief.id, artist.id, priceCents, message ?? null],
  );
  const pitch = rows[0];
  // Presenting as an artist is a server-side role grant (as listings).
  await client.query(
    `INSERT INTO account_roles (account_id, role) VALUES ($1, 'artist')
     ON CONFLICT DO NOTHING`,
    [artist.id],
  );
  const briefIntake = await intakeForCanonical(client, 'briefs', brief.id);
  const { submission } = await attachIntake(client, {
    type: 'proposal',
    ownerAccountId: artist.id,
    contactEmail: artist.email || null,
    payload,
    consentAt: new Date().toISOString(),
    idempotencyScope: scope,
    idempotencyKey: idempotencyKey || `pitch:${pitch.id}`,
    canonicalTable: 'pitches',
    canonicalId: pitch.id,
    linkedSubmissionId: briefIntake ? briefIntake.id : null,
  });
  return { pitch, submission, duplicate: false };
}

/** Shared brief-field validation for both POST surfaces. */
export function parseBriefFields(body) {
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
  if (!title) return { error: 'title is required' };
  if (!Number.isInteger(body.budgetCents) || body.budgetCents <= 0) {
    return { error: 'budgetCents must be a positive integer (cents)' };
  }
  let deliverableType = null;
  if (body.deliverableType !== undefined && body.deliverableType !== null) {
    if (!['physical', 'digital', 'service'].includes(body.deliverableType)) {
      return { error: "deliverableType must be 'physical', 'digital' or 'service'" };
    }
    deliverableType = body.deliverableType;
  }
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  return {
    fields: {
      title,
      description: str(body.description, 5000),
      budgetCents: body.budgetCents,
      category: str(body.category, 120),
      deliverableType,
      size: str(body.size, 120),
      timeline: str(body.timeline, 120),
      deadline: str(body.deadline, 40),
      briefType: str(body.briefType, 20),
    },
  };
}

export function registerBriefsRoutes(app, pool) {
  const auth = requireAuth(pool);
  const softAuth = optionalAuth(pool);

  // POST /v1/briefs — post a commission brief. A real budget is required:
  // the board carries real briefs with real budgets, never placeholders.
  // deliverableType declares what the artist will deliver — 'physical'
  // (shipped artwork), 'digital' (finished artwork delivered
  // electronically), 'service' (the deliverable is the artist's service).
  // It is the commission's tax classification input (migration 0007,
  // §3): optional to post, but a brief without it cannot be awarded —
  // pitch-accept fails closed until the deliverable is declared.
  // v91: the write runs in ONE transaction with its intake record
  // (verdict A1) and the response carries the unified submission
  // receipt. A brief starts RECEIVED — it reaches the public board
  // only when ops publishes it (intake VISIBLE), never at post time.
  app.post('/v1/briefs', { preHandler: auth }, async (req, reply) => {
    const body = req.body || {};
    const { fields, error } = parseBriefFields(body);
    if (error) return badRequest(reply, error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { brief, submission, duplicate } = await insertBriefWithIntake(client, {
        buyer: req.account,
        fields,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
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

  // GET /v1/briefs — the public board: open briefs, newest first, each
  // with its live pitch count. (Awarded briefs leave the board; their
  // life continues on the order.) v91 publication law: a brief WITH an
  // intake record is public only in a publication-approved intake
  // state (VISIBLE or beyond); a brief with NO intake record predates
  // the intake layer and is grandfathered to its canonical status
  // (migration 0009 legacy policy).
  app.get('/v1/briefs', async (req) => {
    const { rows } = await pool.query(
      `SELECT b.*, (SELECT count(*)::int FROM pitches p WHERE p.brief_id = b.id) AS pitch_count
         FROM briefs b
         LEFT JOIN intake_submissions i
           ON i.canonical_table = 'briefs' AND i.canonical_id = b.id
        WHERE b.status = 'open'
          AND (i.id IS NULL OR i.status = ANY($1))
        ORDER BY b.created_at DESC
        LIMIT 100`,
      [BRIEF_PUBLIC_STATES],
    );
    return { briefs: rows.map((r) => briefView(r, r.pitch_count)) };
  });

  // GET /v1/briefs/:id — public while open AND publication-approved
  // (v91: an intake-held brief in RECEIVED is its owner's only; legacy
  // briefs without intake records follow the canonical rule); the
  // owner always; an awarded brief stays visible to its participants
  // (owner + awarded artist).
  app.get('/v1/briefs/:id', { preHandler: softAuth }, async (req, reply) => {
    const brief = await getBrief(pool, req.params.id);
    if (!brief) return notFound(reply);
    const me = req.account?.id || null;
    const isOwner = me !== null && brief.buyer_account_id === me;
    let visible = isOwner;
    if (!visible && brief.status === 'open') {
      const intake = await intakeForCanonical(pool, 'briefs', brief.id);
      visible = !intake || BRIEF_PUBLIC_STATES.includes(intake.status);
    }
    if (!visible && brief.awarded_pitch_id && me) {
      const { rows } = await pool.query('SELECT artist_account_id FROM pitches WHERE id = $1', [
        brief.awarded_pitch_id,
      ]);
      visible = rows[0]?.artist_account_id === me;
    }
    if (!visible) return notFound(reply);
    return { brief: briefView(brief, await pitchCount(pool, brief.id)) };
  });

  // POST /v1/briefs/:id/cancel — the owner withdraws an open brief.
  // Pitches on it stay as history; none of them ever created obligations.
  // v91: the brief's intake record closes in the same transaction.
  app.post('/v1/briefs/:id/cancel', { preHandler: auth }, async (req, reply) => {
    const brief = await getBrief(pool, req.params.id);
    if (!brief || brief.buyer_account_id !== req.account.id) return notFound(reply);
    if (brief.status !== 'open') {
      return reply.code(409).send({
        error: { code: 'invalid_state', message: `A ${brief.status} brief cannot be canceled` },
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE briefs SET status = 'canceled', closed_at = now(), closed_by = 'buyer', updated_at = now() WHERE id = $1 RETURNING *`,
        [brief.id],
      );
      const intake = await intakeForCanonical(client, 'briefs', brief.id);
      if (intake && intake.status !== 'CLOSED') {
        await transitionIntake(client, {
          id: intake.id,
          to: 'CLOSED',
          actorType: 'customer',
          actorAccountId: req.account.id,
          kind: 'close',
          note: 'Brief canceled by its owner.',
          closeReason: 'Canceled by owner',
        });
      }
      await client.query('COMMIT');
      return { brief: briefView(rows[0], await pitchCount(pool, brief.id)) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return sendErr(reply, err);
    } finally {
      client.release();
    }
  });

  // POST /v1/briefs/:id/pitches — an artist pitches. One pitch per
  // artist per brief; the brief's owner can never pitch their own brief.
  // v91: canonical pitch + proposal intake record in ONE transaction.
  app.post('/v1/briefs/:id/pitches', { preHandler: auth }, async (req, reply) => {
    const brief = await getBrief(pool, req.params.id);
    if (!brief || brief.status !== 'open') return notFound(reply);
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
        message: typeof body.message === 'string' ? body.message.slice(0, 2000) : null,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
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

  // GET /v1/briefs/:id/pitches — the owner sees every pitch; an artist
  // sees only their own; anyone else is refused (counts live on the
  // brief itself). v91: the owner's read is the explicit share event —
  // every not-yet-shared proposal on the brief is marked
  // SHARED_WITH_BUYER (verdict §C amendment: a proposal must be shared
  // through a real event before it can be accepted, and a receipt
  // alone never advances the brief).
  app.get('/v1/briefs/:id/pitches', { preHandler: auth }, async (req, reply) => {
    const brief = await getBrief(pool, req.params.id);
    if (!brief) return notFound(reply);
    if (brief.buyer_account_id === req.account.id) {
      const { rows } = await pool.query(
        'SELECT * FROM pitches WHERE brief_id = $1 ORDER BY created_at ASC',
        [brief.id],
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const p of rows) {
          if (p.status !== 'pending') continue;
          const sub = await intakeForCanonical(client, 'pitches', p.id);
          if (sub && sub.status === 'RECEIVED') {
            await shareProposalWithBuyer(client, sub.id, req.account.id);
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        req.log.error({ err }, 'proposal share marking failed');
      } finally {
        client.release();
      }
      return { pitches: rows.map(pitchView) };
    }
    const { rows: mine } = await pool.query(
      'SELECT * FROM pitches WHERE brief_id = $1 AND artist_account_id = $2',
      [brief.id, req.account.id],
    );
    if (!mine.length) {
      return reply.code(403).send({
        error: { code: 'forbidden', message: 'Pitches are visible to the brief owner and the pitching artist' },
      });
    }
    return { pitches: mine.map(pitchView) };
  });

  // POST /v1/pitches/:id/accept — the brief owner awards the brief: the
  // commission order is created through the M3 machinery (fail-closed
  // without Stripe, intent recorded — see src/lib/commissions.js).
  app.post('/v1/pitches/:id/accept', { preHandler: auth }, async (req, reply) => {
    try {
      const { order, checkoutUrl } = await createCommissionCheckout(pool, getStripe(), {
        buyer: req.account,
        pitchId: req.params.id,
      });
      return reply.code(201).send({ order: await orderView(pool, order), checkoutUrl });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  // POST /v1/pitches/:id/reject — the brief owner declines a pitch.
  // v91: the proposal's intake record moves to DECLINED (its customer
  // label: "Not selected") in the same transaction.
  app.post('/v1/pitches/:id/reject', { preHandler: auth }, async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT p.* FROM pitches p JOIN briefs b ON b.id = p.brief_id
        WHERE p.id = $1 AND b.buyer_account_id = $2`,
      [req.params.id, req.account.id],
    );
    if (!rows.length) return notFound(reply, 'Pitch');
    if (rows[0].status !== 'pending') {
      return reply.code(409).send({
        error: { code: 'invalid_state', message: `A ${rows[0].status} pitch cannot be rejected` },
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: updated } = await client.query(
        `UPDATE pitches SET status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`,
        [req.params.id],
      );
      const sub = await intakeForCanonical(client, 'pitches', req.params.id);
      if (sub && ['RECEIVED', 'SHARED_WITH_BUYER'].includes(sub.status)) {
        await transitionIntake(client, {
          id: sub.id,
          to: 'DECLINED',
          actorType: 'customer',
          actorAccountId: req.account.id,
          note: 'Not selected by the brief owner.',
        });
      }
      await client.query('COMMIT');
      return { pitch: pitchView(updated[0]) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return sendErr(reply, err);
    } finally {
      client.release();
    }
  });

  // POST /v1/pitches/:id/withdraw — the pitching artist withdraws.
  // v91: the proposal's intake record moves to WITHDRAWN in the same
  // transaction. A withdrawn proposal can never advance its brief.
  app.post('/v1/pitches/:id/withdraw', { preHandler: auth }, async (req, reply) => {
    const { rows } = await pool.query('SELECT * FROM pitches WHERE id = $1', [req.params.id]);
    if (!rows.length || rows[0].artist_account_id !== req.account.id) {
      return notFound(reply, 'Pitch');
    }
    if (rows[0].status !== 'pending') {
      return reply.code(409).send({
        error: { code: 'invalid_state', message: `A ${rows[0].status} pitch cannot be withdrawn` },
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: updated } = await client.query(
        `UPDATE pitches SET status = 'withdrawn', updated_at = now() WHERE id = $1 RETURNING *`,
        [req.params.id],
      );
      const sub = await intakeForCanonical(client, 'pitches', req.params.id);
      if (sub && ['RECEIVED', 'SHARED_WITH_BUYER'].includes(sub.status)) {
        await transitionIntake(client, {
          id: sub.id,
          to: 'WITHDRAWN',
          actorType: 'customer',
          actorAccountId: req.account.id,
          note: 'Withdrawn by the artist.',
        });
      }
      await client.query('COMMIT');
      return { pitch: pitchView(updated[0]) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return sendErr(reply, err);
    } finally {
      client.release();
    }
  });
}
