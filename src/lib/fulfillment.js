// Fulfillment — DISTINCT state machines per kind (M0) over the shared
// financial core. "Complete" is defined per type:
//
//   physical   awaiting_shipment → shipped → delivered → accepted
//              complete on carrier delivery scan OR buyer confirmation,
//              whichever first; then the 7-day acceptance window runs.
//   digital    awaiting_delivery → delivered → accepted
//              complete on file delivery + download access logged.
//   commission awaiting_start → in_progress → delivered ⇄ revision_requested
//              → accepted; complete on buyer acceptance or window expiry.
//
// Acceptance is ONE transition with two sources: the buyer's act, or the
// disclosed 7-day window expiring (sweepAcceptanceWindows). Every
// transition is a guarded, locked update and leaves an evidence event —
// the release engine reads delivery evidence from here, never from a
// display.
export const ACCEPTANCE_WINDOW_DAYS = 7;

const FLOWS = Object.freeze({
  physical: Object.freeze({
    initial: 'awaiting_shipment',
    allowed: Object.freeze({
      awaiting_shipment: Object.freeze(['shipped', 'canceled']),
      shipped: Object.freeze(['delivered', 'lost']),
      delivered: Object.freeze(['accepted', 'returned']),
      accepted: Object.freeze([]),
      lost: Object.freeze([]),
      returned: Object.freeze([]),
      canceled: Object.freeze([]),
    }),
  }),
  digital: Object.freeze({
    initial: 'awaiting_delivery',
    allowed: Object.freeze({
      awaiting_delivery: Object.freeze(['delivered', 'canceled']),
      delivered: Object.freeze(['accepted']),
      accepted: Object.freeze([]),
      canceled: Object.freeze([]),
    }),
  }),
  commission: Object.freeze({
    initial: 'awaiting_start',
    allowed: Object.freeze({
      awaiting_start: Object.freeze(['in_progress', 'canceled']),
      in_progress: Object.freeze(['delivered']),
      delivered: Object.freeze(['accepted', 'revision_requested']),
      revision_requested: Object.freeze(['delivered']),
      accepted: Object.freeze([]),
      canceled: Object.freeze([]),
    }),
  }),
});

export function initialFulfillmentState(kind) {
  const flow = FLOWS[kind];
  if (!flow) throw new Error(`unknown fulfillment kind: ${kind}`);
  return flow.initial;
}

export function fulfillmentCanTransition(kind, from, to) {
  return Boolean(FLOWS[kind]?.allowed[from]?.includes(to));
}

const ORDER_RANK = Object.freeze({
  checkout_open: 0,
  paid: 1,
  fulfilling: 2,
  delivered: 3,
  accepted: 4,
  released: 5,
  completed: 6,
});
const ORDER_MIRROR = Object.freeze({
  shipped: 'fulfilling',
  in_progress: 'fulfilling',
  delivered: 'delivered',
  accepted: 'accepted',
  canceled: 'canceled',
});

function transitionError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = code === 'not_found' ? 404 : 409;
  return err;
}

/**
 * Core transition: lock the fulfillment + order, validate against the
 * kind's state machine, apply field updates, record the evidence event,
 * and mirror the order status forward. `fields` is a column→value map
 * applied to fulfillments alongside the state change.
 */
export async function transitionFulfillment(
  pool,
  { orderId, to, actorId = null, event, fields = {}, meta = {} },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM fulfillments WHERE order_id = $1 FOR UPDATE', [
      orderId,
    ]);
    const fulfillment = rows[0];
    if (!fulfillment) throw transitionError('not_found', 'Fulfillment not found for this order');
    if (!fulfillmentCanTransition(fulfillment.kind, fulfillment.state, to)) {
      throw transitionError(
        'invalid_transition',
        `A ${fulfillment.kind} fulfillment cannot move from ${fulfillment.state} to ${to}`,
      );
    }
    const cols = ['state = $1', 'updated_at = now()'];
    const params = [to];
    for (const [col, value] of Object.entries(fields)) {
      params.push(value);
      cols.push(`${col} = $${params.length}`);
    }
    params.push(orderId);
    const { rows: updated } = await client.query(
      `UPDATE fulfillments SET ${cols.join(', ')} WHERE order_id = $${params.length} RETURNING *`,
      params,
    );
    await client.query(
      `INSERT INTO fulfillment_events (fulfillment_id, event, actor_account_id, meta)
       VALUES ($1, $2, $3, $4)`,
      [fulfillment.id, event || to, actorId, JSON.stringify(meta)],
    );
    const mirror = ORDER_MIRROR[to];
    if (mirror) {
      const { rows: orows } = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [
        orderId,
      ]);
      const current = orows[0]?.status;
      if (current && !(current in { canceled: 1, refunded: 1 })) {
        if (mirror === 'canceled' || (ORDER_RANK[mirror] ?? 0) > (ORDER_RANK[current] ?? 0)) {
          await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [
            mirror,
            orderId,
          ]);
        }
      }
    }
    await client.query('COMMIT');
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function deliveredFields(evidence) {
  const now = new Date();
  const due = new Date(now.getTime() + ACCEPTANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    delivered_at: now,
    acceptance_due_at: due,
    delivery_evidence: JSON.stringify(evidence),
  };
}

/** Physical: the artist ships, with carrier + tracking (M0 obligation). */
export async function shipFulfillment(pool, { orderId, actorId, carrier, trackingNumber }) {
  return transitionFulfillment(pool, {
    orderId,
    to: 'shipped',
    actorId,
    event: 'shipped',
    fields: {
      carrier: carrier || null,
      tracking_number: trackingNumber || null,
      shipped_at: new Date(),
    },
    meta: { carrier: carrier || null, trackingNumber: trackingNumber || null },
  });
}

/**
 * Physical: delivery evidence lands — a carrier delivery scan or the
 * buyer's own confirmation, whichever comes first (M0). Starts the
 * 7-day acceptance window.
 */
export async function markDelivered(pool, { orderId, actorId, evidence }) {
  const ev = evidence && typeof evidence === 'object' ? evidence : { type: 'carrier_scan' };
  return transitionFulfillment(pool, {
    orderId,
    to: 'delivered',
    actorId,
    event: 'delivered',
    fields: deliveredFields(ev),
    meta: { evidence: ev },
  });
}

/** Digital: the artist delivers the file (a storage reference). */
export async function deliverDigital(pool, { orderId, actorId, deliveryRef }) {
  const ev = { type: 'file_delivery', ref: deliveryRef || null };
  return transitionFulfillment(pool, {
    orderId,
    to: 'delivered',
    actorId,
    event: 'delivered',
    fields: { ...deliveredFields(ev), delivery_ref: deliveryRef || null },
    meta: { evidence: ev },
  });
}

/**
 * Digital: a buyer download is logged. Delivery + a logged download is
 * what "complete" means for digital goods (M0) — the release engine
 * reads downloads > 0 as the second half of the evidence.
 */
export async function logDownload(pool, { orderId, actorId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM fulfillments WHERE order_id = $1 FOR UPDATE', [
      orderId,
    ]);
    const fulfillment = rows[0];
    if (!fulfillment) throw transitionError('not_found', 'Fulfillment not found for this order');
    if (fulfillment.kind !== 'digital' || fulfillment.state !== 'delivered') {
      throw transitionError(
        'invalid_transition',
        'Downloads can only be logged on a delivered digital fulfillment',
      );
    }
    const { rows: updated } = await client.query(
      `UPDATE fulfillments
          SET downloads = downloads + 1, last_download_at = now(), updated_at = now()
        WHERE order_id = $1 RETURNING *`,
      [orderId],
    );
    await client.query(
      `INSERT INTO fulfillment_events (fulfillment_id, event, actor_account_id, meta)
       VALUES ($1, 'download', $2, $3)`,
      [fulfillment.id, actorId, JSON.stringify({ downloads: updated[0].downloads })],
    );
    await client.query('COMMIT');
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Commission: the artist begins work. */
export async function startCommission(pool, { orderId, actorId }) {
  return transitionFulfillment(pool, { orderId, to: 'in_progress', actorId, event: 'started' });
}

/** Commission: the artist delivers the work (starts the window). */
export async function deliverCommission(pool, { orderId, actorId, note }) {
  const ev = { type: 'commission_delivery', note: note || null };
  return transitionFulfillment(pool, {
    orderId,
    to: 'delivered',
    actorId,
    event: 'delivered',
    fields: deliveredFields(ev),
    meta: { evidence: ev },
  });
}

/** Commission: the buyer asks for a revision inside the window. */
export async function requestRevision(pool, { orderId, actorId, note }) {
  return transitionFulfillment(pool, {
    orderId,
    to: 'revision_requested',
    actorId,
    event: 'revision_requested',
    meta: { note: note || null },
  });
}

/** Physical: the parcel is declared lost (no delivery scan — M0 edge). */
export async function markLost(pool, { orderId, actorId, note }) {
  return transitionFulfillment(pool, {
    orderId,
    to: 'lost',
    actorId,
    event: 'lost',
    meta: { note: note || null },
  });
}

/**
 * Acceptance — the buyer's act (source 'buyer') or the window's expiry
 * (source 'window', via the sweep). One transition, two sources (M0).
 */
export async function acceptFulfillment(pool, { orderId, actorId, source }) {
  if (source !== 'buyer' && source !== 'window') {
    throw new Error("acceptFulfillment: source must be 'buyer' or 'window'");
  }
  return transitionFulfillment(pool, {
    orderId,
    to: 'accepted',
    actorId,
    event: 'accepted',
    fields: { accepted_at: new Date(), acceptance_source: source },
    meta: { source },
  });
}

/**
 * Expire acceptance windows: every delivered fulfillment whose 7 days
 * have run without a claim is accepted by the window. Returns the order
 * ids accepted by this sweep (the caller attempts their releases).
 */
export async function sweepAcceptanceWindows(pool) {
  const { rows } = await pool.query(
    `SELECT order_id FROM fulfillments
      WHERE state = 'delivered' AND acceptance_due_at IS NOT NULL
        AND acceptance_due_at <= now()
      ORDER BY acceptance_due_at ASC`,
  );
  const accepted = [];
  for (const row of rows) {
    try {
      await acceptFulfillment(pool, { orderId: row.order_id, actorId: null, source: 'window' });
      accepted.push(row.order_id);
    } catch {
      // Raced with a buyer action — the window no longer needs to act.
    }
  }
  return accepted;
}
