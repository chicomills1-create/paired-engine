// Background worker: drains the event inbox (Clerk events in M1; Stripe
// money events join in M3). Run as its own process: npm run worker
import { getPool, closePool } from './db.js';
import { processInbox } from './inbox.js';

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
  } catch (err) {
    console.error(JSON.stringify({ msg: 'inbox drain error', error: err.message }));
  }
  if (!stopping) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

await closePool();
process.exit(0);
