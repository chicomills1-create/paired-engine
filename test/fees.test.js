import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeSnapshot, CALC_VERSION } from '../src/lib/fees.js';

test('all tiers on a $200.00 sale (M0 worked example)', () => {
  const solo = feeSnapshot({ tier: 'solo', priceCents: 20000 });
  assert.equal(solo.rateBps, 800);
  assert.equal(solo.artistShareCents, 18400);
  assert.equal(solo.platformShareCents, 1600);

  const paired = feeSnapshot({ tier: 'paired', priceCents: 20000 });
  assert.equal(paired.rateBps, 500);
  assert.equal(paired.artistShareCents, 19000);
  assert.equal(paired.platformShareCents, 1000);

  const ensemble = feeSnapshot({ tier: 'ensemble', priceCents: 20000 });
  assert.equal(ensemble.rateBps, 300);
  assert.equal(ensemble.artistShareCents, 19400);
  assert.equal(ensemble.platformShareCents, 600);
});

test('snapshot carries the immutable fields an order must store', () => {
  const snap = feeSnapshot({ tier: 'paired', priceCents: 12345 });
  assert.equal(snap.tier, 'paired');
  assert.equal(snap.entitledTier, 'paired');
  assert.equal(snap.calcVersion, CALC_VERSION);
  assert.equal(snap.artistShareCents + snap.platformShareCents, 12345);
  assert.ok(Number.isInteger(snap.artistShareCents));
  assert.ok(Number.isInteger(snap.platformShareCents));
});

test("founding without entitledTier is an error (founding is a price, not a rate)", () => {
  assert.throws(() => feeSnapshot({ tier: 'founding', priceCents: 20000 }), /entitledTier/);
});

test('founding follows the entitled tier rate', () => {
  const snap = feeSnapshot({ tier: 'founding', priceCents: 20000, entitledTier: 'paired' });
  assert.equal(snap.tier, 'founding');
  assert.equal(snap.entitledTier, 'paired');
  assert.equal(snap.rateBps, 500);
  assert.equal(snap.artistShareCents, 19000);
});

test('inner_circle is a collector tier and cannot sell', () => {
  assert.throws(() => feeSnapshot({ tier: 'inner_circle', priceCents: 20000 }), /no selling rate/);
});

test('unknown tiers and bad prices are rejected', () => {
  assert.throws(() => feeSnapshot({ tier: 'gold', priceCents: 100 }), /no selling rate/);
  assert.throws(() => feeSnapshot({ tier: 'solo', priceCents: -1 }), /priceCents/);
  assert.throws(() => feeSnapshot({ tier: 'solo', priceCents: 19.99 }), /priceCents/);
});

test('zero-price sale snapshots cleanly', () => {
  const snap = feeSnapshot({ tier: 'solo', priceCents: 0 });
  assert.equal(snap.artistShareCents, 0);
  assert.equal(snap.platformShareCents, 0);
});
