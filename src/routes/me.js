// GET /v1/me — the caller's server-side truth: account + roles + membership.
// The frontend renders from this; it never decides tier or roles itself.
import { requireAuth, getMembership } from '../auth.js';

export function registerMeRoutes(app, pool) {
  app.get('/v1/me', { preHandler: requireAuth(pool) }, async (req) => {
    const membership = await getMembership(pool, req.account.id);
    return {
      account: {
        id: req.account.id,
        email: req.account.email,
        displayName: req.account.displayName,
        status: req.account.status,
      },
      roles: req.account.roles,
      membership: membership
        ? {
            tier: membership.tier,
            status: membership.status,
            currentPeriodEnd: membership.current_period_end,
          }
        : null,
    };
  });
}
