// Artist surface: profile, human-made verification, Connect onboarding.
//
// Verification law (M2 consult): verification is a PROCESS record, never an
// infallible-detection claim. An artist submits a shop URL + the proof code
// displayed on that shop (the Instant Membership mechanic); a reviewer
// records a decision with evidence notes. artist_profiles.verified derives
// ONLY from a verified record — it is recomputed from verification_requests
// inside the decision transaction and can never be set by the artist.
import { requireAuth, requireRole } from '../auth.js';
import { getStripe } from '../stripe.js';
import {
  getConnectRow,
  recordConnectIntent,
  issueOnboardingLink,
  refreshConnectStatus,
} from '../lib/connect.js';

const DECISIONS = ['under_review', 'verified', 'rejected'];

async function getProfile(pool, accountId) {
  const { rows } = await pool.query(
    `SELECT account_id, display_name, bio, verified, created_at, updated_at
       FROM artist_profiles WHERE account_id = $1`,
    [accountId],
  );
  return rows[0] || null;
}

function profileView(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    displayName: row.display_name,
    bio: row.bio,
    verified: row.verified,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requestView(row) {
  if (!row) return null;
  return {
    id: row.id,
    shopUrl: row.shop_url,
    state: row.state,
    evidenceNotes: row.evidence_notes,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    updatedAt: row.updated_at,
  };
}

export function registerArtistRoutes(app, pool) {
  const auth = requireAuth(pool);

  // GET /v1/artist/profile — my artist profile (null until first PATCH).
  app.get('/v1/artist/profile', { preHandler: auth }, async (req) => {
    return { profile: profileView(await getProfile(pool, req.account.id)) };
  });

  // PATCH /v1/artist/profile — upsert my display fields. Presenting as an
  // artist is a server-side role grant (Neon owns roles); `verified` is
  // never accepted from the client.
  app.patch('/v1/artist/profile', { preHandler: auth }, async (req, reply) => {
    const body = req.body || {};
    const displayName =
      typeof body.displayName === 'string' ? body.displayName.slice(0, 120) : undefined;
    const bio = typeof body.bio === 'string' ? body.bio.slice(0, 2000) : undefined;
    if (displayName === undefined && bio === undefined) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'Provide displayName and/or bio' },
      });
    }
    const { rows } = await pool.query(
      `INSERT INTO artist_profiles (account_id, display_name, bio)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE
         SET display_name = COALESCE($2, artist_profiles.display_name),
             bio = COALESCE($3, artist_profiles.bio),
             updated_at = now()
       RETURNING account_id, display_name, bio, verified, created_at, updated_at`,
      [req.account.id, displayName ?? null, bio ?? null],
    );
    await pool.query(
      `INSERT INTO account_roles (account_id, role) VALUES ($1, 'artist')
       ON CONFLICT DO NOTHING`,
      [req.account.id],
    );
    return { profile: profileView(rows[0]) };
  });

  // POST /v1/artist/verification — submit a human-made proof request.
  // One open request per account (also enforced by a partial unique index).
  app.post('/v1/artist/verification', { preHandler: auth }, async (req, reply) => {
    const body = req.body || {};
    const shopUrl = typeof body.shopUrl === 'string' ? body.shopUrl.trim() : '';
    const proofCode = typeof body.proofCode === 'string' ? body.proofCode.trim() : '';
    if (!shopUrl || shopUrl.length > 500 || !proofCode || proofCode.length > 64) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'Body requires shopUrl (≤500 chars) and proofCode (≤64 chars)' },
      });
    }
    const { rows: open } = await pool.query(
      `SELECT id FROM verification_requests
        WHERE account_id = $1 AND state IN ('submitted', 'under_review') LIMIT 1`,
      [req.account.id],
    );
    if (open.length) {
      return reply.code(409).send({
        error: { code: 'verification_open', message: 'A verification request is already open for this account' },
      });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO verification_requests (account_id, shop_url, proof_code)
         VALUES ($1, $2, $3)
         RETURNING id, shop_url, state, evidence_notes, submitted_at, decided_at, updated_at`,
        [req.account.id, shopUrl, proofCode],
      );
      return reply.code(201).send({ verification: requestView(rows[0]) });
    } catch (err) {
      if (err.code === '23505') {
        return reply.code(409).send({
          error: { code: 'verification_open', message: 'A verification request is already open for this account' },
        });
      }
      throw err;
    }
  });

  // GET /v1/artist/verification — my latest request + the derived flag.
  app.get('/v1/artist/verification', { preHandler: auth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, shop_url, state, evidence_notes, submitted_at, decided_at, updated_at
         FROM verification_requests WHERE account_id = $1
        ORDER BY submitted_at DESC LIMIT 1`,
      [req.account.id],
    );
    const profile = await getProfile(pool, req.account.id);
    return { verification: requestView(rows[0] || null), verified: profile?.verified ?? false };
  });

  // POST /v1/admin/verifications/decide — reviewer decision (admin only).
  // Body: { verificationId, decision: 'under_review'|'verified'|'rejected', evidenceNotes? }
  // The verified flag is recomputed from the request records inside the
  // same transaction, and the decision writes an audit_log row (M0).
  app.post(
    '/v1/admin/verifications/decide',
    { preHandler: [auth, requireRole('admin')] },
    async (req, reply) => {
      const { verificationId, decision, evidenceNotes } = req.body || {};
      if (!verificationId || !DECISIONS.includes(decision)) {
        return reply.code(400).send({
          error: {
            code: 'bad_request',
            message: "Body requires verificationId and decision ('under_review'|'verified'|'rejected')",
          },
        });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          'SELECT id, account_id, state FROM verification_requests WHERE id = $1 FOR UPDATE',
          [verificationId],
        );
        if (!rows.length) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: { code: 'not_found', message: 'Verification request not found' } });
        }
        const request = rows[0];
        if (request.state === 'verified' || request.state === 'rejected') {
          await client.query('ROLLBACK');
          return reply.code(409).send({
            error: { code: 'already_decided', message: `Verification request is already ${request.state}` },
          });
        }
        if (decision === 'under_review' && request.state !== 'submitted') {
          await client.query('ROLLBACK');
          return reply.code(409).send({
            error: { code: 'already_decided', message: `Verification request is already ${request.state}` },
          });
        }
        const terminal = decision === 'verified' || decision === 'rejected';
        const { rows: updated } = await client.query(
          `UPDATE verification_requests
              SET state = $1,
                  reviewer_account_id = $2,
                  evidence_notes = COALESCE($3, evidence_notes),
                  decided_at = CASE WHEN $4 THEN now() ELSE decided_at END,
                  updated_at = now()
            WHERE id = $5
            RETURNING id, shop_url, state, evidence_notes, submitted_at, decided_at, updated_at`,
          [
            decision,
            req.account.id,
            typeof evidenceNotes === 'string' ? evidenceNotes.slice(0, 2000) : null,
            terminal,
            verificationId,
          ],
        );
        // The flag derives ONLY from verified records — recompute it from
        // the source table so no transition order can ever corrupt it.
        const { rows: flagRows } = await client.query(
          `SELECT EXISTS(
             SELECT 1 FROM verification_requests
              WHERE account_id = $1 AND state = 'verified'
           ) AS verified`,
          [request.account_id],
        );
        const verified = flagRows[0].verified;
        await client.query(
          `INSERT INTO artist_profiles (account_id, verified) VALUES ($1, $2)
           ON CONFLICT (account_id) DO UPDATE SET verified = EXCLUDED.verified, updated_at = now()`,
          [request.account_id, verified],
        );
        await client.query(
          `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
           VALUES ($1, 'verification.decide', $2, $3, $4)`,
          [
            req.account.id,
            `verification_request:${verificationId}`,
            typeof evidenceNotes === 'string' ? evidenceNotes.slice(0, 1000) : null,
            JSON.stringify({ decision, artistAccountId: request.account_id, verified }),
          ],
        );
        await client.query('COMMIT');
        return { verification: requestView(updated[0]), verified };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // POST /v1/artist/connect/onboarding-link — hosted payout onboarding.
  // Without Stripe configured: intent is recorded and the leg fails closed.
  app.post('/v1/artist/connect/onboarding-link', { preHandler: auth }, async (req, reply) => {
    const stripe = getStripe();
    if (!stripe) {
      await recordConnectIntent(pool, req.account.id);
      return reply.code(503).send({
        error: { code: 'not_configured', message: 'Payout onboarding is not configured yet' },
      });
    }
    const { row, url } = await issueOnboardingLink(pool, stripe, req.account);
    return {
      connect: { state: row.state, stripeAccountId: row.stripe_account_id },
      url,
    };
  });

  // GET /v1/artist/connect/status — my payout onboarding state (refreshed
  // from Stripe when configured; the stored state otherwise).
  app.get('/v1/artist/connect/status', { preHandler: auth }, async (req) => {
    const stripe = getStripe();
    const row = stripe
      ? await refreshConnectStatus(pool, stripe, req.account.id)
      : await getConnectRow(pool, req.account.id);
    return { connect: { state: row.state, stripeAccountId: row.stripe_account_id } };
  });
}
