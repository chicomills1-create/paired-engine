// M6 — Reconciliation: Stripe ↔ ledger truth pass. Discrepancies land
// in the exception queue (dedupe-keyed, idempotent re-runs), payouts
// advance payout_state separately from transfers, and nothing here ever
// auto-corrects money.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';
import { installFakeStripe, stripeState } from './helpers/fakestripe.js';

stubClerk();
installFakeStripe();
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor, grantRole } = await import('./helpers/testapp.js');
const { getStripe } = await import('../src/stripe.js');
const { runReconciliation } = await import('../src/lib/reconcile.js');

let pool;
let app;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
  await call(app, { method: 'GET', url: '/v1/artist/profile', as: 'reconadmin' });
  await grantRole(pool, await accountIdFor(pool, 'reconadmin'), 'admin');
});

after(async () => {
  await app.close();
  await pool.end();
});

/**
 * Build one fully-released order directly in the records (the state the
 * M3 flow produces): settled payment, completed transfer, ledger entry.
 * Returns the ids and amounts the Stripe side must mirror.
 */
async function releasedOrder(suffix, { shareCents = 18400, priceCents = 20000 } = {}) {
  const { rows: [artist] } = await pool.query(
    `INSERT INTO accounts (clerk_user_id, email) VALUES ($1, $2) RETURNING id`,
    [`clerk_recon_artist_${suffix}`, `recon_artist_${suffix}@example.test`],
  );
  const { rows: [buyer] } = await pool.query(
    `INSERT INTO accounts (clerk_user_id, email) VALUES ($1, $2) RETURNING id`,
    [`clerk_recon_buyer_${suffix}`, `recon_buyer_${suffix}@example.test`],
  );
  await pool.query(
    `INSERT INTO connect_onboarding (account_id, stripe_account_id, state)
     VALUES ($1, $2, 'active')`,
    [artist.id, `acct_recon_${suffix}`],
  );
  const { rows: [order] } = await pool.query(
    `INSERT INTO orders (buyer_account_id, artist_account_id, kind, status, price_cents,
                         fee_tier, fee_entitled_tier, fee_rate_bps, fee_calc_version,
                         artist_share_cents, platform_share_cents)
     VALUES ($1, $2, 'commission', 'released', $3, 'solo', 'solo', 800, 'v1', $4, $5)
     RETURNING id`,
    [buyer.id, artist.id, priceCents, shareCents, priceCents - shareCents],
  );
  await pool.query(
    `INSERT INTO payments (order_id, amount_cents, status, settled_at, stripe_payment_intent_id)
     VALUES ($1, $2, 'succeeded', now(), $3)`,
    [order.id, priceCents, `pi_recon_${suffix}`],
  );
  await pool.query(
    `INSERT INTO releases (order_id, idempotency_key, state, transfer_state, payout_state, stripe_transfer_id)
     VALUES ($1, $2, 'transfer_created', 'paid', 'pending', $3)`,
    [order.id, `transfer:${order.id}`, `tr_recon_${suffix}`],
  );
  await pool.query(
    `INSERT INTO ledger_entries (order_id, account_id, kind, amount_cents, stripe_object_id, idempotency_key)
     VALUES ($1, $2, 'transfer', $3, $4, $5)`,
    [order.id, artist.id, shareCents, `tr_recon_${suffix}`, `transfer:${order.id}`],
  );
  return { artistId: artist.id, buyerId: buyer.id, orderId: order.id, shareCents, priceCents, suffix };
}

function mirrorStripe(o, { transferAmount, chargeAmount } = {}) {
  stripeState.stripeTransfers.push({
    id: `tr_recon_${o.suffix}`,
    amount: transferAmount ?? o.shareCents,
    amount_reversed: 0,
    destination: `acct_recon_${o.suffix}`,
    transfer_group: `order_${o.orderId}`,
  });
  stripeState.stripeCharges.push({
    id: `ch_recon_${o.suffix}`,
    payment_intent: `pi_recon_${o.suffix}`,
    amount: chargeAmount ?? o.priceCents,
    paid: true,
    status: 'succeeded',
  });
}

async function openExceptions() {
  const { rows } = await pool.query(
    `SELECT kind, stripe_object_id FROM exception_queue WHERE state = 'open' ORDER BY created_at`,
  );
  return rows;
}

test('without Stripe the job is a no-op that says so — never a fabricated clean bill', async () => {
  const result = await runReconciliation(pool, null);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'stripe_not_configured');
});

test('a clean mirror reconciles to zero discrepancies', async () => {
  const o = await releasedOrder('clean');
  mirrorStripe(o);
  const result = await runReconciliation(pool, getStripe());
  assert.equal(result.ran, true);
  assert.deepEqual(result.discrepancies, []);
  assert.equal(result.raised, 0);
  assert.deepEqual(await openExceptions(), []);
});

test('a transfer amount mismatch is raised once and deduped on re-run', async () => {
  const o = await releasedOrder('mismatch');
  mirrorStripe(o, { transferAmount: o.shareCents - 100 });

  const first = await runReconciliation(pool, getStripe());
  assert.equal(first.discrepancies.length, 1);
  assert.equal(first.discrepancies[0].kind, 'transfer_amount_mismatch');
  assert.equal(first.raised, 1);

  const second = await runReconciliation(pool, getStripe());
  assert.equal(second.discrepancies.length, 1, 'still observed');
  assert.equal(second.raised, 0, 'but not raised twice');

  const open = await openExceptions();
  assert.equal(open.filter((e) => e.kind === 'transfer_amount_mismatch').length, 1);
});

test('a Stripe transfer with no local release, and a settled charge with no local payment, are named', async () => {
  stripeState.stripeTransfers.push({
    id: 'tr_ghost', amount: 5000, amount_reversed: 0, destination: 'acct_unknown', transfer_group: null,
  });
  stripeState.stripeCharges.push({
    id: 'ch_ghost', payment_intent: 'pi_ghost', amount: 5000, paid: true, status: 'succeeded',
  });
  const result = await runReconciliation(pool, getStripe());
  const kinds = result.discrepancies.map((d) => d.kind);
  assert.ok(kinds.includes('transfer_missing_locally'));
  assert.ok(kinds.includes('payment_settled_not_recorded'));
});

test('a paid payout advances payout_state (transfer ≠ payout); a failed payout raises an exception', async () => {
  const o = await releasedOrder('payout');
  mirrorStripe(o);
  stripeState.stripePayoutsByAccount[`acct_recon_${o.suffix}`] = [
    { id: `po_recon_${o.suffix}`, amount: o.shareCents, status: 'paid' },
  ];
  const result = await runReconciliation(pool, getStripe());
  assert.equal(result.payoutsAdvanced, 1);
  const { rows } = await pool.query(
    'SELECT payout_state, stripe_payout_id FROM releases WHERE order_id = $1',
    [o.orderId],
  );
  assert.equal(rows[0].payout_state, 'paid');
  assert.equal(rows[0].stripe_payout_id, `po_recon_${o.suffix}`);

  const o2 = await releasedOrder('payoutfail');
  mirrorStripe(o2);
  stripeState.stripePayoutsByAccount[`acct_recon_${o2.suffix}`] = [
    { id: `po_fail_${o2.suffix}`, amount: o2.shareCents, status: 'failed', failure_code: 'account_closed' },
  ];
  const r2 = await runReconciliation(pool, getStripe());
  assert.ok(r2.discrepancies.some((d) => d.kind === 'payout_failed'));
  const { rows: rel2 } = await pool.query(
    'SELECT payout_state FROM releases WHERE order_id = $1',
    [o2.orderId],
  );
  assert.equal(rel2[0].payout_state, 'pending', 'a failed payout never advances the state');
});

test('exceptions resolve only with a reason, and the resolution is audited', async () => {
  const queue = await call(app, { method: 'GET', url: '/v1/admin/exceptions', as: 'reconadmin' });
  assert.ok(queue.json().exceptions.length >= 1);
  const target = queue.json().exceptions[0];

  const noReason = await call(app, {
    method: 'POST', url: `/v1/admin/exceptions/${target.id}/resolve`, as: 'reconadmin', payload: {},
  });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.json().error.code, 'reason_required');

  const resolved = await call(app, {
    method: 'POST', url: `/v1/admin/exceptions/${target.id}/resolve`, as: 'reconadmin',
    payload: { reason: 'Explained: test-fixture drift, amounts verified by hand' },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json().exception.state, 'resolved');
  assert.equal(resolved.json().exception.resolutionReason, 'Explained: test-fixture drift, amounts verified by hand');

  const again = await call(app, {
    method: 'POST', url: `/v1/admin/exceptions/${target.id}/resolve`, as: 'reconadmin',
    payload: { reason: 'Twice' },
  });
  assert.equal(again.statusCode, 409);

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'exception.resolve' AND target = $1`,
    [`exception:${target.id}`],
  );
  assert.equal(rows[0].n, 1);

  // A resolved discrepancy the job still observes does NOT reopen itself:
  // human decisions stand until a human revisits them.
  const before = await openExceptions();
  await runReconciliation(pool, getStripe());
  const after = await openExceptions();
  assert.equal(after.length, before.length);
});
