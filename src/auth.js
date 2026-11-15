// Authentication + account resolution.
//
// Law (M0/consult A1): Clerk authenticates identity. THIS database owns
// roles, permissions and commercial state. The frontend never decides
// whether a user is a paid member, a verified artist, or a moderator —
// every protected route resolves the account + roles server-side here.
import { verifyToken } from '@clerk/backend';

function unauthorized(reply, code = 'unauthorized', message = 'Authentication required') {
  return reply.code(401).send({ error: { code, message } });
}

/**
 * Resolve the local account for a Clerk user id, creating it on first sight.
 * New accounts get the default 'buyer' role and a Solo membership row —
 * entitlements only ever change server-side (webhooks, admin actions).
 */
export async function resolveOrCreateAccount(pool, clerkUserId, email = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO accounts (clerk_user_id, email)
       VALUES ($1, $2)
       ON CONFLICT (clerk_user_id) DO UPDATE
         SET email = COALESCE(EXCLUDED.email, accounts.email),
             updated_at = now()
       RETURNING id, clerk_user_id, email, display_name, status`,
      [clerkUserId, email],
    );
    const account = rows[0];
    await client.query(
      `INSERT INTO account_roles (account_id, role) VALUES ($1, 'buyer')
       ON CONFLICT DO NOTHING`,
      [account.id],
    );
    await client.query(
      `INSERT INTO memberships (account_id) VALUES ($1)
       ON CONFLICT (account_id) DO NOTHING`,
      [account.id],
    );
    await client.query('COMMIT');
    return account;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getRoles(pool, accountId) {
  const { rows } = await pool.query('SELECT role FROM account_roles WHERE account_id = $1', [
    accountId,
  ]);
  return rows.map((r) => r.role);
}

export async function getMembership(pool, accountId) {
  const { rows } = await pool.query(
    `SELECT account_id, tier, status, stripe_customer_id, stripe_subscription_id,
            current_period_end, updated_at
       FROM memberships WHERE account_id = $1`,
    [accountId],
  );
  return rows[0] || null;
}

/**
 * Fastify preHandler: verify the Clerk session token
 * (Authorization: Bearer <token>), resolve/create the local account, and
 * attach req.account = { id, clerkUserId, email, displayName, status, roles }.
 */
export function requireAuth(pool) {
  return async function authPreHandler(req, reply) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
    if (!token) return unauthorized(reply);

    let claims;
    try {
      claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    } catch {
      return unauthorized(reply, 'invalid_token', 'Session token could not be verified');
    }
    if (!claims || !claims.sub) return unauthorized(reply, 'invalid_token', 'Session token has no subject');

    const account = await resolveOrCreateAccount(pool, claims.sub, claims.email || null);
    if (account.status !== 'active') {
      return reply
        .code(403)
        .send({ error: { code: 'account_not_active', message: `Account is ${account.status}` } });
    }
    req.account = {
      id: account.id,
      clerkUserId: account.clerk_user_id,
      email: account.email,
      displayName: account.display_name,
      status: account.status,
      roles: await getRoles(pool, account.id),
    };
  };
}

/** Fastify preHandler factory: require a role (run after requireAuth). */
export function requireRole(role) {
  return async function rolePreHandler(req, reply) {
    if (!req.account) return unauthorized(reply);
    if (!req.account.roles.includes(role)) {
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: `Requires role: ${role}` } });
    }
  };
}
