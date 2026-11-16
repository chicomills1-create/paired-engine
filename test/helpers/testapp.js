// Test app assembly: Clerk's verifyToken is stubbed at the module level
// (Bearer tok_<name> → Clerk user clerk_<name>), then the real M2 route
// modules are registered on a throwaway Fastify instance backed by the
// test pool. Error + not-found handlers mirror src/server.js so response
// shapes match production.
import { mock } from 'node:test';

export function stubClerk() {
  mock.module('@clerk/backend', {
    cache: true,
    exports: {
      verifyToken: async (token) => {
        if (typeof token === 'string' && token.startsWith('tok_') && token.length > 4) {
          const name = token.slice('tok_'.length);
          return { sub: `clerk_${name}`, email: `${name}@example.test` };
        }
        throw new Error('invalid token');
      },
    },
  });
}

export async function buildTestApp(pool) {
  const { default: Fastify } = await import('fastify');
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, req, reply) => {
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

  const { registerArtistRoutes } = await import('../../src/routes/artist.js');
  const { registerListingsRoutes } = await import('../../src/routes/listings.js');
  const { registerUploadsRoutes } = await import('../../src/routes/uploads.js');
  const { registerOrdersRoutes } = await import('../../src/routes/orders.js');
  const { registerMeRoutes } = await import('../../src/routes/me.js');
  const { registerFoundingRoutes } = await import('../../src/routes/founding.js');
  const { registerBriefsRoutes } = await import('../../src/routes/briefs.js');
  const { registerStudioRoutes } = await import('../../src/routes/studio.js');
  const { registerRoomRoutes } = await import('../../src/routes/room.js');
  const { registerAdminRoutes } = await import('../../src/routes/admin.js');
  const { registerSoundRoutes } = await import('../../src/routes/sound.js');
  const { registerSupportRoutes } = await import('../../src/routes/support.js');
  const { registerStripeWebhook } = await import('../../src/inbox.js');
  registerArtistRoutes(app, pool);
  registerListingsRoutes(app, pool);
  registerUploadsRoutes(app, pool);
  registerOrdersRoutes(app, pool);
  registerMeRoutes(app, pool);
  registerFoundingRoutes(app, pool);
  registerBriefsRoutes(app, pool);
  registerStudioRoutes(app, pool);
  registerRoomRoutes(app, pool);
  registerAdminRoutes(app, pool);
  registerSoundRoutes(app, pool);
  registerSupportRoutes(app, pool);
  // Stripe webhooks verify against the RAW body — same encapsulated
  // string-parser scope as production (src/server.js).
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      done(null, body);
    });
    registerStripeWebhook(scope, pool);
  });
  return app;
}

/** app.inject shorthand. `as` names the stubbed Clerk user (tok_<name>). */
export function call(app, { method, url, as, payload }) {
  const headers = {};
  if (as) headers.authorization = `Bearer tok_${as}`;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload });
}

export async function accountIdFor(pool, name) {
  const { rows } = await pool.query('SELECT id FROM accounts WHERE clerk_user_id = $1', [
    `clerk_${name}`,
  ]);
  return rows[0]?.id || null;
}

export async function grantRole(pool, accountId, role) {
  await pool.query(
    `INSERT INTO account_roles (account_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [accountId, role],
  );
}
