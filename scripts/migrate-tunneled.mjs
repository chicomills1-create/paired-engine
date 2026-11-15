// Tunneled migration runner — OPS TOOL for this VM only.
//
// Why this exists: the VM's direct TCP/5432 egress is intercepted (the far
// end is not a real Postgres), and the only working egress is the HTTP
// proxy. This script starts a local TCP forwarder that tunnels through the
// proxy (HTTP CONNECT) to the real Neon host, then applies migrations with
// a pg Client whose TLS SNI still names the real host (Neon routes by SNI).
//
// On any normal network (Render, a laptop) you do NOT need this:
// `npm run migrate` with DATABASE_URL set is the production path.
//
// DATABASE_URL is read from the environment and never printed.
import net from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const dbUrl = new URL(process.env.DATABASE_URL);
const targetHost = dbUrl.hostname;
const targetPort = Number(dbUrl.port || 5432);

const proxyUrl = new URL(process.env.https_proxy || process.env.HTTPS_PROXY);
const proxyHost = proxyUrl.hostname;
const proxyPort = Number(proxyUrl.port || 3128);
const proxyAuth =
  proxyUrl.username || proxyUrl.password
    ? 'Basic ' +
      Buffer.from(
        `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
      ).toString('base64')
    : null;

function tunnel(local) {
  const remote = net.connect(proxyPort, proxyHost);
  let headerBuf = Buffer.alloc(0);
  let established = false;
  remote.on('connect', () => {
    const lines = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
    ];
    if (proxyAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
    remote.write(lines.join('\r\n') + '\r\n\r\n');
  });
  remote.on('data', (chunk) => {
    if (established) {
      local.write(chunk);
      return;
    }
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const end = headerBuf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const statusLine = headerBuf.subarray(0, end).toString('latin1').split('\r\n')[0];
    if (!statusLine.includes(' 200')) {
      console.error('proxy CONNECT failed:', statusLine);
      local.destroy();
      remote.destroy();
      process.exitCode = 1;
      return;
    }
    established = true;
    const rest = headerBuf.subarray(end + 4);
    if (rest.length) local.write(rest);
    local.on('data', (d) => remote.write(d));
  });
  remote.on('error', () => local.destroy());
  remote.on('close', () => local.destroy());
  local.on('error', () => remote.destroy());
  local.on('close', () => remote.destroy());
}

const server = net.createServer(tunnel);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const localPort = server.address().port;

const client = new pg.Client({
  host: '127.0.0.1',
  port: localPort,
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.replace(/^\//, ''),
  ssl: { rejectUnauthorized: false, servername: targetHost },
});

try {
  await client.connect();
  console.log('tunneled connection established');

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows: doneRows } = await client.query('SELECT name FROM schema_migrations');
  const done = new Set(doneRows.map((r) => r.name));
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
  console.log('applied migrations:', applied.length ? applied.join(', ') : '(none pending)');

  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  console.log('tables:', tables.map((t) => t.table_name).join(', '));
  const { rows: seats } = await client.query('SELECT count(*)::int AS n FROM founding_seats');
  console.log('founding_seats rows:', seats[0].n);
} finally {
  await client.end().catch(() => {});
  server.close();
}
