// Stripe webhook application — runs INSIDE the inbox transaction
// (src/inbox.js), so an event's effects and its processed stamp commit
// together or not at all. Every handler is idempotent: Stripe delivers
// at-least-once and out of order, so each effect is guarded by the state
// it transitions FROM, and every ledger write carries an idempotency key.
//
// Handled: checkout.session.completed · payment_intent.succeeded ·
// checkout.session.expired · checkout.session.async_payment_succeeded ·
// checkout.session.async_payment_failed · charge.dispute.created ·
// charge.dispute.closed · charge.refunded · transfer.created ·
// transfer.paid (retired by Stripe; kept for back-compat) ·
// transfer.reversed · transfer.updated (explicitly ignored).
// Anything else — including checkout sessions that are not ours (the
// membership payment links live on the same Stripe account) — is
// recorded and ignored, never errored.
//
// SND-03 (verified payment before delivery): a COMPLETED checkout
// session is not a successful payment. Delayed payment methods finish
// checkout with payment_status 'unpaid' and settle (or fail) later via
// the async events. Entitlement — settlement, delivery, the buyer's
// shelf — therefore follows the money: session.completed settles only
// when the session itself reports the payment captured ('paid' /
// 'no_payment_required'); an 'unpaid' completion records the payment
// intent and waits. payment_intent.succeeded settles on its own (the
// event IS the verified payment).
import { transitionInventory } from './inventory.js';
import { appendLedger } from './ledger.js';
import { applyOrderCancel } from './checkout.js';
import { sessionTaxCents } from './tax.js';

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
 *
 * TAX (§3, TAX-04): settlement math reads ONLY the order record — the
 * ledger accruals below are the order's immutable fee snapshot, never
 * a charged total. `taxCents` (the tax Stripe collected, from the
 * session's total_details.amount_tax) is RECORDED on the payment for
 * reconciliation; it is never an input to any split. The session
 * events carry it; the payment-intent event does not, so whichever
 * session delivery lands records it (COALESCE keeps the first value).
 */
async function settlePayment(
  client,
  order,
  { paymentIntentId = null, chargeId = null, taxCents = null } = {},
) {
  const { rows } = await client.query(
    `UPDATE payments
        SET status = 'succeeded',
            settled_at = COALESCE(settled_at, now()),
            stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
            stripe_charge_id = COALESCE($3, stripe_charge_id),
            tax_cents = COALESCE($4, tax_cents),
            updated_at = now()
      WHERE order_id = $1 AND status NOT IN ('succeeded', 'refunded')
      RETURNING *`,
    [order.id, paymentIntentId, chargeId, taxCents],
  );
  if (!rows.length) {
    // Already settled (the twin event arrived first): still record any
    // Stripe ids — and the tax figure — this delivery carries, then
    // stop: no second effects.
    await client.query(
      `UPDATE payments
          SET stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $2),
              stripe_charge_id = COALESCE(stripe_charge_id, $3),
              tax_cents = COALESCE(tax_cents, $4),
              updated_at = now()
        WHERE order_id = $1`,
      [order.id, paymentIntentId, chargeId, taxCents],
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
      const { rows: lrows } = await client.query('SELECT medium FROM listings WHERE id = $1', [
        order.listing_id,
      ]);
      const isMusic = lrows[0]?.medium === 'music';
      if (!isMusic) {
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
      } else {
        // MUSIC: the release is not one-of-one — settlement never marks
        // it sold, and delivery is instant by construction: the master
        // files were attached to the listing before it could publish,
        // so a settled payment IS the delivery event. The fulfillment
        // moves to 'delivered' here (acceptance window starts), and
        // the buyer's shelf unlocks from this order's payment record.
        const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const { rows: frows } = await client.query(
          `UPDATE fulfillments
              SET state = 'delivered', delivered_at = now(), acceptance_due_at = $2,
                  delivery_ref = $3,
                  delivery_evidence = $4,
                  updated_at = now()
            WHERE order_id = $1 AND state = 'awaiting_delivery'
            RETURNING id`,
          [
            order.id,
            due,
            `listing:${order.listing_id}`,
            JSON.stringify({ type: 'file_delivery', ref: `listing:${order.listing_id}`, via: 'settlement' }),
          ],
        );
        if (frows.length) {
          await client.query(
            `INSERT INTO fulfillment_events (fulfillment_id, event, actor_account_id, meta)
             VALUES ($1, 'delivered', NULL, $2)`,
            [frows[0].id, JSON.stringify({ via: 'settlement', kind: 'music' })],
          );
          await client.query(
            `UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1 AND status = 'paid'`,
            [order.id],
          );
        }
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

async function applyTransferReversed(client, transfer) {
  // Stripe pulled a transfer back out of the artist's Connect balance.
  // The guarded UPDATE is the whole idempotency story: a redelivery (or
  // a transfer that was never ours) matches no row and changes nothing.
  const { rows } = await client.query(
    `UPDATE releases SET transfer_state = 'reversed', updated_at = now()
      WHERE stripe_transfer_id = $1 AND transfer_state IN ('created', 'paid')
      RETURNING *`,
    [transfer.id],
  );
  if (!rows.length) return;
  const release = rows[0];
  const order = await getOrder(client, release.order_id);
  const amountReversedCents = Number.isInteger(transfer.amount_reversed)
    ? transfer.amount_reversed
    : Number.isInteger(transfer.amount)
      ? transfer.amount
      : null;
  await client.query(
    `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
     VALUES (NULL, 'transfer.reversed', $1, $2, $3)`,
    [
      `order:${release.order_id}`,
      'stripe reversed the transfer behind a release',
      JSON.stringify({ stripeTransferId: transfer.id, amountReversedCents }),
    ],
  );
  // The same exception reconciliation raises for this exact condition
  // (reconcile.js, kind 'transfer_reversed_after_release'), keyed the
  // same way, so the webhook and the reconcile job dedupe onto ONE
  // open exception instead of piling up two. No recovery case: unlike
  // a post-transfer dispute, the reversal IS Stripe's own clawback —
  // the funds are already back; what a human must decide is why it
  // happened and whether the artist was already paid out against it.
  await client.query(
    `INSERT INTO exception_queue (kind, order_id, account_id, stripe_object_id, detail, dedupe_key)
     VALUES ('transfer_reversed_after_release', $1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET detail = EXCLUDED.detail, updated_at = now()
       WHERE exception_queue.state = 'open'`,
    [
      release.order_id,
      order?.artist_account_id || null,
      transfer.id,
      JSON.stringify({ amountReversedCents, transferState: 'reversed', via: 'webhook' }),
      `transfer_reversed_after_release:${transfer.id}`,
    ],
  );
}

/** Apply one Stripe event inside the caller's transaction. */
export async function applyStripeEvent(client, event) {
  const obj = event?.data?.object || {};
  switch (event?.type) {
    case 'checkout.session.completed': {
      const order = await findOrderForSession(client, obj);
      if (!order) return; // not an engine checkout (e.g. a membership link)
      if (obj.payment_status === 'unpaid') {
        // Checkout finished but the money has NOT landed (delayed
        // payment method). Record the intent so the async outcome
        // events resolve to this order, and grant NOTHING: no
        // settlement, no delivery, no shelf (SND-03).
        if (obj.payment_intent) {
          await client.query(
            `UPDATE payments
                SET stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $2),
                    updated_at = now()
              WHERE order_id = $1`,
            [order.id, obj.payment_intent],
          );
        }
        await client.query(
          `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
           VALUES (NULL, 'payment.async_pending', $1, $2, $3)`,
          [
            `order:${order.id}`,
            'checkout completed with payment_status unpaid — entitlement waits for the payment',
            JSON.stringify({ sessionId: obj.id || null, paymentIntentId: obj.payment_intent || null }),
          ],
        );
        return;
      }
      await settlePayment(client, order, {
        paymentIntentId: obj.payment_intent || null,
        taxCents: sessionTaxCents(obj),
      });
      return;
    }
    case 'checkout.session.async_payment_succeeded': {
      // The delayed payment landed — NOW the order settles.
      const order = await findOrderForSession(client, obj);
      if (!order) return;
      await settlePayment(client, order, {
        paymentIntentId: obj.payment_intent || null,
        taxCents: sessionTaxCents(obj),
      });
      return;
    }
    case 'checkout.session.async_payment_failed': {
      // The delayed payment failed: nothing was granted, and the open
      // checkout closes exactly like an expired session.
      const order = await findOrderForSession(client, obj);
      if (!order || order.status !== 'checkout_open') return;
      await applyOrderCancel(client, order);
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
    case 'transfer.created':
    case 'transfer.paid': {
      // The TRANSFER leg only. transfer.paid is retired in current API
      // versions; transfer.created is its successor — a created transfer
      // is the completed movement into the destination's balance. (Our
      // own release flow records the transfer id synchronously when it
      // creates the transfer, so this event confirms it after the fact.)
      // Bank payout state is a separate status and is never advanced
      // from a transfer event (M0).
      await client.query(
        `UPDATE releases SET transfer_state = 'paid', updated_at = now()
          WHERE stripe_transfer_id = $1 AND transfer_state = 'created'`,
        [obj.id],
      );
      return;
    }
    case 'transfer.reversed':
      await applyTransferReversed(client, obj);
      return;
    case 'transfer.updated':
      // Informational only (amount/metadata edits on the transfer):
      // recorded in the inbox, deliberately no state effect — transfer
      // state advances on transfer.created and transfer.reversed.
      return;
    default:
      return; // recorded in the inbox; nothing to apply
  }
}
