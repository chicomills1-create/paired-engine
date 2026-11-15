// Inventory transitions: the guarded UPDATE resolves races exactly once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createTestDb } = await import('./helpers/testdb.js');
const { transitionInventory, isAllowedTransition } = await import('../src/lib/inventory.js');

let pool;
let listingId;

before(async () => {
  ({ pool } = await createTestDb());
  const { rows: accounts } = await pool.query(
    `INSERT INTO accounts (clerk_user_id, email) VALUES ('clerk_seller', 's@example.test') RETURNING id`,
  );
  const { rows } = await pool.query(
    `INSERT INTO listings (account_id, title, price_cents) VALUES ($1, 'One Of One', 20000) RETURNING id`,
    [accounts[0].id],
  );
  listingId = rows[0].id;
});

after(async () => {
  await pool.end();
});

test('the transition map matches the M0 one-of-one states', () => {
  assert.equal(isAllowedTransition('available', 'reserved'), true);
  assert.equal(isAllowedTransition('available', 'sold'), true);
  assert.equal(isAllowedTransition('reserved', 'available'), true);
  assert.equal(isAllowedTransition('reserved', 'sold'), true);
  assert.equal(isAllowedTransition('sold', 'available'), false);
  assert.equal(isAllowedTransition('sold', 'reserved'), false);
  assert.equal(isAllowedTransition('available', 'available'), false);
});

test('reserve records the expiry + ref; a repeat reserve fails with the current state', async () => {
  const until = new Date(Date.now() + 15 * 60 * 1000);
  const first = await transitionInventory(pool, {
    listingId, from: 'available', to: 'reserved', reservedUntil: until, reservationRef: 'checkout_1',
  });
  assert.equal(first.transitioned, true);
  assert.equal(first.listing.inventory_state, 'reserved');
  assert.equal(first.listing.reservation_ref, 'checkout_1');
  assert.ok(first.listing.reserved_until);

  const second = await transitionInventory(pool, {
    listingId, from: 'available', to: 'reserved', reservedUntil: until, reservationRef: 'checkout_2',
  });
  assert.equal(second.transitioned, false);
  assert.equal(second.currentState, 'reserved');
});

test('two racing reserves resolve exactly once', async () => {
  // Reset to available first.
  const released = await transitionInventory(pool, { listingId, from: 'reserved', to: 'available' });
  assert.equal(released.transitioned, true);
  assert.equal(released.listing.reservation_ref, null);
  assert.equal(released.listing.reserved_until, null);

  const until = new Date(Date.now() + 15 * 60 * 1000);
  const results = await Promise.all([
    transitionInventory(pool, {
      listingId, from: 'available', to: 'reserved', reservedUntil: until, reservationRef: 'race_a',
    }),
    transitionInventory(pool, {
      listingId, from: 'available', to: 'reserved', reservedUntil: until, reservationRef: 'race_b',
    }),
  ]);
  const winners = results.filter((r) => r.transitioned);
  const losers = results.filter((r) => !r.transitioned);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].currentState, 'reserved');

  const { rows } = await pool.query('SELECT reservation_ref FROM listings WHERE id = $1', [listingId]);
  assert.equal(rows[0].reservation_ref, winners[0].listing.reservation_ref);
});

test('reserved → sold completes; sold is terminal', async () => {
  const sold = await transitionInventory(pool, { listingId, from: 'reserved', to: 'sold' });
  assert.equal(sold.transitioned, true);
  assert.equal(sold.listing.inventory_state, 'sold');
  assert.equal(sold.listing.reserved_until, null);

  await assert.rejects(
    () => transitionInventory(pool, { listingId, from: 'sold', to: 'available' }),
    /not allowed/,
  );
});

test('a missing listing reports currentState null', async () => {
  const res = await transitionInventory(pool, {
    listingId: '00000000-0000-0000-0000-000000000000', from: 'available', to: 'reserved',
  });
  assert.equal(res.transitioned, false);
  assert.equal(res.currentState, null);
});
