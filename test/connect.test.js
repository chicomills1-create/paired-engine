// Connect onboarding state machine.
// Route level (no Stripe configured): intent is recorded, the leg fails
// closed with 503 not_configured, and the state never advances.
// Lib level (fake Stripe): one account is created and reused, links move
// not_started → link_issued, and status refresh derives
// pending / active / restricted from the Stripe account object.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubClerk } from './helpers/testapp.js';

stubClerk();
delete process.env.STRIPE_SECRET_KEY;

const { createTestDb } = await import('./helpers/testdb.js');
const { buildTestApp, call, accountIdFor } = await import('./helpers/testapp.js');
const { issueOnboardingLink, refreshConnectStatus, getConnectRow } = await import(
  '../src/lib/connect.js'
);

let pool;
let app;

before(async () => {
  ({ pool } = await createTestDb());
  app = await buildTestApp(pool);
});

after(async () => {
  await app.close();
  await pool.end();
});

test('without Stripe: link issuance fails closed and records intent only', async () => {
  const res = await call(app, { method: 'POST', url: '/v1/artist/connect/onboarding-link', as: 'dave' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'not_configured');

  const daveId = await accountIdFor(pool, 'dave');
  const { rows } = await pool.query('SELECT * FROM connect_onboarding WHERE account_id = $1', [daveId]);
  assert.equal(rows.length, 1); // intent recorded
  assert.equal(rows[0].state, 'not_started'); // state did NOT advance
  assert.equal(rows[0].stripe_account_id, null);

  const status = await call(app, { method: 'GET', url: '/v1/artist/connect/status', as: 'dave' });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json().connect, { state: 'not_started', stripeAccountId: null });
});

let fakeCreateSeq = 0; // unique account ids across every fake in this file

function fakeStripe(accountObject) {
  const calls = { create: 0, links: 0, retrieve: 0 };
  return {
    calls,
    accounts: {
      create: async (params) => {
        calls.create++;
        return { id: `acct_test_${++fakeCreateSeq}`, ...params };
      },
      retrieve: async () => {
        calls.retrieve++;
        return accountObject;
      },
    },
    accountLinks: {
      create: async ({ account }) => {
        calls.links++;
        return { url: `https://connect.stripe.test/onboard/${account}/${calls.links}`, expires_at: 9999999999 };
      },
    },
  };
}

async function makeAccount(name) {
  await call(app, { method: 'GET', url: '/v1/artist/profile', as: name });
  const id = await accountIdFor(pool, name);
  return { id, email: `${name}@example.test` };
}

test('with Stripe: first link creates the account once and moves to link_issued', async () => {
  const account = await makeAccount('erin');
  const stripe = fakeStripe({});

  const first = await issueOnboardingLink(pool, stripe, account);
  assert.equal(first.row.state, 'link_issued');
  assert.equal(first.row.stripe_account_id, 'acct_test_1');
  assert.ok(first.url.includes('acct_test_1'));
  assert.equal(stripe.calls.create, 1);
  assert.equal(stripe.calls.links, 1);

  const second = await issueOnboardingLink(pool, stripe, account);
  assert.equal(second.row.state, 'link_issued');
  assert.equal(stripe.calls.create, 1); // reused, never recreated
  assert.equal(stripe.calls.links, 2); // a fresh link each time
  assert.notEqual(second.url, first.url);
});

test('status refresh derives pending, active, restricted from Stripe', async () => {
  const account = await makeAccount('frank');
  const stripe = fakeStripe({});
  await issueOnboardingLink(pool, stripe, account);

  stripe.accounts.retrieve = async () => ({ details_submitted: true, charges_enabled: false, payouts_enabled: false });
  let row = await refreshConnectStatus(pool, stripe, account.id);
  assert.equal(row.state, 'pending');

  stripe.accounts.retrieve = async () => ({
    details_submitted: true, charges_enabled: true, payouts_enabled: true, requirements: {},
  });
  row = await refreshConnectStatus(pool, stripe, account.id);
  assert.equal(row.state, 'active');

  stripe.accounts.retrieve = async () => ({
    details_submitted: true, charges_enabled: false, payouts_enabled: false,
    requirements: { disabled_reason: 'requirements.past_due' },
  });
  row = await refreshConnectStatus(pool, stripe, account.id);
  assert.equal(row.state, 'restricted');

  const stored = await getConnectRow(pool, account.id);
  assert.equal(stored.state, 'restricted');
});

test('an active artist is not issued another onboarding link', async () => {
  const account = await makeAccount('gwen');
  const stripe = fakeStripe({});
  await issueOnboardingLink(pool, stripe, account);
  stripe.accounts.retrieve = async () => ({
    details_submitted: true, charges_enabled: true, payouts_enabled: true, requirements: {},
  });
  await refreshConnectStatus(pool, stripe, account.id);

  const linksBefore = stripe.calls.links;
  const result = await issueOnboardingLink(pool, stripe, account);
  assert.equal(result.row.state, 'active');
  assert.equal(result.url, null);
  assert.equal(stripe.calls.links, linksBefore);
});
