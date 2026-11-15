// Background worker: drains the event inbox (Clerk identity events +
// Stripe money events), runs the commerce sweeps (reservation expiry,
// acceptance windows, release attempts), and — on a slower cadence —
// the M6 reconciliation pass (Stripe ↔ ledger → exception queue). Run
// as its own process: npm run worker. The single-service deploy also
// runs these loops in-process (src/server.js); every step is idempotent,
// so overlap is harmless.
import { getPool, closePool } from './db.js';
import { processInbox } from './inbox.js';
import { runCommerceSweeps } from './lib/release.js';
import { runReconciliation } from './lib/reconcile.js';
import { getStripe } from './stripe.js';

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 5000);
const RECONCILE_EVERY_MS = Number(process.env.RECONCILE_INTERVAL_MS || 15 * 60 * 1000);
const pool = getPool();
let stopping = false;
let lastReconcileAt = 0;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
  });
}

while (!stopping) {
  try {
    const { processed, failed } = await processInbox(pool);
    if (processed || failed) {
      console.log(JSON.stringify({ msg: 'inbox drain', processed, failed }));
    }
    const sweeps = await runCommerceSweeps(pool, getStripe());
    if (sweeps.expiredReservations || sweeps.windowsAccepted || sweeps.transfersCompleted) {
      console.log(JSON.stringify({ msg: 'commerce sweeps', ...sweeps }));
    }
    if (Date.now() - lastReconcileAt >= RECONCILE_EVERY_MS) {
      lastReconcileAt = Date.now();
      const result = await runReconciliation(pool, getStripe());
      if (result.ran && (result.raised || result.payoutsAdvanced)) {
        console.log(JSON.stringify({ msg: 'reconciliation', ...result, discrepancies: result.discrepancies.length }));
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: 'inbox drain error', error: err.message }));
  }
  if (!stopping) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

await closePool();
process.exit(0);
