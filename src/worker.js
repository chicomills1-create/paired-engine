// Background worker: drains the event inbox (Clerk identity events +
// Stripe money events) and runs the commerce sweeps (reservation expiry,
// acceptance windows, release attempts). Run as its own process:
// npm run worker. The single-service deploy also runs both loops
// in-process (src/server.js); every step is idempotent, so overlap is
// harmless.
import { getPool, closePool } from './db.js';
import { processInbox } from './inbox.js';
import { runCommerceSweeps } from './lib/release.js';
import { getStripe } from './stripe.js';

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 5000);
const pool = getPool();
let stopping = false;

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
  } catch (err) {
    console.error(JSON.stringify({ msg: 'inbox drain error', error: err.message }));
  }
  if (!stopping) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

await closePool();
process.exit(0);
