// Stripe webhook application — runs INSIDE the inbox transaction
// (src/inbox.js), so an event's effects and its processed stamp commit
// together or not at all. Every handler is idempotent: Stripe delivers
// at-least-once and out of order, so each effect is guarded by the state
// it transitions FROM, and every ledger write carries an idempotency key.
//
// Handled: checkout.session.completed · payment_intent.succeeded ·
// checkout.session.expired · charge.dispute.created ·
// charge.dispute.closed · charge.refunded · transfer.paid.
// Anything else — including checkout sessions that are not ours (the
// membership payment links live on the same Stripe account) — is
// recorded and ignored, never errored.
import { transitionInventory } from './inventory.js';
import { appendLedger } from './ledger.js';
import { applyOrderCancel } from './checkout.js';

const TRANSFERRED_STATES = ['created', 'paid', 'manual_recorded'];

async function getOrder(client, orderId) {
  if (!orderId) return null;
  const { rows } = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0] || null;
}

async function findOrderForSession(client, session) {
  const byMeta = await getOrder(client, session?.metadata?.order_id);
  if (byMeta) return byMeta;
  if (!session?.id) return null;
  const { rows } = await client.query(
    'SELECT * FROM orders WHERE stripe_checkout_session_id = $1',
    [session.id],
  );
  return rows[0] || null;
}

async function findPayment(client, { chargeId = null, paymentIntentId = null, orderId = null }) {
  let row = null;
  if (orderId) {
    const { rows } = await client.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
    row = rows[0] || null;
  }
  if (!row && chargeId) {
    const { rows } = await client.query('SELECT * FROM payments WHERE stripe_charge_id = $1', [chargeId]);
    row = rows[0] || null;
  }
  if (!row && paymentIntentId) {
    const { rows } = await client.query(
      'SELECT * FROM payments WHERE stripe_payment_intent_id = $1',
      [paymentIntentId],
    );
    row = rows[0] || null;
  }
  return row;
}

/**
 * Settle an order's payment exactly once. The guarded UPDATE is the
 * gate: a second delivery (the session event AND the payment-intent
 * event both fire for one purchase) matches no row and changes nothing.
 */
async function settlePayment(client, order, { paymentIntentId = null, chargeId = null } = {}) {
  const { rows } = await client.query(
    `UPDATE payments
        SET status = 'succeeded',
            settled_at = COALESCE(settled_at, now()),
            stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
            stripe_charge_id = COALESCE($3, stripe_charge_id),
            updated_at = now()
      WHERE order_id = $1 AND status NOT IN ('succeeded', 'refunded')
      RETURNING *`,
    [order.id, paymentIntentId, chargeId],
  );
  if (!rows.length) {
    // Already settled (the twin event arrived first): still record any
    // Stripe ids this delivery carries, then stop — no second effects.
    await client.query(
      `UPDATE payments
          SET stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $2),
              stripe_charge_id = COALESCE(stripe_charge_id, $3),
              updated_at = now()
        WHERE order_id = $1`,
      [order.id, paymentIntentId, chargeId],
    );
    return false;
  }

  if (order.status === 'canceled' || order.status === 'refunded') {
    // Money arrived for an order that is no longer open — record the
    // exception for ops; the ledger accrual below keeps the money truth.
    await client.query(
      `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
       VALUES (NULL, 'payment.settled_after_close', $1, $2, $3)`,
      [
        `order:${order.id}`,
        `payment settled while order was ${order.status}`,
        JSON.stringify({ paymentIntentId, chargeId }),
      ],
    );
  } else {
    await client.query(
      `UPDATE orders SET status = 'paid', updated_at = now()
        WHERE id = $1 AND status = 'checkout_open'`,
      [order.id],
    );
    if (order.listing_id) {
      const t = await transitionInventory(client, {
        listingId: order.listing_id,
        from: 'reserved',
        to: 'sold',
      });
      if (!t.transitioned && t.currentState === 'available') {
        // The hold lapsed before payment landed; the piece is still
        // unsold, so the paid buyer takes it.
        await transitionInventory(client, {
          listingId: order.listing_id,
          from: 'available',
          to: 'sold',
        });
      }
    }
  }

  await appendLedger(client, {
    orderId: order.id,
    accountId: order.artist_account_id,
    kind: 'sale_accrual',
    amountCents: order.artist_share_cents,
    currency: order.currency,
    stripeObjectId: chargeId || paymentIntentId,
    idempotencyKey: `sale_accrual:${order.id}`,
    meta: { feeRateBps: order.fee_rate_bps, calcVersion: order.fee_calc_version },
  });
  await appendLedger(client, {
    orderId: order.id,
    accountId: null,
    kind: 'platform_fee',
    amountCents: order.platform_share_cents,
    currency: order.currency,
    stripeObjectId: chargeId || paymentIntentId,
    idempotencyKey: `platform_fee:${order.id}`,
  });
  return true;
}

async function openRecoveryCase(client, { order, payment, disputeId, triggerKind }) {
  if (disputeId) {
    await client.query(
      `INSERT INTO recovery_cases (order_id, payment_id, stripe_dispute_id, trigger_kind)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stripe_dispute_id) WHERE stripe_dispute_id IS NOT NULL DO NOTHING`,
      [order.id, payment?.id || null, disputeId, triggerKind],
    );
    return;
  }
  const { rows } = await client.query(
    `SELECT id FROM recovery_cases
      WHERE order_id = $1 AND trigger_kind = $2 AND state IN ('open', 'under_review') LIMIT 1`,
    [order.id, triggerKind],
  );
  if (!rows.length) {
    await client.query(
      `INSERT INTO recovery_cases (order_id, payment_id, trigger_kind) VALUES ($1, $2, $3)`,
      [order.id, payment?.id || null, triggerKind],
    );
  }
}

async function releaseTransferred(client, orderId) {
  const { rows } = await client.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  const release = rows[0];
  return Boolean(release && TRANSFERRED_STATES.includes(release.transfer_state));
}

async function applyDisputeCreated(client, dispute) {
  const payment = await findPayment(client, {
    chargeId: dispute.charge || null,
    paymentIntentId: dispute.payment_intent || null,
  });
  if (!payment) return;
  const { rows } = await client.query(
    `UPDATE payments
        SET dispute_state = 'open', stripe_dispute_id = $2, updated_at = now()
      WHERE id = $1 AND dispute_state = 'none'
      RETURNING *`,
    [payment.id, dispute.id],
  );
  if (!rows.length) return; // already recorded — duplicate delivery
  const order = await getOrder(client, payment.order_id);
  if (!order) return;
  if (await releaseTransferred(client, order.id)) {
    // Post-transfer: a recovery CASE, never an automatic clawback (M0).
    await openRecoveryCase(client, { order, payment, disputeId: dispute.id, triggerKind: 'dispute' });
  } else {
    // Pre-release: freeze THIS order's leg only.
    await client.query(
      `UPDATE releases SET state = 'blocked_dispute', updated_at = now()
        WHERE order_id = $1 AND state IN ('awaiting_conditions', 'ready')`,
      [order.id],
    );
  }
}

async function applyDisputeClosed(client, dispute) {
  const payment = await findPayment(client, {
    chargeId: dispute.charge || null,
    paymentIntentId: dispute.payment_intent || null,
  });
  if (!payment || payment.dispute_state !== 'open') return;
  const won = dispute.status === 'won';
  await client.query(
    `UPDATE payments SET dispute_state = $2, updated_at = now() WHERE id = $1`,
    [payment.id, won ? 'won' : 'lost'],
  );
  const order = await getOrder(client, payment.order_id);
  if (!order) return;
  if (won) {
    await client.query(
      `UPDATE releases SET state = 'awaiting_conditions', updated_at = now()
        WHERE order_id = $1 AND state = 'blocked_dispute'`,
      [order.id],
    );
    return;
  }
  // Lost: Stripe has pulled the funds back. Pre-transfer that is a
  // refund outcome; post-transfer it joins the recovery case.
  if (await releaseTransferred(client, order.id)) {
    await openRecoveryCase(client, { order, payment, disputeId: dispute.id, triggerKind: 'dispute' });
  } else {
    await client.query(
      `UPDATE orders SET status = 'refunded', updated_at = now()
        WHERE id = $1 AND status NOT IN ('refunded', 'canceled')`,
      [order.id],
    );
    await appendLedger(client, {
      orderId: order.id,
      accountId: order.buyer_account_id,
      kind: 'refund',
      amountCents: Number.isInteger(dispute.amount) ? dispute.amount : order.price_cents,
      currency: order.currency,
      stripeObjectId: dispute.id,
      idempotencyKey: `dispute_lost:${dispute.id}`,
      meta: { reason: dispute.reason || null },
    });
  }
}

async function applyChargeRefunded(client, charge) {
  const payment = await findPayment(client, {
    chargeId: charge.id || null,
    paymentIntentId: charge.payment_intent || null,
  });
  if (!payment) return;
  const refunded = Number.isInteger(charge.amount_refunded) ? charge.amount_refunded : 0;
  if (refunded <= 0 || refunded === payment.refunded_cents) return;
  const full = refunded >= payment.amount_cents;
  await client.query(
    `UPDATE payments
        SET refunded_cents = $2,
            status = CASE WHEN $3 THEN 'refunded' ELSE 'partially_refunded' END,
            updated_at = now()
      WHERE id = $1`,
    [payment.id, refunded, full],
  );
  await appendLedger(client, {
    orderId: payment.order_id,
    accountId: null,
    kind: 'refund',
    amountCents: refunded - payment.refunded_cents,
    currency: payment.currency,
    stripeObjectId: charge.id,
    idempotencyKey: `refund:${charge.id}:${refunded}`,
    meta: { totalRefundedCents: refunded },
  });
  if (!full) return;
  const order = await getOrder(client, payment.order_id);
  if (!order) return;
  if (await releaseTransferred(client, order.id)) {
    await openRecoveryCase(client, { order, payment, disputeId: null, triggerKind: 'refund' });
  } else {
    await client.query(
      `UPDATE orders SET status = 'refunded', updated_at = now()
        WHERE id = $1 AND status NOT IN ('refunded', 'canceled')`,
      [order.id],
    );
  }
}

/** Apply one Stripe event inside the caller's transaction. */
export async function applyStripeEvent(client, event) {
  const obj = event?.data?.object || {};
  switch (event?.type) {
    case 'checkout.session.completed': {
      const order = await findOrderForSession(client, obj);
      if (!order) return; // not an engine checkout (e.g. a membership link)
      await settlePayment(client, order, { paymentIntentId: obj.payment_intent || null });
      return;
    }
    case 'payment_intent.succeeded': {
      let order = await getOrder(client, obj.metadata?.order_id);
      if (!order) {
        const payment = await findPayment(client, { paymentIntentId: obj.id });
        if (payment) order = await getOrder(client, payment.order_id);
      }
      if (!order) return;
      await settlePayment(client, order, {
        paymentIntentId: obj.id,
        chargeId: typeof obj.latest_charge === 'string' ? obj.latest_charge : null,
      });
      return;
    }
    case 'checkout.session.expired': {
      const order = await findOrderForSession(client, obj);
      if (!order || order.status !== 'checkout_open') return;
      await applyOrderCancel(client, order);
      return;
    }
    case 'charge.dispute.created':
      await applyDisputeCreated(client, obj);
      return;
    case 'charge.dispute.closed':
      await applyDisputeClosed(client, obj);
      return;
    case 'charge.refunded':
      await applyChargeRefunded(client, obj);
      return;
    case 'transfer.paid': {
      // The TRANSFER leg only. Bank payout state is a separate status and
      // is never advanced from a transfer event (M0).
      await client.query(
        `UPDATE releases SET transfer_state = 'paid', updated_at = now()
          WHERE stripe_transfer_id = $1 AND transfer_state = 'created'`,
        [obj.id],
      );
      return;
    }
    default:
      return; // recorded in the inbox; nothing to apply
  }
}
