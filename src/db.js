// Database access + migration runner.
// The connection string comes from DATABASE_URL at runtime and is never logged.
import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

let _pool = null;

export function getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  _pool = new Pool({
    connectionString,
    max: 10,
    // Neon requires TLS; the URI carries sslmode=require. Keep this as a
    // safety net for URIs that omit it.
    ssl: connectionString.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  });
  _pool.on('error', (err) => {
    // Never let a pool error crash the process silently; server logs pick this up.
    console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', error: err.message }));
  });
  return _pool;
}

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export async function dbUp() {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply every .sql file in migrations/ that is not yet recorded in
 * schema_migrations, in filename order, each inside its own transaction.
 * Returns the list of migration names applied by this call.
 */
export async function runMigrations(pool = getPool()) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
