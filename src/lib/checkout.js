// Checkout creation (M3) — the buy door, enforced server-side.
//
// M0 says the server re-checks the 7 buy-door conditions at checkout
// creation; a disabled frontend button is not a control. The conditions
// enforced here, against live database state at creation time:
//
//   1. listing_published        — listing.status = 'published'
//   2. inventory_available      — the one-of-one piece is available (a
//                                 reservation whose 15 minutes have lapsed
//                                 counts as available; it is swept first)
//   3. artist_verified          — artist_profiles.verified (the human-made
//                                 verification record of M2)
//   4. artist_payout_path_live  — Connect state 'active', OR the manual
//                                 payout rail approved for this artist
//                                 (M0 §7 interim cycle)
//   5. buyer_is_not_seller      — buyer ≠ the listing's artist
//   6. price_above_zero         — listing.price_cents > 0
//   7. no_open_dispute_freeze   — no OPEN dispute on a prior order between
//                                 THIS buyer and THIS artist (the freeze is
//                                 pair-scoped: a dispute freezes the legs of
//                                 its own order and this pair's new checkouts,
//                                 never the artist's whole book)
//   8. artist_account_active    — the artist's account itself is active
//                                 (a suspension — e.g. a Clerk ban landing
//                                 through the webhook — closes every door
//                                 the artist sells through; SND-05)
//   9. music_rights_in_force    — music only: the release's rights are in
//                                 force at checkout time, not just at
//                                 publish time — both declaration legs
//                                 affirmative, no open review hold, and a
//                                 non-original release carrying a
//                                 reviewer's clearance (SND-01/SND-02;
//                                 src/lib/music.js musicRightsInForce)
//
// Checkout creation is also where the one-of-one reservation lands:
// a transactional, guarded available → reserved transition holding the
// piece for 15 minutes (M0), and where the immutable fee snapshot is
// written (src/lib/fees.js). The Order / Payment / Fulfillment / Release
// records are created in the same transaction; the Stripe Checkout
// session is created after commit, and any Stripe failure compensates
// (order canceled, reservation released) so nothing dangles.
//
// WITHOUT STRIPE CONFIGURED the leg fails closed with 503 not_configured
// BEFORE any record is written — the attempt is recorded in audit_log
// (intent), never as an order. No session is ever fabricated.
import { randomUUID } from 'node:crypto';
import { feeSnapshotForListing } from './fees.js';
import { transitionInventory } from './inventory.js';
import { initialFulfillmentState } from './fulfillment.js';
import { musicRightsInForce } from './music.js';
import { classifyListingTax, taxSessionParams } from './tax.js';

export const CHECKOUT_CONDITIONS = Object.freeze([
  'listing_published',
  'inventory_available',
  'artist_verified',
  'artist_payout_path_live',
  'buyer_is_not_seller',
  'price_above_zero',
  'no_open_dispute_freeze',
  'artist_account_active',
  'music_rights_in_force',
]);

export const RESERVATION_MINUTES = 15;

export function httpError(statusCode, code, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function checkoutUrls() {
  return {
    successUrl:
      process.env.CHECKOUT_SUCCESS_URL || 'https://pairedart.com/#/orders?checkout=success',
    cancelUrl:
      process.env.CHECKOUT_CANCEL_URL || 'https://pairedart.com/#/orders?checkout=canceled',
  };
}

export async function getListingForCheckout(pool, listingId) {
  const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [listingId]);
  return rows[0] || null;
}

function inventoryCountsAvailable(listing, now = new Date()) {
  if (listing.inventory_state === 'available') return true;
  if (listing.inventory_state === 'reserved' && listing.reserved_until) {
    return new Date(listing.reserved_until) <= now;
  }
  return false;
}

/**
 * Evaluate the 7 buy-door conditions for (buyer, listing) against live
 * state. Pure read — the reservation itself is attempted transactionally
 * in createCheckout, which is the authoritative inventory check.
 * Returns { ok, failed: string[] } with the stable condition names above.
 */
export async function recheckBuyDoor(pool, { buyerId, listing }) {
  const failed = [];
  const artistId = listing.account_id;

  if (listing.status !== 'published') failed.push('listing_published');
  if (!inventoryCountsAvailable(listing)) failed.push('inventory_available');
  if (!(Number.isInteger(listing.price_cents) && listing.price_cents > 0)) {
    failed.push('price_above_zero');
  }
  if (buyerId === artistId) failed.push('buyer_is_not_seller');

  const { rows: profileRows } = await pool.query(
    'SELECT verified FROM artist_profiles WHERE account_id = $1',
    [artistId],
  );
  if (!profileRows.length || profileRows[0].verified !== true) failed.push('artist_verified');

  const { rows: connectRows } = await pool.query(
    'SELECT state, manual_rail FROM connect_onboarding WHERE account_id = $1',
    [artistId],
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
    [buyerId, artistId],
  );
  if (disputeRows.length) failed.push('no_open_dispute_freeze');

  const { rows: accountRows } = await pool.query('SELECT status FROM accounts WHERE id = $1', [
    artistId,
  ]);
  if (!accountRows.length || accountRows[0].status !== 'active') {
    failed.push('artist_account_active');
  }

  if (listing.medium === 'music' && !musicRightsInForce(listing)) {
    failed.push('music_rights_in_force');
  }

  return { ok: failed.length === 0, failed };
}

/** The artist's server-side selling tier (Neon owns tier authority). */
export async function artistFeeTier(pool, artistId) {
  const { rows } = await pool.query('SELECT tier FROM memberships WHERE account_id = $1', [
    artistId,
  ]);
  const tier = rows[0]?.tier || 'solo';
  // Founding Paired is a $6 subscription price, not a rate: a founding
  // artist's entitled selling tier is Paired (charter, locked 2026-10-31).
  if (tier === 'founding') return { tier, entitledTier: 'paired' };
  return { tier, entitledTier: tier };
}

/**
 * Create a checkout: recheck → reserve → write the four records → create
 * the Stripe session. Throws httpError(...) with statusCode/code (and
 * `failed` for buy-door rejections). `buyer` is the resolved account row
 * shape { id, email }.
 */
export async function createCheckout(pool, stripe, { buyer, listingId }) {
  const listing = await getListingForCheckout(pool, listingId);
  if (!listing) throw httpError(404, 'not_found', 'Listing not found');

  if (!stripe) {
    // Fail closed BEFORE any money record exists; the attempt itself is
    // the intent record (audit log), exactly like the Connect leg in M2.
    await pool.query(
      `INSERT INTO audit_log (actor_account_id, action, target, reason, meta)
       VALUES ($1, 'checkout.attempt', $2, 'stripe_not_configured', $3)`,
      [buyer.id, `listing:${listing.id}`, JSON.stringify({ artistAccountId: listing.account_id })],
    );
    throw httpError(503, 'not_configured', 'Checkout is not configured yet');
  }

  const door = await recheckBuyDoor(pool, { buyerId: buyer.id, listing });
  if (!door.ok) {
    throw httpError(422, 'buy_door_closed', 'This listing cannot be checked out right now', {
      failed: door.failed,
    });
  }

  const { tier, entitledTier } = await artistFeeTier(pool, listing.account_id);
  let snapshot;
  try {
    // Music snapshots at 0% commission (fees.js) — the artist's share
    // is the full listed price at every tier, forever.
    snapshot = feeSnapshotForListing({
      medium: listing.medium,
      tier,
      entitledTier,
      priceCents: listing.price_cents,
    });
  } catch {
    throw httpError(422, 'buy_door_closed', 'This artist cannot sell on their current tier', {
      failed: ['artist_payout_path_live'],
    });
  }
  // TAX (§3): the line item's classification resolves from the listing
  // itself (medium + type) BEFORE any record is written. The schema
  // constrains both fields, so a null here means a corrupt record —
  // fail closed rather than let the item inherit the account's
  // digital-services tax preset.
  const taxClass = classifyListingTax(listing);
  if (!taxClass) {
    throw httpError(
      422,
      'tax_classification_unresolved',
      'This listing has no resolvable tax classification; checkout cannot be created',
    );
  }

  // Music is not one-of-one: a release sells to every buyer, so there
  // is nothing to reserve and nothing to deplete. The order carries no
  // reservation and the listing stays 'available' through settlement.
  const isMusic = listing.medium === 'music';

  const orderId = randomUUID();
  const expiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000);
  const client = await pool.connect();
  let order;
  try {
    await client.query('BEGIN');
    // Serialize checkouts per listing: the row lock + the guarded
    // inventory transition together make the reservation race-safe.
    const { rows: locked } = await client.query('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [
      listing.id,
    ]);
    const current = locked[0];
    if (!isMusic) {
      // Sweep a lapsed reservation on this listing before judging inventory.
      if (
        current.inventory_state === 'reserved' &&
        current.reserved_until &&
        new Date(current.reserved_until) <= new Date()
      ) {
        await transitionInventory(client, {
          listingId: listing.id,
          from: 'reserved',
          to: 'available',
        });
        await client.query(
          `UPDATE orders SET status = 'canceled', updated_at = now()
            WHERE reservation_ref = $1 AND status = 'checkout_open'`,
          [current.reservation_ref],
        );
      }
      const reserved = await transitionInventory(client, {
        listingId: listing.id,
        from: 'available',
        to: 'reserved',
        reservedUntil: expiresAt,
        reservationRef: orderId,
      });
      if (!reserved.transitioned) {
        await client.query('ROLLBACK');
        throw httpError(422, 'buy_door_closed', 'This listing cannot be checked out right now', {
          failed: ['inventory_available'],
        });
      }
    } else if (current.inventory_state !== 'available') {
      // A music listing never leaves 'available'; anything else is a
      // corrupt state and the door stays closed rather than guessing.
      await client.query('ROLLBACK');
      throw httpError(422, 'buy_door_closed', 'This listing cannot be checked out right now', {
        failed: ['inventory_available'],
      });
    }
    if (isMusic && !musicRightsInForce(current)) {
      // Re-verified under the row lock (SND-01): a declaration withdrawn
      // or a review hold opened between the door recheck and this
      // transaction still closes the sale.
      await client.query('ROLLBACK');
      throw httpError(422, 'buy_door_closed', 'This listing cannot be checked out right now', {
        failed: ['music_rights_in_force'],
      });
    }

    const { rows: orderRows } = await client.query(
      `INSERT INTO orders
         (id, buyer_account_id, artist_account_id, listing_id, kind, status,
          price_cents, currency, fee_tier, fee_entitled_tier, fee_rate_bps,
          fee_calc_version, artist_share_cents, platform_share_cents,
          reservation_ref, reservation_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'checkout_open', $6, 'USD', $7, $8, $9, $10, $11, $12, $14, $13)
       RETURNING *`,
      [
        orderId,
        buyer.id,
        listing.account_id,
        listing.id,
        listing.type,
        listing.price_cents,
        snapshot.tier,
        snapshot.entitledTier,
        snapshot.rateBps,
        snapshot.calcVersion,
        snapshot.artistShareCents,
        snapshot.platformShareCents,
        isMusic ? null : expiresAt,
        isMusic ? null : orderId,
      ],
    );
    order = orderRows[0];
    await client.query(
      `INSERT INTO payments (order_id, amount_cents, currency) VALUES ($1, $2, 'USD')`,
      [orderId, listing.price_cents],
    );
    await client.query(
      `INSERT INTO fulfillments (order_id, kind, state) VALUES ($1, $2, $3)`,
      [orderId, listing.type, initialFulfillmentState(listing.type)],
    );
    await client.query(
      `INSERT INTO releases (order_id, idempotency_key) VALUES ($1, $2)`,
      [orderId, `transfer:${orderId}`],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // The Stripe session is created AFTER commit (an external call never
  // sits inside the money transaction); failure compensates cleanly.
  const { successUrl, cancelUrl } = checkoutUrls();
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...taxSessionParams(taxClass),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: listing.price_cents,
            tax_behavior: 'exclusive',
            product_data: {
              name: listing.title || 'PAIRED artwork',
              tax_code: taxClass.taxCode,
            },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: buyer.email || undefined,
      client_reference_id: orderId,
      metadata: {
        order_id: orderId,
        listing_id: listing.id,
        buyer_account_id: buyer.id,
        artist_account_id: listing.account_id,
      },
      payment_intent_data: {
        transfer_group: `order_${orderId}`,
        metadata: { order_id: orderId, listing_id: listing.id },
      },
    });
  } catch (err) {
    await cancelOrderWithReservation(pool, orderId).catch(() => {});
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
 * The cancel itself, inside a caller-managed transaction (used by the
 * checkout route AND by the Stripe webhook worker for expired sessions).
 * Caller guarantees the order is still 'checkout_open'.
 */
export async function applyOrderCancel(client, order) {
  if (order.listing_id) {
    const { rows: lrows } = await client.query('SELECT * FROM listings WHERE id = $1', [
      order.listing_id,
    ]);
    const listing = lrows[0];
    if (listing && listing.inventory_state === 'reserved' && listing.reservation_ref === order.id) {
      await transitionInventory(client, {
        listingId: listing.id,
        from: 'reserved',
        to: 'available',
      });
    }
  }
  await client.query(`UPDATE orders SET status = 'canceled', updated_at = now() WHERE id = $1`, [
    order.id,
  ]);
  await client.query(
    `UPDATE payments SET status = 'canceled', updated_at = now()
      WHERE order_id = $1 AND status IN ('requires_payment', 'processing')`,
    [order.id],
  );
  await client.query(
    `UPDATE fulfillments SET state = 'canceled', updated_at = now()
      WHERE order_id = $1 AND state IN ('awaiting_shipment', 'awaiting_delivery', 'awaiting_start')`,
    [order.id],
  );
}

/** Cancel a checkout_open order and release its reservation, if it holds one. */
export async function cancelOrderWithReservation(pool, orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = rows[0];
    if (!order || order.status !== 'checkout_open') {
      await client.query('COMMIT');
      return order || null;
    }
    await applyOrderCancel(client, order);
    await client.query('COMMIT');
    return order;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Release every lapsed checkout reservation: the order is canceled and
 * the piece returns to available. Returns the number of orders swept.
 * Safe to run repeatedly (guarded transitions + status checks).
 */
export async function expireStaleReservations(pool) {
  const { rows } = await pool.query(
    `SELECT id FROM orders
      WHERE status = 'checkout_open' AND reservation_expires_at IS NOT NULL
        AND reservation_expires_at <= now()`,
  );
  let swept = 0;
  for (const row of rows) {
    const { rows: before } = await pool.query('SELECT status FROM orders WHERE id = $1', [row.id]);
    await cancelOrderWithReservation(pool, row.id);
    const { rows: after } = await pool.query('SELECT status FROM orders WHERE id = $1', [row.id]);
    if (before[0]?.status === 'checkout_open' && after[0]?.status === 'canceled') swept++;
  }
  return swept;
}
