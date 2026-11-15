// PAIRED engine — API service entrypoint.
// One modular API service (consult cut: no microservices). Clerk
// authenticates; this service + Neon own roles, entitlements, and (from M2)
// listings, orders, and the ledger.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { pathToFileURL } from 'node:url';
import { getPool, dbUp } from './db.js';
import { registerClerkWebhook, processInbox } from './inbox.js';
import { registerMeRoutes } from './routes/me.js';
import { registerFoundingRoutes } from './routes/founding.js';
import { getStripe } from './stripe.js';

const ALLOWED_ORIGINS = new Set([
  'https://pairedart.com',
  'https://www.pairedart.com',
]);

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Local development only.
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: true,
  });
  const pool = getPool();

  app.register(cors, {
    origin: (origin, cb) => cb(null, originAllowed(origin)),
    credentials: true,
  });

  // Errors never leak stack traces or internals.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request error');
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    reply.code(status).send({
      error: {
        code: status === 500 ? 'internal_error' : err.code || 'request_error',
        message: status === 500 ? 'Internal error' : err.message,
      },
    });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  app.get('/health', async (req, reply) => {
    const up = await dbUp();
    if (!up) {
      return reply.code(503).send({ ok: false, db: 'down' });
    }
    return { ok: true, db: 'up' };
  });

  // Clerk webhooks need the RAW body for signature verification, so they
  // live in an encapsulated scope with a string JSON parser.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      done(null, body);
    });
    registerClerkWebhook(scope, pool);
  });

  registerMeRoutes(app, pool);
  registerFoundingRoutes(app, pool);

  // Stripe is initialized lazily and guarded: identity legs boot without it.
  if (!getStripe()) {
    app.log.warn('STRIPE_SECRET_KEY not set — money legs are disabled (fail closed)');
  }

  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = buildServer();
  const port = Number(process.env.PORT || 10000);
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
  // In-process inbox drain: the single-service deploy runs the worker loop
  // here so webhook events are applied without a second process.
  // src/worker.js remains the split-out entrypoint for when scale needs it.
  const pool = getPool();
  const drainMs = Number(process.env.WORKER_INTERVAL_MS || 5000);
  let draining = false;
  setInterval(async () => {
    if (draining) return;
    draining = true;
    try {
      const { processed, failed } = await processInbox(pool);
      if (processed || failed) {
        app.log.info({ processed, failed }, 'inbox drain');
      }
    } catch (err) {
      app.log.error({ err }, 'inbox drain error');
    } finally {
      draining = false;
    }
  }, drainMs);
}
