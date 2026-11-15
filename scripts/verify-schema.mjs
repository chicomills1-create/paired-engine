// Schema verification: lists public tables + a few row counts.
// Reads DATABASE_URL from the environment; prints table names/counts only.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  console.log('tables:', tables.map((t) => t.table_name).join(', '));

  const { rows: seats } = await pool.query('SELECT count(*)::int AS n FROM founding_seats');
  console.log('founding_seats rows:', seats[0].n);

  const { rows: mig } = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
  console.log('schema_migrations:', mig.map((m) => m.name).join(', '));
} finally {
  await pool.end();
}
