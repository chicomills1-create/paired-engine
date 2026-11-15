// Migration smoke test — SKIPPED unless TEST_DATABASE_URL is set.
// Point it at a throwaway database/branch, never at production data you care
// about: it applies all migrations and asserts the core schema exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('migrations apply and core tables exist', { skip: !url }, async () => {
  process.env.DATABASE_URL = url;
  const { getPool, runMigrations, closePool } = await import('../src/db.js');
  const pool = getPool();
  try {
    const applied = await runMigrations(pool);
    assert.ok(Array.isArray(applied));

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const expected of [
      'accounts',
      'account_roles',
      'memberships',
      'founding_applications',
      'founding_seats',
      'event_inbox',
      'jobs',
      'audit_log',
      'schema_migrations',
      // M2 (0002_artists_listings)
      'artist_profiles',
      'verification_requests',
      'listings',
      'listing_media',
      'connect_onboarding',
    ]) {
      assert.ok(tables.includes(expected), `missing table: ${expected}`);
    }

    const { rows: seats } = await pool.query('SELECT count(*)::int AS n FROM founding_seats');
    assert.equal(seats[0].n, 100);

    // Re-running migrations is a no-op (idempotent runner).
    const second = await runMigrations(pool);
    assert.deepEqual(second, []);
  } finally {
    await closePool();
  }
});
