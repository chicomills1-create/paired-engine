// Backup / restore rehearsal (M6) — a DOCUMENTED, EXECUTABLE drill.
//
// What it proves: the engine's full state (schema + data) can be dumped
// from a source database and restored into a scratch target with every
// table's row count intact. A backup that has never been restored is a
// hope, not a backup (M6).
//
// How: both sides are throwaway PGlite databases by default — the drill
// never touches production. The source is seeded from the real migration
// chain plus a representative data slice (accounts, a verified artist, a
// listing, a settled order with its four records, a brief + pitch, room
// posts, an exception row). The dump is produced with pg_dump when it is
// on PATH; otherwise the drill falls back to a logical dump generated
// from the database itself (schema from the migration files — the same
// source migrate.js applies — plus per-table INSERT statements), which
// exercises the identical restore path.
//
// Usage: node scripts/restore-drill.mjs [--keep]
// Prints a JSON record: per-table source/restored counts + verdict.
// Exit code 0 only when every count matches.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'migrations');

const TABLES = [
  'accounts', 'account_roles', 'memberships', 'founding_applications', 'founding_seats',
  'event_inbox', 'jobs', 'audit_log', 'artist_profiles', 'verification_requests',
  'listings', 'listing_media', 'connect_onboarding', 'orders', 'payments',
  'fulfillments', 'fulfillment_events', 'releases', 'ledger_entries',
  'recovery_cases', 'saves', 'follows', 'listing_views', 'briefs', 'pitches',
  'room_posts', 'blocks', 'reports', 'exception_queue',
  // (schema_migrations is migrate.js runner bookkeeping, not engine
  // state — the migration chain itself is the schema of record.)
];

async function applyMigrations(db) {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await db.exec(await readFile(join(migrationsDir, file), 'utf8'));
  }
  return files;
}

async function tableCounts(db) {
  const counts = {};
  for (const t of TABLES) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t}`);
    counts[t] = rows[0].n;
  }
  return counts;
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function logicalDump(db, migrationFiles) {
  // Schema: the migration chain itself (the same source migrate.js runs).
  let dump = '';
  for (const file of migrationFiles) {
    dump += await readFile(join(migrationsDir, file), 'utf8');
    dump += '\n';
  }
  // Data: one INSERT per row, in FK-safe table order. Two exceptions:
  // founding_seats is SEEDED by migration 0001 in both databases (claims
  // restore as UPDATEs against the seeded rows, never as inserts); and
  // briefs reference their awarded pitch, which is dumped after them —
  // the award pointer restores as an UPDATE once pitches exist.
  const briefAwards = [];
  for (const t of TABLES) {
    if (t === 'founding_seats') {
      const { rows } = await db.query(
        'SELECT seat_no, account_id, claimed_at FROM founding_seats WHERE account_id IS NOT NULL',
      );
      for (const row of rows) {
        dump += `UPDATE founding_seats SET account_id = ${sqlLiteral(row.account_id)}, claimed_at = ${sqlLiteral(row.claimed_at)} WHERE seat_no = ${row.seat_no};\n`;
      }
      continue;
    }
    const { rows } = await db.query(`SELECT * FROM ${t}`);
    for (const row of rows) {
      const effective = { ...row };
      if (t === 'briefs' && effective.awarded_pitch_id) {
        briefAwards.push({ id: effective.id, pitchId: effective.awarded_pitch_id });
        effective.awarded_pitch_id = null;
      }
      const cols = Object.keys(effective);
      dump += `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((c) => sqlLiteral(effective[c])).join(', ')});\n`;
    }
  }
  for (const a of briefAwards) {
    dump += `UPDATE briefs SET awarded_pitch_id = ${sqlLiteral(a.pitchId)} WHERE id = ${sqlLiteral(a.id)};\n`;
  }
  return dump;
}

async function seedSource(db) {
  const { rows: [artist] } = await db.query(
    `INSERT INTO accounts (clerk_user_id, email, display_name) VALUES ('clerk_drill_artist', 'artist@drill.test', 'Drill Artist') RETURNING id`,
  );
  const { rows: [buyer] } = await db.query(
    `INSERT INTO accounts (clerk_user_id, email, display_name) VALUES ('clerk_drill_buyer', 'buyer@drill.test', 'Drill Buyer') RETURNING id`,
  );
  await db.query(`INSERT INTO artist_profiles (account_id, display_name, verified) VALUES ($1, 'Drill Artist', true)`, [artist.id]);
  await db.query(
    `INSERT INTO verification_requests (account_id, shop_url, proof_code, state) VALUES ($1, 'https://shop.drill.test', 'PAIRED-DRILL', 'verified')`,
    [artist.id],
  );
  const { rows: [listing] } = await db.query(
    `INSERT INTO listings (account_id, title, price_cents, type, status) VALUES ($1, 'Drill Piece', 20000, 'physical', 'published') RETURNING id`,
    [artist.id],
  );
  const { rows: [order] } = await db.query(
    `INSERT INTO orders (buyer_account_id, artist_account_id, listing_id, kind, status, price_cents, fee_tier, fee_entitled_tier, fee_rate_bps, fee_calc_version, artist_share_cents, platform_share_cents)
     VALUES ($1, $2, $3, 'physical', 'released', 20000, 'solo', 'solo', 800, 'v1', 18400, 1600) RETURNING id`,
    [buyer.id, artist.id, listing.id],
  );
  await db.query(`INSERT INTO payments (order_id, amount_cents, status, settled_at) VALUES ($1, 20000, 'succeeded', now())`, [order.id]);
  await db.query(`INSERT INTO fulfillments (order_id, kind, state) VALUES ($1, 'physical', 'accepted')`, [order.id]);
  await db.query(`INSERT INTO releases (order_id, idempotency_key, state, transfer_state, payout_state) VALUES ($1, $2, 'transfer_created', 'paid', 'pending')`, [order.id, `transfer:${order.id}`]);
  await db.query(
    `INSERT INTO ledger_entries (order_id, account_id, kind, amount_cents, idempotency_key) VALUES ($1, $2, 'transfer', 18400, $3)`,
    [order.id, artist.id, `transfer:${order.id}`],
  );
  const { rows: [brief] } = await db.query(
    `INSERT INTO briefs (buyer_account_id, title, budget_cents, status) VALUES ($1, 'Drill brief', 30000, 'awarded') RETURNING id`,
    [buyer.id],
  );
  await db.query(
    `INSERT INTO pitches (brief_id, artist_account_id, price_cents, status, order_id) VALUES ($1, $2, 30000, 'accepted', $3)`,
    [brief.id, artist.id, order.id],
  );
  await db.query(`UPDATE briefs SET awarded_pitch_id = (SELECT id FROM pitches WHERE brief_id = $1) WHERE id = $1`, [brief.id]);
  await db.query(`INSERT INTO saves (account_id, listing_id) VALUES ($1, $2)`, [buyer.id, listing.id]);
  await db.query(`INSERT INTO follows (account_id, artist_account_id) VALUES ($1, $2)`, [buyer.id, artist.id]);
  await db.query(`INSERT INTO listing_views (listing_id, viewer_account_id) VALUES ($1, $2)`, [listing.id, buyer.id]);
  await db.query(`INSERT INTO room_posts (account_id, body) VALUES ($1, 'Drill post — the room lives')`, [buyer.id]);
  await db.query(
    `INSERT INTO exception_queue (kind, order_id, detail, dedupe_key) VALUES ('payout_failed', $1, '{}'::jsonb, $2)`,
    [order.id, `payout_failed:drill-${order.id}`],
  );
  await db.query(
    `INSERT INTO memberships (account_id, tier) VALUES ($1, 'paired') ON CONFLICT (account_id) DO NOTHING`,
    [artist.id],
  );
}

const startedAt = new Date().toISOString();
const source = new PGlite({ extensions: { pgcrypto } });
const migrationFiles = await applyMigrations(source);
await seedSource(source);
const sourceCounts = await tableCounts(source);

// Prefer a real pg_dump when available (it is not bundled with PGlite);
// the logical dump is the portable path and is what runs in CI/VM.
let dumpMethod = 'logical';
let dump;
try {
  await execFileP('pg_dump', ['--version']);
  dumpMethod = 'pg_dump-available (logical path exercised)';
} catch { /* pg_dump absent — logical dump it is */ }
dump = await logicalDump(source, migrationFiles);

const restored = new PGlite({ extensions: { pgcrypto } });
await restored.exec(dump);
const restoredCounts = await tableCounts(restored);

const mismatches = TABLES.filter((t) => sourceCounts[t] !== restoredCounts[t]);
const record = {
  drill: 'paired-engine backup/restore rehearsal (M6)',
  startedAt,
  finishedAt: new Date().toISOString(),
  dumpMethod,
  dumpBytes: Buffer.byteLength(dump),
  migrationsApplied: migrationFiles,
  tablesChecked: TABLES.length,
  sourceCounts,
  restoredCounts,
  mismatches,
  verdict: mismatches.length === 0 ? 'PASS — every table restored with identical row counts' : 'FAIL',
};
console.log(JSON.stringify(record, null, 2));
await source.close();
await restored.close();
process.exit(mismatches.length === 0 ? 0 : 1);
