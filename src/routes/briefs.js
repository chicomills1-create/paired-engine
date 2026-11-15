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
    status: row.status,
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

export function registerBriefsRoutes(app, pool) {
  const auth = requireAuth(pool);
  const softAuth = optionalAuth(pool);

  // POST /v1/briefs — post a commission brief. A real budget is required:
  // the board carries real briefs with real budgets, never placeholders.
  app.post('/v1/briefs', { preHandler: auth }, async (req, reply) => {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    if (!title) return badRequest(reply, 'title is required');
    if (!Number.isInteger(body.budgetCents) || body.budgetCents <= 0) {
      return badRequest(reply, 'budgetCents must be a positive integer (cents)');
    }
    const { rows } = await pool.query(
      `INSERT INTO briefs (buyer_account_id, title, description, budget_cents, category)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        req.account.id,
        title,
        typeof body.description === 'string' ? body.description.slice(0, 5000) : null,
        body.budgetCents,
        typeof body.category === 'string' ? body.category.slice(0, 120) : null,
      ],
    );
    return reply.code(201).send({ brief: briefView(rows[0], 0) });
  });

  // GET /v1/briefs — the public board: open briefs, newest first, each
  // with its live pitch count. (Awarded briefs leave the board; their
  // life continues on the order.)
  app.get('/v1/briefs', async (req) => {
    const { rows } = await pool.query(
      `SELECT b.*, (SELECT count(*)::int FROM pitches p WHERE p.brief_id = b.id) AS pitch_count
         FROM briefs b
        WHERE b.status = 'open'
        ORDER BY b.created_at DESC
        LIMIT 100`,
    );
    return { briefs: rows.map((r) => briefView(r, r.pitch_count)) };
  });

  // GET /v1/briefs/:id — public while open; the owner always; an awarded
  // brief stays visible to its participants (owner + awarded artist).
  app.get('/v1/briefs/:id', { preHandler: softAuth }, async (req, reply) => {
    const brief = await getBrief(pool, req.params.id);
    if (!brief) return notFound(reply);
    const me = req.account?.id || null;
    const isOwner = me !== null && brief.buyer_account_id === me;
    let visible = isOwner || brief.status === 'open';
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
  app.post('/v1/briefs/:id/cancel', { preHandler: auth }, async (req, reply) => {
    const brief = await getBrief(pool, req.params.id);
    if (!brief || brief.buyer_account_id !== req.account.id) return notFound(reply);
    if (brief.status !== 'open') {
      return reply.code(409).send({
        error: { code: 'invalid_state', message: `A ${brief.status} brief cannot be canceled` },
      });
    }
    const { rows } = await pool.query(
      `UPDATE briefs SET status = 'canceled', updated_at = now() WHERE id = $1 RETURNING *`,
      [brief.id],
    );
    return { brief: briefView(rows[0], await pitchCount(pool, brief.id)) };
  });

  // POST /v1/briefs/:id/pitches — an artist pitches. One pitch per
  // artist per brief; the brief's owner can never pitch their own brief.
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
    try {
      const { rows } = await pool.query(
        `INSERT INTO pitches (brief_id, artist_account_id, price_cents, message)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [
          brief.id,
          req.account.id,
          body.priceCents,
          typeof body.message === 'string' ? body.message.slice(0, 2000) : null,
        ],
      );
      // Presenting as an artist is a server-side role grant (as listings).
      await pool.query(
        `INSERT INTO account_roles (account_id, role) VALUES ($1, 'artist')
         ON CONFLICT DO NOTHING`,
        [req.account.id],
      );
      return reply.code(201).send({ pitch: pitchView(rows[0]) });
    } catch (err) {
      if (err.code === '23505') {
        return reply.code(409).send({
          error: { code: 'pitch_exists', message: 'You already pitched this brief' },
        });
      }
      throw err;
    }
  });

  // GET /v1/briefs/:id/pitches — the owner sees every pitch; an artist
  // sees only their own; anyone else is refused (counts live on the
  // brief itself).
  app.get('/v1/briefs/:id/pitches', { preHandler: auth }, async (req, reply) => {
    const brief = await getBrief(pool, req.params.id);
    if (!brief) return notFound(reply);
    if (brief.buyer_account_id === req.account.id) {
      const { rows } = await pool.query(
        'SELECT * FROM pitches WHERE brief_id = $1 ORDER BY created_at ASC',
        [brief.id],
      );
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
    const { rows: updated } = await pool.query(
      `UPDATE pitches SET status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    return { pitch: pitchView(updated[0]) };
  });

  // POST /v1/pitches/:id/withdraw — the pitching artist withdraws.
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
    const { rows: updated } = await pool.query(
      `UPDATE pitches SET status = 'withdrawn', updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    return { pitch: pitchView(updated[0]) };
  });
}
