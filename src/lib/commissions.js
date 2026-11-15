// Commission checkout (M4) — accepting a pitch creates the commission
// order through the SAME machinery as a listing checkout (M3): the same
// fee snapshot (src/lib/fees.js), the same four records (Order / Payment /
// Fulfillment / Release), the same Stripe session pattern with
// compensation on failure, and the same release engine downstream
// (src/lib/release.js reads orders generically — commissions are never a
// fork).
//
// The door is re-checked server-side at acceptance, against live state:
//   1. brief_open               — the brief is still open
//   2. pitch_pending            — this pitch is still pending
//   3. artist_verified          — the pitching artist holds a verified
//                                 human-made record (M2)
//   4. artist_payout_path_live  — Connect 'active' OR the manual rail
//   5. price_above_zero         — the pitch carries a real price
//   6. no_open_dispute_freeze   — no OPEN dispute on a prior order
//                                 between this buyer and this artist
// (buyer ≠ artist is structural: a brief's owner can never pitch it, and
// the accept route resolves the buyer from the brief, never the body.)
//
// WITHOUT STRIPE CONFIGURED the leg fails closed with 503 not_configured
// BEFORE any record is written — the attempt is recorded in audit_log
// (intent), exactly like the M3 listing door. No session is fabricated,
// and the pitch stays pending: nothing is awarded on a promise.
import { randomUUID } from 'node:crypto';
import { feeSnapshot } from './fees.js';
import { httpError, artistFeeTier } from './checkout.js';
import { initialFulfillmentState } from './fulfillment.js';

export const COMMISSION_CONDITIONS = Object.freeze([
  'brief_open',
  'pitch_pending',
  'artist_verified',
  'artist_payout_path_live',
  'price_above_zero',
  'no_open_dispute_freeze',
]);

function checkoutUrls() {
  return {
    successUrl:
      process.env.CHECKOUT_SUCCESS_URL || 'https://pairedart.com/#/orders?checkout=success',
    cancelUrl:
      process.env.CHECKOUT_CANCEL_URL || 'https://pairedart.com/#/orders?checkout=canceled',
  };
}

/**
 * Accept a pitch: recheck → write the four records + the award → create
 * the Stripe session. `buyer` is the resolved brief owner { id, email }.
 * Throws httpError(...) with statusCode/code (and `failed` for door
 * rejections), mirroring createCheckout.
 */
export async function createCommissionCheckout(pool, stripe, { buyer, pitchId }) {
  const { rows: pitchRows } = await pool.query(
    `SELECT p.*, b.buyer_account_id AS brief_buyer_id, b.status AS brief_status,
            b.title AS brief_title
       FROM pitches p JOIN briefs b ON b.id = p.brief_id
      WHERE p.id = $1`,
    [pitchId],
  );
  const pitch = pitchRows[0];
  if (!pitch) throw httpError(404, 'not_found', 'Pitch not found');
  if (pitch.brief_buyer_id !== buyer.id) {
    // The accept door belongs to the brief's owner alone; to anyone else
    // the pitch does not exist.
    throw httpError(404, 'not_found', 'Pitch not found');
  }

  if (!stripe) {
    await pool.query(
      `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
       VALUES ($1, 'checkout.attempt', $2, 'stripe_not_configured', $3)`,
      [
        buyer.id,
        `pitch:${pitch.id}`,
        JSON.stringify({ briefId: pitch.brief_id, artistAccountId: pitch.artist_account_id, kind: 'commission' }),
      ],
    );
    throw httpError(503, 'not_configured', 'Checkout is not configured yet');
  }

  // --- The door, re-checked against live state ---------------------------
  const failed = [];
  if (pitch.brief_status !== 'open') failed.push('brief_open');
  if (pitch.status !== 'pending') failed.push('pitch_pending');
  if (!(Number.isInteger(pitch.price_cents) && pitch.price_cents > 0)) {
    failed.push('price_above_zero');
  }
  const { rows: profileRows } = await pool.query(
    'SELECT verified FROM artist_profiles WHERE account_id = $1',
    [pitch.artist_account_id],
  );
  if (!profileRows.length || profileRows[0].verified !== true) failed.push('artist_verified');
  const { rows: connectRows } = await pool.query(
    'SELECT state, manual_rail FROM connect_onboarding WHERE account_id = $1',
    [pitch.artist_account_id],
  );
  const connect = connectRows[0] || { state: 'not_started', manual_rail: false };
  if (!(connect.state === 'active' || connect.manual_rail === true)) {
    failed.push('artist_payout_path_live');
  }
  const { rows: disputeRows } = await pool.query(
    `SELECT 1 FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE o.buyer_account_id = $1 AND o.artist_account_id = $2
        AND p.dispute_state = 'open'
      LIMIT 1`,
    [buyer.id, pitch.artist_account_id],
  );
  if (disputeRows.length) failed.push('no_open_dispute_freeze');
  if (failed.length) {
    throw httpError(422, 'buy_door_closed', 'This pitch cannot be accepted right now', { failed });
  }

  const { tier, entitledTier } = await artistFeeTier(pool, pitch.artist_account_id);
  let snapshot;
  try {
    snapshot = feeSnapshot({ tier, entitledTier, priceCents: pitch.price_cents });
  } catch {
    throw httpError(422, 'buy_door_closed', 'This artist cannot sell on their current tier', {
      failed: ['artist_payout_path_live'],
    });
  }

  // --- The award + the four records, one transaction ---------------------
  const orderId = randomUUID();
  const client = await pool.connect();
  let order;
  try {
    await client.query('BEGIN');
    // Lock the brief, then the pitch: two accepts racing for one brief
    // serialize here, and the guarded status updates below make the
    // loser fail instead of double-awarding.
    const { rows: bRows } = await client.query('SELECT * FROM briefs WHERE id = $1 FOR UPDATE', [
      pitch.brief_id,
    ]);
    const brief = bRows[0];
    if (!brief || brief.status !== 'open') {
      await client.query('ROLLBACK');
      throw httpError(422, 'buy_door_closed', 'This pitch cannot be accepted right now', {
        failed: ['brief_open'],
      });
    }
    const { rows: pLock } = await client.query('SELECT * FROM pitches WHERE id = $1 FOR UPDATE', [
      pitch.id,
    ]);
    if (!pLock.length || pLock[0].status !== 'pending') {
      await client.query('ROLLBACK');
      throw httpError(422, 'buy_door_closed', 'This pitch cannot be accepted right now', {
        failed: ['pitch_pending'],
      });
    }

    const { rows: orderRows } = await client.query(
      `INSERT INTO orders
         (id, buyer_account_id, artist_account_id, listing_id, kind, status,
          price_cents, currency, fee_tier, fee_entitled_tier, fee_rate_bps,
          fee_calc_version, artist_share_cents, platform_share_cents)
       VALUES ($1, $2, $3, NULL, 'commission', 'checkout_open', $4, 'USD',
               $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        orderId,
        buyer.id,
        pitch.artist_account_id,
        pitch.price_cents,
        snapshot.tier,
        snapshot.entitledTier,
        snapshot.rateBps,
        snapshot.calcVersion,
        snapshot.artistShareCents,
        snapshot.platformShareCents,
      ],
    );
    order = orderRows[0];
    await client.query(
      `INSERT INTO payments (order_id, amount_cents, currency) VALUES ($1, $2, 'USD')`,
      [orderId, pitch.price_cents],
    );
    await client.query(
      `INSERT INTO fulfillments (order_id, kind, state) VALUES ($1, 'commission', $2)`,
      [orderId, initialFulfillmentState('commission')],
    );
    await client.query(
      `INSERT INTO releases (order_id, idempotency_key) VALUES ($1, $2)`,
      [orderId, `transfer:${orderId}`],
    );
    await client.query(
      `UPDATE pitches SET status = 'accepted', order_id = $1, updated_at = now() WHERE id = $2`,
      [orderId, pitch.id],
    );
    // The unchosen pitches are declined by the award — a state fact, and
    // it creates no obligation for anyone (consult M4).
    await client.query(
      `UPDATE pitches SET status = 'rejected', updated_at = now()
        WHERE brief_id = $1 AND status = 'pending' AND id <> $2`,
      [pitch.brief_id, pitch.id],
    );
    await client.query(
      `UPDATE briefs SET status = 'awarded', awarded_pitch_id = $1, updated_at = now()
        WHERE id = $2`,
      [pitch.id, pitch.brief_id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // --- The Stripe session, after commit; failure compensates -------------
  const { successUrl, cancelUrl } = checkoutUrls();
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: pitch.price_cents,
            product_data: { name: `Commission — ${pitch.brief_title || 'PAIRED brief'}` },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: buyer.email || undefined,
      client_reference_id: orderId,
      metadata: {
        order_id: orderId,
        brief_id: pitch.brief_id,
        pitch_id: pitch.id,
        buyer_account_id: buyer.id,
        artist_account_id: pitch.artist_account_id,
      },
      payment_intent_data: {
        transfer_group: `order_${orderId}`,
        metadata: { order_id: orderId, brief_id: pitch.brief_id, pitch_id: pitch.id },
      },
    });
  } catch (err) {
    await cancelCommissionAward(pool, orderId, pitch.id).catch(() => {});
    throw httpError(502, 'stripe_error', 'Checkout could not be created with the payment provider');
  }

  const { rows: updated } = await pool.query(
    `UPDATE orders SET stripe_checkout_session_id = $1, updated_at = now()
      WHERE id = $2 RETURNING *`,
    [session.id, orderId],
  );
  return { order: updated[0], checkoutUrl: session.url, sessionId: session.id };
}

/**
 * Compensation for a failed Stripe session: the order is canceled and
 * the award unwinds — pitch back to pending, brief back to open, the
 * declined pitches restored — so nothing dangles and the buyer can act
 * again. Mirrors cancelOrderWithReservation for the listing door.
 */
export async function cancelCommissionAward(pool, orderId, pitchId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = rows[0];
    if (!order || order.status !== 'checkout_open') {
      await client.query('COMMIT');
      return order || null;
    }
    await client.query(`UPDATE orders SET status = 'canceled', updated_at = now() WHERE id = $1`, [
      orderId,
    ]);
    await client.query(
      `UPDATE payments SET status = 'canceled', updated_at = now()
        WHERE order_id = $1 AND status IN ('requires_payment', 'processing')`,
      [orderId],
    );
    await client.query(
      `UPDATE fulfillments SET state = 'canceled', updated_at = now()
        WHERE order_id = $1 AND state = 'awaiting_start'`,
      [orderId],
    );
    const { rows: pRows } = await client.query('SELECT * FROM pitches WHERE id = $1 FOR UPDATE', [
      pitchId,
    ]);
    const pitch = pRows[0];
    if (pitch && pitch.status === 'accepted' && pitch.order_id === orderId) {
      await client.query(
        `UPDATE pitches SET status = 'pending', order_id = NULL, updated_at = now() WHERE id = $1`,
        [pitchId],
      );
      // Competing pitches the award declined return to pending with the
      // brief. A pitch the buyer had manually rejected before the award
      // is indistinguishable here and also returns to pending — the
      // buyer can decline it again; no obligation is created either way.
      await client.query(
        `UPDATE pitches SET status = 'pending', updated_at = now()
          WHERE brief_id = $1 AND status = 'rejected'`,
        [pitch.brief_id],
      );
      await client.query(
        `UPDATE briefs SET status = 'open', awarded_pitch_id = NULL, updated_at = now()
          WHERE id = $1 AND awarded_pitch_id = $2`,
        [pitch.brief_id, pitchId],
      );
    }
    await client.query('COMMIT');
    return order;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
