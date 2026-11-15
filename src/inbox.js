// Durable event inbox (consult A3).
//
// Webhooks are NOT simple callbacks that mutate tables inline. The pattern:
//   signature verification → durable inbox row (unique event id, atomic)
//   → idempotent worker applies state → processed stamp / error record.
// Duplicate deliveries are ignored at insert; out-of-order deliveries are
// reconciled by the worker applying the latest known state.
import { Webhook } from 'svix';

/**
 * Register POST /webhooks/clerk on an encapsulated Fastify scope whose JSON
 * parser keeps the RAW body string (signature verification needs exact bytes).
 */
export function registerClerkWebhook(scope, pool) {
  scope.post('/webhooks/clerk', async (req, reply) => {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    if (!secret) {
      req.log.error('CLERK_WEBHOOK_SECRET is not set');
      return reply.code(500).send({ error: { code: 'not_configured', message: 'Webhook secret missing' } });
    }
    const rawBody = typeof req.body === 'string' ? req.body : '';
    let event;
    try {
      const wh = new Webhook(secret);
      event = wh.verify(rawBody, {
        'svix-id': req.headers['svix-id'],
        'svix-timestamp': req.headers['svix-timestamp'],
        'svix-signature': req.headers['svix-signature'],
      });
    } catch {
      return reply.code(400).send({ error: { code: 'bad_signature', message: 'Webhook signature verification failed' } });
    }

    const eventId = req.headers['svix-id'];
    const { rows } = await pool.query(
      `INSERT INTO event_inbox (source, event_id, type, payload)
       VALUES ('clerk', $1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [eventId, event.type, JSON.stringify(event)],
    );
    // Fast 200 either way: a duplicate is a success, not an error.
    return reply.code(200).send({ received: true, duplicate: rows.length === 0 });
  });
}

function clerkDisplayName(data) {
  const parts = [data.first_name, data.last_name].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return data.username || null;
}

function clerkPrimaryEmail(data) {
  const addresses = Array.isArray(data.email_addresses) ? data.email_addresses : [];
  if (!addresses.length) return null;
  const primary =
    addresses.find((a) => a.id && a.id === data.primary_email_address_id) || addresses[0];
  return primary?.email_address || null;
}

async function applyClerkEvent(client, event) {
  const data = event.data || {};
  if (event.type === 'user.created' || event.type === 'user.updated') {
    if (!data.id) throw new Error(`clerk ${event.type} event without user id`);
    const status = data.banned || data.locked ? 'suspended' : 'active';
    await client.query(
      `INSERT INTO accounts (clerk_user_id, email, display_name, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (clerk_user_id) DO UPDATE
         SET email = COALESCE(EXCLUDED.email, accounts.email),
             display_name = COALESCE(EXCLUDED.display_name, accounts.display_name),
             status = EXCLUDED.status,
             updated_at = now()`,
      [data.id, clerkPrimaryEmail(data), clerkDisplayName(data), status],
    );
    return;
  }
  if (event.type === 'user.deleted') {
    if (!data.id) throw new Error('clerk user.deleted event without user id');
    // Soft-delete: commercial records must survive account deletion (M0).
    await client.query(
      `UPDATE accounts SET status = 'deleted', updated_at = now() WHERE clerk_user_id = $1`,
      [data.id],
    );
    return;
  }
  // Unknown Clerk event types are recorded and marked processed (forward-compatible).
}

/**
 * Apply pending Clerk events from the inbox, idempotently.
 * Each event is claimed with FOR UPDATE SKIP LOCKED inside its own
 * transaction; failures keep the row unprocessed with attempts/last_error
 * recorded, so a failed job never silently disappears.
 * (Stripe events stay queued for the M3 worker — money state is never
 * applied by a no-op.)
 */
export async function processInbox(pool, { limit = 25 } = {}) {
  const client = await pool.connect();
  let processed = 0;
  let failed = 0;
  try {
    for (let i = 0; i < limit; i++) {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, type, payload FROM event_inbox
          WHERE source = 'clerk' AND processed_at IS NULL
          ORDER BY received_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (!rows.length) {
        await client.query('COMMIT');
        break;
      }
      const row = rows[0];
      try {
        await applyClerkEvent(client, row.payload);
        await client.query(
          `UPDATE event_inbox
              SET processed_at = now(), attempts = attempts + 1, last_error = NULL
            WHERE id = $1`,
          [row.id],
        );
        await client.query('COMMIT');
        processed++;
      } catch (err) {
        await client.query('ROLLBACK');
        await pool.query(
          `UPDATE event_inbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
          [row.id, String(err.message || err).slice(0, 1000)],
        );
        failed++;
      }
    }
  } finally {
    client.release();
  }
  return { processed, failed };
}
