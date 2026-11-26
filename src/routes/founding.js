// Founding 100: apply → admin decision → atomic seat claim.
//
// Seat allocation is transactional (M0): seats are physical rows 1..100, an
// approval claims the lowest free seat inside the same transaction that
// records the decision, and every decision writes an audit_log row with the
// actor and reason. Counters can never exceed 100 or double-allocate.
import { requireAuth, requireRole } from '../auth.js';
import { attachIntake, intakeForCanonical, transitionIntake, submissionView } from '../lib/intake.js';

export function registerFoundingRoutes(app, pool) {
  const auth = requireAuth(pool);

  // POST /v1/founding/apply — one live application per account.
  // v91: the canonical insert and its intake record commit in ONE
  // transaction (verdict A1/D2 — this route is NOT replaced; the
  // intake layer adds the unified reference + status visibility), and
  // the response carries the submission receipt.
  app.post('/v1/founding/apply', { preHandler: auth }, async (req, reply) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : null;
    const { rows: existing } = await pool.query(
      `SELECT id, status FROM founding_applications
        WHERE account_id = $1 AND status IN ('pending', 'approved')
        ORDER BY created_at DESC LIMIT 1`,
      [req.account.id],
    );
    if (existing.length) {
      return reply.code(409).send({
        error: {
          code: 'application_exists',
          message: `An application is already ${existing[0].status} for this account`,
        },
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO founding_applications (account_id, note) VALUES ($1, $2)
         RETURNING id, status, created_at`,
        [req.account.id, note],
      );
      const { submission } = await attachIntake(client, {
        type: 'founding',
        ownerAccountId: req.account.id,
        contactEmail: req.account.email || null,
        payload: note ? { note } : {},
        consentAt: new Date().toISOString(),
        idempotencyScope: `acct:${req.account.id}`,
        idempotencyKey: `founding:${rows[0].id}`,
        canonicalTable: 'founding_applications',
        canonicalId: rows[0].id,
      });
      await client.query('COMMIT');
      return reply.code(201).send({
        application: rows[0],
        submission: submissionView(submission),
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  // GET /v1/founding/status — my application state + server-truth seat count.
  app.get('/v1/founding/status', { preHandler: auth }, async (req) => {
    const { rows: apps } = await pool.query(
      `SELECT id, status, created_at, decided_at FROM founding_applications
        WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.account.id],
    );
    const { rows: seatRows } = await pool.query(
      `SELECT seat_no FROM founding_seats WHERE account_id = $1`,
      [req.account.id],
    );
    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS claimed FROM founding_seats WHERE account_id IS NOT NULL`,
    );
    return {
      application: apps[0] || null,
      mySeat: seatRows[0]?.seat_no ?? null,
      seatsClaimed: countRows[0].claimed,
      seatsTotal: 100,
    };
  });

  // POST /v1/admin/founding/decide — admin only.
  // Body: { applicationId, decision: 'approved'|'rejected', reason }
  // The reason is REQUIRED (M5 admin law): every admin action writes an
  // audit_log row with actor + reason + timestamp — no reason, no action.
  app.post(
    '/v1/admin/founding/decide',
    { preHandler: [auth, requireRole('admin')] },
    async (req, reply) => {
      const { applicationId, decision, reason } = req.body || {};
      if (!applicationId || !['approved', 'rejected'].includes(decision)) {
        return reply.code(400).send({
          error: { code: 'bad_request', message: "Body requires applicationId and decision ('approved'|'rejected')" },
        });
      }
      const reasonText = typeof reason === 'string' ? reason.trim() : '';
      if (!reasonText) {
        return reply.code(400).send({
          error: {
            code: 'reason_required',
            message: 'A reason is required for a founding decision (it is written to the audit log)',
          },
        });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: apps } = await client.query(
          `SELECT id, account_id, status FROM founding_applications WHERE id = $1 FOR UPDATE`,
          [applicationId],
        );
        if (!apps.length) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: { code: 'not_found', message: 'Application not found' } });
        }
        const application = apps[0];
        if (application.status !== 'pending') {
          await client.query('ROLLBACK');
          return reply.code(409).send({
            error: { code: 'already_decided', message: `Application is already ${application.status}` },
          });
        }

        let seatNo = null;
        if (decision === 'approved') {
          const { rows: held } = await client.query(
            `SELECT seat_no FROM founding_seats WHERE account_id = $1`,
            [application.account_id],
          );
          if (held.length) {
            seatNo = held[0].seat_no;
          } else {
            // Atomically claim the lowest free seat.
            const { rows: claimed } = await client.query(
              `UPDATE founding_seats
                  SET account_id = $1, claimed_at = now()
                WHERE seat_no = (
                  SELECT seat_no FROM founding_seats
                   WHERE account_id IS NULL ORDER BY seat_no ASC LIMIT 1
                )
                RETURNING seat_no`,
              [application.account_id],
            );
            if (!claimed.length) {
              await client.query('ROLLBACK');
              return reply.code(409).send({
                error: { code: 'seats_exhausted', message: 'All 100 founding seats are claimed' },
              });
            }
            seatNo = claimed[0].seat_no;
          }
          // Tier authority is server-side: an approved founder's membership
          // record carries the founding tier; billing state binds in M6.
          await client.query(
            `INSERT INTO memberships (account_id, tier) VALUES ($1, 'founding')
             ON CONFLICT (account_id) DO UPDATE SET tier = 'founding', updated_at = now()`,
            [application.account_id],
          );
          await client.query(
            `INSERT INTO account_roles (account_id, role) VALUES ($1, 'artist')
             ON CONFLICT DO NOTHING`,
            [application.account_id],
          );
        }
        // A rejection frees nothing: a rejected application never held a seat.

        await client.query(
          `UPDATE founding_applications
              SET status = $1, decided_by = $2, decided_at = now()
            WHERE id = $3`,
          [decision, req.account.id, applicationId],
        );
        // v91 intake mirror, SAME transaction: the founding decision
        // moves the application's unified status with it (the founding
        // workflow's own seat/role effects above are the canonical
        // business act — an intake status change alone never grants
        // them; verdict §D3).
        const foundingIntake = await intakeForCanonical(client, 'founding_applications', applicationId);
        if (foundingIntake && ['RECEIVED', 'UNDER_REVIEW', 'ACTION_REQUIRED'].includes(foundingIntake.status)) {
          // The application machine requires review before a decision:
          // a decision taken straight from RECEIVED walks through
          // UNDER_REVIEW first (both steps land on the event trail).
          if (foundingIntake.status === 'RECEIVED') {
            await transitionIntake(client, {
              id: foundingIntake.id,
              to: 'UNDER_REVIEW',
              actorType: 'ops',
              actorAccountId: req.account.id,
              note: 'Decision review opened',
            });
          }
          await transitionIntake(client, {
            id: foundingIntake.id,
            to: decision === 'approved' ? 'APPROVED' : 'DECLINED',
            actorType: 'ops',
            actorAccountId: req.account.id,
            note: reasonText.slice(0, 1000),
          });
        }
        await client.query(
          `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
           VALUES ($1, 'founding.decide', $2, $3, $4)`,
          [
            req.account.id,
            `founding_application:${applicationId}`,
            reasonText.slice(0, 1000),
            JSON.stringify({ decision, seatNo, applicantAccountId: application.account_id }),
          ],
        );
        await client.query('COMMIT');
        return { application: { id: applicationId, status: decision }, seatNo };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );
}
