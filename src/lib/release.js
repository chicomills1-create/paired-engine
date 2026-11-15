// The release engine (M0 §RELEASE) — the only path that moves money to
// an artist. A transfer fires when ALL of these hold:
//
//   · payment settled (the payment record is succeeded + settled_at set)
//   · delivery evidence present (fulfillment delivered; for digital, a
//     logged download or the buyer's acceptance completes the evidence)
//   · buyer accepted OR the disclosed 7-day window expired (an expired
//     window is converted to acceptance here, source 'window')
//   · no active dispute on the order's payment
//   · a payout path: Connect state 'active' (Stripe rail) or the manual
//     rail approved for the artist (M0 §7 interim cycle)
//
// One transfer per order, ever: the release row's idempotency_key is the
// Stripe idempotency key AND the ledger key, and a release that already
// transferred returns its record instead of transferring again.
//
// TRANSFER and PAYOUT are separate statuses (M0): transfer_state tracks
// platform → connected account; payout_state tracks connected account →
// bank and only advances on attributable payout evidence (M6
// reconciliation) — it is never guessed from the transfer.
//
// Manual override (M0): an admin may release early ONLY past the
// acceptance condition — settlement, delivery evidence and the dispute
// freeze are never overridden — and only with a reason, written to the
// audit log in the same transaction.
import { appendLedger } from './ledger.js';
import { expireStaleReservations } from './checkout.js';
import { sweepAcceptanceWindows } from './fulfillment.js';

export async function getOrCreateRelease(db, orderId) {
  await db.query(
    `INSERT INTO releases (order_id, idempotency_key) VALUES ($1, $2)
     ON CONFLICT (order_id) DO NOTHING`,
    [orderId, `transfer:${orderId}`],
  );
  const { rows } = await db.query('SELECT * FROM releases WHERE order_id = $1', [orderId]);
  return rows[0];
}

const TRANSFERRED_STATES = ['created', 'paid', 'manual_recorded'];

export async function evaluateRelease(pool, stripe, orderId, { actorId = null, overrideReason = null } = {}) {
  const client = await pool.connect();
  let plan;
  try {
    await client.query('BEGIN');
    const { rows: orows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = orows[0];
    if (!order) {
      const err = new Error('Order not found');
      err.code = 'not_found';
      err.statusCode = 404;
      throw err;
    }
    await getOrCreateRelease(client, orderId);
    const { rows: rrows } = await client.query('SELECT * FROM releases WHERE order_id = $1 FOR UPDATE', [orderId]);
    const release = rrows[0];
    const { rows: prows } = await client.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
    const payment = prows[0] || null;
    const { rows: frows } = await client.query('SELECT * FROM fulfillments WHERE order_id = $1', [orderId]);
    const fulfillment = frows[0] || null;
    const { rows: crows } = await client.query(
      'SELECT state, manual_rail, stripe_account_id FROM connect_onboarding WHERE account_id = $1',
      [order.artist_account_id],
    );
    const connect = crows[0] || { state: 'not_started', manual_rail: false, stripe_account_id: null };

    if (TRANSFERRED_STATES.includes(release.transfer_state)) {
      await client.query('COMMIT');
      return { release, transferred: true, blockers: [] };
    }
    if (order.status === 'canceled' || order.status === 'refunded') {
      await client.query('COMMIT');
      return { release, transferred: false, blockers: [`order_${order.status}`] };
    }

    // An expired acceptance window IS acceptance (M0) — convert it here
    // so the condition below reads one state.
    let state = fulfillment?.state || null;
    if (
      fulfillment &&
      state === 'delivered' &&
      fulfillment.acceptance_due_at &&
      new Date(fulfillment.acceptance_due_at) <= new Date()
    ) {
      await client.query(
        `UPDATE fulfillments
            SET state = 'accepted', accepted_at = now(), acceptance_source = 'window', updated_at = now()
          WHERE order_id = $1`,
        [orderId],
      );
      await client.query(
        `INSERT INTO fulfillment_events (fulfillment_id, event, actor_account_id, meta)
         VALUES ($1, 'accepted', NULL, $2)`,
        [fulfillment.id, JSON.stringify({ source: 'window', via: 'release_engine' })],
      );
      await client.query(
        `UPDATE orders SET status = 'accepted', updated_at = now()
          WHERE id = $1 AND status IN ('paid', 'fulfilling', 'delivered')`,
        [orderId],
      );
      state = 'accepted';
    }

    const paymentSettled = Boolean(payment && payment.status === 'succeeded' && payment.settled_at);
    const deliveryEvidence = Boolean(
      fulfillment &&
        fulfillment.delivered_at &&
        (fulfillment.kind !== 'digital' || fulfillment.downloads > 0 || state === 'accepted'),
    );
    let acceptedOrWindow = state === 'accepted';
    const noDispute = Boolean(payment) && payment.dispute_state !== 'open';
    const rail =
      connect.state === 'active' && connect.stripe_account_id
        ? 'stripe'
        : connect.manual_rail === true
          ? 'manual'
          : null;

    const overriding = Boolean(overrideReason && actorId);
    if (overriding && deliveryEvidence && paymentSettled && noDispute) {
      acceptedOrWindow = true;
    }

    const blockers = [];
    if (!paymentSettled) blockers.push('payment_not_settled');
    if (!deliveryEvidence) blockers.push('delivery_evidence_missing');
    if (!acceptedOrWindow) blockers.push('not_accepted');
    if (!noDispute) blockers.push('dispute_open');
    if (!rail) blockers.push('payout_path_missing');

    if (blockers.length) {
      const nextState =
        payment && payment.dispute_state === 'open' ? 'blocked_dispute' : 'awaiting_conditions';
      const { rows: updated } = await client.query(
        `UPDATE releases SET state = $1, blockers = $2, updated_at = now()
          WHERE order_id = $3 RETURNING *`,
        [nextState, JSON.stringify(blockers), orderId],
      );
      await client.query('COMMIT');
      return { release: updated[0], transferred: false, blockers };
    }

    if (overriding) {
      await client.query(
        `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
         VALUES ($1, 'release.override', $2, $3, $4)`,
        [
          actorId,
          `order:${orderId}`,
          String(overrideReason).slice(0, 1000),
          JSON.stringify({ artistAccountId: order.artist_account_id, amountCents: order.artist_share_cents }),
        ],
      );
    }

    if (rail === 'manual') {
      // The interim cycle (M0 §7): the release is recorded now; the Friday
      // batch pays it outside Stripe. The ledger entry IS the payout
      // instruction, keyed so it can never be recorded twice.
      await appendLedger(client, {
        orderId,
        accountId: order.artist_account_id,
        kind: 'transfer',
        amountCents: order.artist_share_cents,
        currency: order.currency,
        idempotencyKey: `transfer:${orderId}`,
        meta: { rail: 'manual' },
      });
      const { rows: updated } = await client.query(
        `UPDATE releases
            SET state = 'transfer_created', transfer_state = 'manual_recorded',
                rail = 'manual', blockers = '[]'::jsonb,
                released_by = $1, override_reason = $2, updated_at = now()
          WHERE order_id = $3 RETURNING *`,
        [actorId, overriding ? String(overrideReason).slice(0, 1000) : null, orderId],
      );
      await client.query(
        `UPDATE orders SET status = 'released', updated_at = now() WHERE id = $1`,
        [orderId],
      );
      await client.query('COMMIT');
      return { release: updated[0], transferred: true, blockers: [] };
    }

    // Stripe rail: mark ready and commit BEFORE the external call, so a
    // crash never leaves a transfer without its record.
    const { rows: ready } = await client.query(
      `UPDATE releases
          SET state = 'ready', rail = 'stripe', blockers = '[]'::jsonb,
              destination_account_id = $1,
              released_by = $2, override_reason = $3, updated_at = now()
        WHERE order_id = $4 RETURNING *`,
      [
        connect.stripe_account_id,
        actorId,
        overriding ? String(overrideReason).slice(0, 1000) : null,
        orderId,
      ],
    );
    await client.query('COMMIT');
    plan = {
      release: ready[0],
      order,
      payment,
      destination: connect.stripe_account_id,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!stripe) {
    const { rows } = await pool.query(
      `UPDATE releases SET blockers = $1, updated_at = now() WHERE order_id = $2 RETURNING *`,
      [JSON.stringify(['stripe_not_configured']), orderId],
    );
    return { release: rows[0], transferred: false, blockers: ['stripe_not_configured'] };
  }

  let transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: plan.order.artist_share_cents,
        currency: String(plan.order.currency || 'USD').toLowerCase(),
        destination: plan.destination,
        transfer_group: `order_${orderId}`,
        source_transaction: plan.payment?.stripe_charge_id || undefined,
        metadata: { order_id: orderId, paired_artist_account_id: plan.order.artist_account_id },
      },
      { idempotencyKey: plan.release.idempotency_key },
    );
  } catch (err) {
    const { rows } = await pool.query(
      `UPDATE releases
          SET state = 'failed', transfer_state = 'failed', blockers = $1, updated_at = now()
        WHERE order_id = $2 RETURNING *`,
      [JSON.stringify([`transfer_failed:${String(err.message || err).slice(0, 200)}`]), orderId],
    );
    return { release: rows[0], transferred: false, blockers: rows[0].blockers };
  }

  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');
    await appendLedger(client2, {
      orderId,
      accountId: plan.order.artist_account_id,
      kind: 'transfer',
      amountCents: plan.order.artist_share_cents,
      currency: plan.order.currency,
      stripeObjectId: transfer.id,
      idempotencyKey: `transfer:${orderId}`,
      meta: { rail: 'stripe' },
    });
    const { rows: updated } = await client2.query(
      `UPDATE releases
          SET state = 'transfer_created',
              transfer_state = $1,
              payout_state = 'pending',
              stripe_transfer_id = $2,
              updated_at = now()
        WHERE order_id = $3 RETURNING *`,
      [transfer.status === 'paid' ? 'paid' : 'created', transfer.id, orderId],
    );
    await client2.query(
      `UPDATE orders SET status = 'released', updated_at = now() WHERE id = $1`,
      [orderId],
    );
    await client2.query('COMMIT');
    return { release: updated[0], transferred: true, blockers: [] };
  } catch (err) {
    await client2.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client2.release();
  }
}

/**
 * The periodic commerce sweep (worker + server interval): release lapsed
 * checkout reservations, convert expired acceptance windows, and attempt
 * every release whose order has been accepted. Idempotent throughout —
 * safe at any cadence, safe to run twice.
 */
export async function runCommerceSweeps(pool, stripe) {
  const expiredReservations = await expireStaleReservations(pool);
  const acceptedOrderIds = await sweepAcceptanceWindows(pool);
  const { rows } = await pool.query(
    `SELECT o.id FROM orders o
       JOIN releases r ON r.order_id = o.id
      WHERE o.status = 'accepted' AND r.transfer_state = 'not_started'`,
  );
  let transfersCompleted = 0;
  for (const row of rows) {
    try {
      const res = await evaluateRelease(pool, stripe, row.id);
      if (res.transferred) transfersCompleted++;
    } catch {
      // A failed evaluation keeps its blockers on the release row; the
      // next sweep retries. Nothing vanishes silently.
    }
  }
  return {
    expiredReservations,
    windowsAccepted: acceptedOrderIds.length,
    releasesAttempted: rows.length,
    transfersCompleted,
  };
}
