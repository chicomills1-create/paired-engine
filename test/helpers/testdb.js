// Test database: a real Postgres (PGlite/WASM) with every migration in
// migrations/ applied, wrapped in the pg Pool/Client shape the engine uses.
// Tests get true SQL semantics — constraints, transactions, guarded
// updates — without a network database.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export async function createTestDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await db.exec(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  const pool = {
    query: (text, params) => db.query(text, params),
    connect: async () => ({
      query: (text, params) => db.query(text, params),
      release: () => {},
    }),
    end: () => db.close(),
  };
  return { db, pool };
}
