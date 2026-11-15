// Orders — checkout creation, order reads, fulfillment actions, and the
// admin money controls (M3).
//
// Ownership law (as everywhere in this engine): every action resolves
// the actor from the caller's token, never from body params. An order is
// visible to its buyer, its artist, and admins — everyone else gets 404
// so orders never leak their existence.
import { requireAuth, requireRole } from '../auth.js';
import { getStripe } from '../stripe.js';
import { createCheckout } from '../lib/checkout.js';
import {
  shipFulfillment,
  markDelivered,
  deliverDigital,
  logDownload,
  startCommission,
  deliverCommission,
  requestRevision,
  markLost,
  acceptFulfillment,
} from '../lib/fulfillment.js';
import { evaluateRelease } from '../lib/release.js';

function notFound(reply) {
  return reply.code(404).send({ error: { code: 'not_found', message: 'Order not found' } });
}

function badRequest(reply, message) {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}

function sendErr(reply, err) {
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  const body = {
    error: {
      code: status === 500 ? 'internal_error' : err.code || 'request_error',
      message: status === 500 ? 'Internal error' : err.message,
    },
  };
  if (Array.isArray(err.failed)) body.error.failed = err.failed;
  return reply.code(status).send(body);
}

async function getOrder(pool, orderId) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0] || null;
}

export async function orderView(pool, order) {
  const [{ rows: p }, { rows: f }, { rows: r }] = await Promise.all([
    pool.query('SELECT * FROM payments WHERE order_id = $1', [order.id]),
    pool.query('SELECT * FROM fulfillments WHERE order_id = $1', [order.id]),
    pool.query('SELECT * FROM releases WHERE order_id = $1', [order.id]),
  ]);
  const payment = p[0] || null;
  const fulfillment = f[0] || null;
  const release = r[0] || null;
  return {
    id: order.id,
    buyerAccountId: order.buyer_account_id,
    artistAccountId: order.artist_account_id,
    listingId: order.listing_id,
    kind: order.kind,
    status: order.status,
    priceCents: order.price_cents,
    currency: order.currency,
    feeSnapshot: {
      tier: order.fee_tier,
      entitledTier: order.fee_entitled_tier,
      rateBps: order.fee_rate_bps,
      calcVersion: order.fee_calc_version,
      artistShareCents: order.artist_share_cents,
      platformShareCents: order.platform_share_cents,
    },
    payment: payment
      ? {
          status: payment.status,
          disputeState: payment.dispute_state,
          settledAt: payment.settled_at,
          refundedCents: payment.refunded_cents,
        }
      : null,
    fulfillment: fulfillment
      ? {
          kind: fulfillment.kind,
          state: fulfillment.state,
          carrier: fulfillment.carrier,
          trackingNumber: fulfillment.tracking_number,
          shippedAt: fulfillment.shipped_at,
          deliveredAt: fulfillment.delivered_at,
          acceptanceDueAt: fulfillment.acceptance_due_at,
          acceptedAt: fulfillment.accepted_at,
          acceptanceSource: fulfillment.acceptance_source,
          downloads: fulfillment.downloads,
        }
      : null,
    // Transfer and payout are SEPARATE statuses (M0) — always both.
    release: release
      ? {
          state: release.state,
          transferState: release.transfer_state,
          payoutState: release.payout_state,
          rail: release.rail,
          blockers: release.blockers,
        }
      : null,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

function isAdmin(req) {
  return req.account.roles.includes('admin');
}

/** Load an order the caller may act on in the given seat, else null. */
async function orderFor(pool, req, orderId, seat) {
  const order = await getOrder(pool, orderId);
  if (!order) return null;
  if (isAdmin(req)) return order;
  if (seat === 'artist' && order.artist_account_id === req.account.id) return order;
  if (seat === 'buyer' && order.buyer_account_id === req.account.id) return order;
  if (
    seat === 'any' &&
    (order.artist_account_id === req.account.id || order.buyer_account_id === req.account.id)
  ) {
    return order;
  }
  return null;
}

export function registerOrdersRoutes(app, pool) {
  const auth = requireAuth(pool);
  const admin = requireRole('admin');

  // POST /v1/listings/:id/checkout — the buy door. The server re-checks
  // all 7 conditions at creation (src/lib/checkout.js); the fee snapshot
  // and the 15-minute one-of-one reservation land in the same motion.
  app.post('/v1/listings/:id/checkout', { preHandler: auth }, async (req, reply) => {
    try {
      const { order, checkoutUrl } = await createCheckout(pool, getStripe(), {
        buyer: req.account,
        listingId: req.params.id,
      });
      return reply.code(201).send({ order: await orderView(pool, order), checkoutUrl });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  // GET /v1/orders — my purchases.
  app.get('/v1/orders', { preHandler: auth }, async (req) => {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE buyer_account_id = $1 ORDER BY created_at DESC',
      [req.account.id],
    );
    const orders = [];
    for (const row of rows) orders.push(await orderView(pool, row));
    return { orders };
  });

  // GET /v1/orders/sales — my sales (artist seat).
  app.get('/v1/orders/sales', { preHandler: auth }, async (req) => {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE artist_account_id = $1 ORDER BY created_at DESC',
      [req.account.id],
    );
    const orders = [];
    for (const row of rows) orders.push(await orderView(pool, row));
    return { orders };
  });

  // GET /v1/orders/:id — buyer, artist, or admin.
  app.get('/v1/orders/:id', { preHandler: auth }, async (req, reply) => {
    const order = await orderFor(pool, req, req.params.id, 'any');
    if (!order) return notFound(reply);
    return { order: await orderView(pool, order) };
  });

  // --- Fulfillment actions -------------------------------------------------

  // POST /v1/orders/:id/ship — artist, physical: carrier + tracking.
  app.post('/v1/orders/:id/ship', { preHandler: auth }, async (req, reply) => {
    const order = await orderFor(pool, req, req.params.id, 'artist');
    if (!order) return notFound(reply);
    const body = req.body || {};
    const carrier = typeof body.carrier === 'string' ? body.carrier.slice(0, 80) : '';
    const trackingNumber =
      typeof body.trackingNumber === 'string' ? body.trackingNumber.trim().slice(0, 120) : '';
    if (!trackingNumber) return badRequest(reply, 'trackingNumber is required — ship with tracking, always');
    try {
      await shipFulfillment(pool, { orderId: order.id, actorId: req.account.id, carrier, trackingNumber });
      return { order: await orderView(pool, await getOrder(pool, order.id)) };
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  // POST /v1/orders/:id/deliver — artist delivery, dispatched by kind:
  // physical = carrier-scan evidence · digital = the file reference ·
  // commission = the delivered work. Starts the acceptance window.
  app.post('/v1/orders/:id/deliver', { preHandler: auth }, async (req, reply) => {
    const order = await orderFor(pool, req, req.params.id, 'artist');
    if (!order) return notFound(reply);
    const body = req.body || {};
    try {
      if (order.kind === 'physical') {
        await markDelivered(pool, {
          orderId: order.id,
          actorId: req.account.id,
          evidence: { type: 'carrier_scan', note: typeof body.note === 'string' ? body.note.slice(0, 500) : null },
        });
      } else if (order.kind === 'digital') {
        const deliveryRef = typeof body.deliveryRef === 'string' ? body.deliveryRef.trim() : '';
        if (!deliveryRef) return badRequest(reply, 'deliveryRef is required for a digital delivery');
        await deliverDigital(pool, { orderId: order.id, actorId: req.account.id, deliveryRef });
      } else {
        await deliverCommission(pool, {
          orderId: order.id,
          actorId: req.account.id,
          note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
        });
      }
      return { order: await orderView(pool, await getOrder(pool, order.id)) };
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  // POST /v1/orders/:id/confirm-delivery — buyer, physical: the buyer's
  // own confirmation is delivery evidence (M0, whichever comes first).
  app.post('/v1/orders/:id/confirm-delivery', { preHandler: auth }, async (req, reply) => {
    const order = await orderFor(pool, req, req.params.id, 'buyer');
    if (!order) return notFound(reply);
    try {
      await markDelivered(pool, {
        orderId: order.id,
        actorId: req.account.id,
        evidence: { type: 'buyer_confirmation' },
      });
      return { order: await orderView(pool, await getOrder(pool, order.id)) };
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  // POST /v1/orders/:id/download — buyer, digital: log the download
  // (delivery + a logged download is digital "complete", M0).
  app.post('/v1/orders/:id/download', { preHandler: auth }, async (req, reply) => {
    const order = await orderFor(pool, req, req.params.id, 'buyer');
    if (!order) return notFound(reply);
    try {
      await logDownload(pool, { orderId: order.id, actorId: req.account.id });
      return { order: await orderView(pool, await getOrder(pool, order.id)) };
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  // POST /v1/orders/:id/start — artist, commission: work begins.
  app.post('/v1/orders/:id/start', { preHandler: auth }, async (req, reply) => {
    const order = await orderFor(pool, req, req.params.id, 'artist');
    if (!order) return notFound(reply);
    try {
      await startCommission(pool, { orderId: order.id, actorId: req.account.id });
      return { order: await orderView(pool, await getOrder(pool, order.id)) };
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  // POST /v1/orders/:id/request-revision — buyer, commission.
  app.post('/v1/orders/:id/request-revision', { preHandler: auth }, async (req, reply) => {
    const order = await orderFor(pool, req, req.params.id, 'buyer');
    if (!order) return notFound(reply);
    const body = req.body || {};
    try {
      await requestRevision(pool, {
        orderId: order.id,
        actorId: req.account.id,
        note: typeof body.note === 'string' ? body.note.slice(0, 1000) : null,
      });
      return { order: await orderView(pool, await getOrder(pool, order.id)) };
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  // POST /v1/orders/:id/accept — buyer acceptance (any kind). Accepting
  // also attempts the release in the same motion; the response carries
  // both the order and its release state either way.
  app.post('/v1/orders/:id/accept', { preHandler: auth }, async (req, reply) => {
    const order = await orderFor(pool, req, req.params.id, 'buyer');
    if (!order) return notFound(reply);
    try {
      await acceptFulfillment(pool, { orderId: order.id, actorId: req.account.id, source: 'buyer' });
    } catch (err) {
      return sendErr(reply, err);
    }
    try {
      await evaluateRelease(pool, getStripe(), order.id);
    } catch {
      // The release keeps its blockers on its row and the sweep retries;
      // acceptance itself already landed.
    }
    return { order: await orderView(pool, await getOrder(pool, order.id)) };
  });

  // --- Admin money controls ------------------------------------------------

  // POST /v1/admin/orders/:id/release — manual release / override.
  // A reason is mandatory; with one, the override may pass ONLY the
  // acceptance condition (settlement, delivery evidence and the dispute
  // freeze are never overridden) and writes an audit row (M0).
  app.post(
    '/v1/admin/orders/:id/release',
    { preHandler: [auth, admin] },
    async (req, reply) => {
      const order = await getOrder(pool, req.params.id);
      if (!order) return notFound(reply);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!reason) return badRequest(reply, 'A reason is required for a manual release (it is written to the audit log)');
      try {
        const result = await evaluateRelease(pool, getStripe(), order.id, {
          actorId: req.account.id,
          overrideReason: reason,
        });
        return {
          order: await orderView(pool, await getOrder(pool, order.id)),
          transferred: result.transferred,
          blockers: result.blockers,
        };
      } catch (err) {
        return sendErr(reply, err);
      }
    },
  );

  // POST /v1/admin/orders/:id/mark-lost — ops records a lost parcel
  // (no delivery scan inside the window, M0 edge case).
  app.post(
    '/v1/admin/orders/:id/mark-lost',
    { preHandler: [auth, admin] },
    async (req, reply) => {
      const order = await getOrder(pool, req.params.id);
      if (!order) return notFound(reply);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      try {
        await markLost(pool, { orderId: order.id, actorId: req.account.id, note: reason || null });
        await pool.query(
          `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
           VALUES ($1, 'fulfillment.mark_lost', $2, $3, '{}'::jsonb)`,
          [req.account.id, `order:${order.id}`, reason || null],
        );
        return { order: await orderView(pool, await getOrder(pool, order.id)) };
      } catch (err) {
        return sendErr(reply, err);
      }
    },
  );

  // POST /v1/admin/artists/:accountId/payout-rail — approve/revoke the
  // manual payout rail for an artist (M0 §7 interim cycle). Audited.
  app.post(
    '/v1/admin/artists/:accountId/payout-rail',
    { preHandler: [auth, admin] },
    async (req, reply) => {
      const manualRail = req.body?.manualRail;
      if (typeof manualRail !== 'boolean') return badRequest(reply, 'Body requires manualRail (boolean)');
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!reason) return badRequest(reply, 'A reason is required (it is written to the audit log)');
      const { rows: accounts } = await pool.query('SELECT id FROM accounts WHERE id = $1', [
        req.params.accountId,
      ]);
      if (!accounts.length) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Account not found' } });
      }
      const { rows } = await pool.query(
        `INSERT INTO connect_onboarding (account_id, manual_rail) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET manual_rail = EXCLUDED.manual_rail, updated_at = now()
         RETURNING account_id, stripe_account_id, state, manual_rail`,
        [req.params.accountId, manualRail],
      );
      await pool.query(
        `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
         VALUES ($1, 'artist.payout_rail', $2, $3, $4)`,
        [
          req.account.id,
          `account:${req.params.accountId}`,
          reason,
          JSON.stringify({ manualRail }),
        ],
      );
      const row = rows[0];
      return {
        connect: { state: row.state, stripeAccountId: row.stripe_account_id, manualRail: row.manual_rail },
      };
    },
  );
}
