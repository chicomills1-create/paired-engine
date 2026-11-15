// Standalone reconciliation run (M6): node scripts/reconcile.mjs
// Runs one Stripe ↔ ledger truth pass against DATABASE_URL and prints
// the summary + every discrepancy found. Safe to re-run (idempotent —
// discrepancies dedupe in the exception queue). The worker and the API
// service also run this on a cadence; this entrypoint is for a human or
// a cron that wants it NOW, with the full list in the output.
import { getPool, closePool } from '../src/db.js';
import { getStripe } from '../src/stripe.js';
import { runReconciliation } from '../src/lib/reconcile.js';

const pool = getPool();
try {
  const result = await runReconciliation(pool, getStripe());
  console.log(JSON.stringify({ msg: 'reconciliation', ...result }, null, 2));
  if (!result.ran) process.exitCode = 2; // not configured is not "clean"
} finally {
  await closePool();
}
