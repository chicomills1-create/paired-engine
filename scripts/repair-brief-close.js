// One-off C-23 repair (v93): an Intake Desk close recorded BEFORE the Desk
// close learned to close the canonical brief in the same transaction left
// one live divergence — the intake record is CLOSED while the canonical
// brief still reads "open". This script syncs the canonical brief through
// the same shape the new code path uses: one transaction, the closure
// stamped on the brief row (closed_at = the moment ops actually closed it,
// from the intake close event; closed_by = 'desk'), and the sync itself
// written to the intake event trail. Idempotent: a brief that is not open
// is left untouched and reported as already-synced. Never a silent edit.
//
// Usage: node scripts/repair-brief-close.js <intake-reference>
//   e.g. node scripts/repair-brief-close.js PAIRED-6KW77HXBBC
import { getPool, closePool } from '../src/db.js';
import { appendIntakeEvent } from '../src/lib/intake.js';

const reference = process.argv[2];
if (!reference) {
  console.error('usage: node scripts/repair-brief-close.js <intake-reference>');
  process.exit(2);
}

const pool = getPool();
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows: subs } = await client.query(
    `SELECT * FROM intake_submissions
      WHERE reference = $1 AND type = 'brief' FOR UPDATE`,
    [reference],
  );
  const sub = subs[0];
  if (!sub) throw new Error(`no brief intake submission with reference ${reference}`);
  if (sub.status !== 'CLOSED') {
    throw new Error(`intake ${reference} is ${sub.status}, not CLOSED — nothing to repair`);
  }
  if (!sub.canonical_id) throw new Error(`intake ${reference} has no canonical brief`);
  const { rows: briefs } = await client.query('SELECT * FROM briefs WHERE id = $1 FOR UPDATE', [
    sub.canonical_id,
  ]);
  const brief = briefs[0];
  if (!brief) throw new Error(`canonical brief ${sub.canonical_id} not found`);
  if (brief.status !== 'open') {
    await client.query('COMMIT');
    console.log(
      JSON.stringify({
        repaired: false,
        reason: 'canonical brief already not open',
        reference,
        briefId: brief.id,
        briefStatus: brief.status,
        closedAt: brief.closed_at,
        closedBy: brief.closed_by,
      }),
    );
  } else {
    const { rows: ev } = await client.query(
      `SELECT created_at FROM intake_events
        WHERE submission_id = $1 AND to_status = 'CLOSED'
        ORDER BY created_at DESC LIMIT 1`,
      [sub.id],
    );
    const closedAt = ev[0]?.created_at || sub.updated_at;
    const { rows: upd } = await client.query(
      `UPDATE briefs
          SET status = 'canceled', closed_at = $2, closed_by = 'desk', updated_at = now()
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [brief.id, closedAt],
    );
    await appendIntakeEvent(client, {
      id: sub.id,
      actorType: 'ops',
      actorAccountId: null,
      kind: 'note',
      note: 'v93 repair: canonical brief synchronized to closed — this Desk close predated the canonical sync in the close path (C-23).',
    });
    await client.query('COMMIT');
    console.log(
      JSON.stringify({
        repaired: true,
        reference,
        briefId: upd[0].id,
        briefStatus: upd[0].status,
        closedAt: upd[0].closed_at,
        closedBy: upd[0].closed_by,
      }),
    );
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ repaired: false, error: String(err && err.message || err) }));
  process.exitCode = 1;
} finally {
  client.release();
  await closePool();
}
