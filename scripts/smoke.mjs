// In-process wiring smoke: builds the app with a dummy DATABASE_URL and
// injects requests (no socket, no live DB). Expects:
//   /health            -> 503 {ok:false, db:'down'}  (dummy DB is unreachable)
//   /v1/me (no token)  -> 401
//   /webhooks/clerk    -> 500 not_configured (no CLERK_WEBHOOK_SECRET set)
//   /nope              -> 404
process.env.DATABASE_URL ||= 'postgres://u:p@127.0.0.1:1/db';
delete process.env.CLERK_WEBHOOK_SECRET;
delete process.env.STRIPE_SECRET_KEY;

const { buildServer } = await import('../src/server.js');
const app = buildServer();

const health = await app.inject({ method: 'GET', url: '/health' });
console.log('GET /health ->', health.statusCode, health.body);

const me = await app.inject({ method: 'GET', url: '/v1/me' });
console.log('GET /v1/me (no token) ->', me.statusCode, me.body);

const hook = await app.inject({
  method: 'POST',
  url: '/webhooks/clerk',
  headers: { 'content-type': 'application/json' },
  payload: '{}',
});
console.log('POST /webhooks/clerk (no secret configured) ->', hook.statusCode, hook.body);

const missing = await app.inject({ method: 'GET', url: '/nope' });
console.log('GET /nope ->', missing.statusCode, missing.body);

await app.close();
process.exit(0);
