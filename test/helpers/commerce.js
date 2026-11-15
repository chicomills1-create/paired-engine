// Shared M3 test setup: verified artists with payout paths, published
// listings, checkouts, and Stripe-event delivery through the real inbox.
import assert from 'node:assert/strict';
import { call, accountIdFor } from './testapp.js';

/**
 * Create an artist account with a profile, a membership tier, a
 * verification flag, and a Connect/manual-rail payout posture — all set
 * server-side, the way production state actually gets made.
 */
export async function makeArtist(
  app,
  pool,
  name,
  { tier = 'solo', connectState = 'active', manualRail = false, verified = true } = {},
) {
  await call(app, { method: 'PATCH', url: '/v1/artist/profile', as: name, payload: { displayName: name } });
  const id = await accountIdFor(pool, name);
  assert.ok(id, `account for ${name}`);
  if (tier !== 'solo') {
    await pool.query('UPDATE memberships SET tier = $1 WHERE account_id = $2', [tier, id]);
  }
  await pool.query(
    `INSERT INTO artist_profiles (account_id, verified) VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE SET verified = EXCLUDED.verified`,
    [id, verified],
  );
  await pool.query(
    `INSERT INTO connect_onboarding (account_id, stripe_account_id, state, manual_rail)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id) DO UPDATE
       SET stripe_account_id = EXCLUDED.stripe_account_id,
           state = EXCLUDED.state,
           manual_rail = EXCLUDED.manual_rail`,
    [id, connectState === 'active' ? `acct_${name}` : null, connectState, manualRail],
  );
  return id;
}

export async function makeListing(
  app,
  artistName,
  { title = 'Test Piece', priceCents = 20000, type = 'physical', publish = true } = {},
) {
  const res = await call(app, {
    method: 'POST',
    url: '/v1/listings',
    as: artistName,
    payload: { title, priceCents, type },
  });
  assert.equal(res.statusCode, 201, res.body);
  const listing = res.json().listing;
  if (publish) {
    const pub = await call(app, { method: 'POST', url: `/v1/listings/${listing.id}/publish`, as: artistName });
    assert.equal(pub.statusCode, 200, pub.body);
  }
  return listing.id;
}

export async function checkoutOk(app, buyerName, listingId) {
  const res = await call(app, { method: 'POST', url: `/v1/listings/${listingId}/checkout`, as: buyerName });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

/** Insert a Stripe event into the durable inbox and drain it. */
export async function deliverStripeEvent(pool, event) {
  await pool.query(
    `INSERT INTO event_inbox (source, event_id, type, payload)
     VALUES ('stripe', $1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
    [event.id, event.type, JSON.stringify(event)],
  );
  const { processInbox } = await import('../../src/inbox.js');
  return processInbox(pool);
}

let eventSeq = 0;
export function nextEventId(prefix = 'evt_test') {
  return `${prefix}_${++eventSeq}`;
}

/** The standard session-completed event for an order's checkout. */
export function sessionCompletedEvent(order, sessionId, paymentIntentId) {
  return {
    id: nextEventId('evt_completed'),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        payment_intent: paymentIntentId,
        amount_total: order.priceCents,
        currency: 'usd',
        metadata: { order_id: order.id },
      },
    },
  };
}
