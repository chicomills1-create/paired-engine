// One-shot migration runner: npm run migrate
import { getPool, runMigrations, closePool } from './db.js';

try {
  const applied = await runMigrations(getPool());
  console.log(
    JSON.stringify({
      msg: 'migrations complete',
      applied,
      note: applied.length ? undefined : 'nothing pending — schema already current',
    }),
  );
  await closePool();
  process.exit(0);
} catch (err) {
  console.error(JSON.stringify({ msg: 'migration failed', error: err.message }));
  process.exit(1);
}
