// Stripe Connect payout onboarding — the account-link leg (M2).
//
// State machine (connect_onboarding.state):
//   not_started → link_issued → pending → active | restricted
//
// The artist gets ONE connected account, created on first link issuance and
// reused forever after. Onboarding itself is Stripe-hosted (bank, ID and
// tax details never touch Paired — Connect spec §8B).
//
// ACCOUNT TYPE: this leg creates a legacy Express account
// (stripe.accounts.create({ type: 'express' })) + an account_onboarding
// Account Link. The Accounts v2 vs legacy Express decision of record is
// M3-01; if it lands on v2, only createConnectedAccount() below changes —
// the state machine, the routes and the stored ids are unaffected.
//
// WITHOUT STRIPE CONFIGURED the state machine stays honest: no link can be
// issued, so the state never advances past not_started. The route records
// the artist's intent (a connect_onboarding row, updated_at touched) and
// answers 503 not_configured — the same fail-closed posture as the webhook
// secret and the storage legs. Status reads always serve the stored state.
export const CONNECT_STATES = Object.freeze([
  'not_started',
  'link_issued',
  'pending',
  'active',
  'restricted',
]);

function onboardingUrls() {
  return {
    refreshUrl:
      process.env.CONNECT_ONBOARDING_REFRESH_URL || 'https://pairedart.com/#/studio/payouts',
    returnUrl:
      process.env.CONNECT_ONBOARDING_RETURN_URL || 'https://pairedart.com/#/studio/payouts',
  };
}

/** The stored onboarding row, or the not_started default when none exists. */
export async function getConnectRow(pool, accountId) {
  const { rows } = await pool.query(
    'SELECT account_id, stripe_account_id, state, created_at, updated_at FROM connect_onboarding WHERE account_id = $1',
    [accountId],
  );
  if (rows.length) return rows[0];
  return { account_id: accountId, stripe_account_id: null, state: 'not_started' };
}

/**
 * Record that the artist asked for payout onboarding while Stripe is not
 * configured. Creates the row if needed; the state does not advance.
 */
export async function recordConnectIntent(pool, accountId) {
  const { rows } = await pool.query(
    `INSERT INTO connect_onboarding (account_id) VALUES ($1)
     ON CONFLICT (account_id) DO UPDATE SET updated_at = now()
     RETURNING account_id, stripe_account_id, state, created_at, updated_at`,
    [accountId],
  );
  return rows[0];
}

async function setConnectState(pool, accountId, state, stripeAccountId) {
  const { rows } = await pool.query(
    `INSERT INTO connect_onboarding (account_id, stripe_account_id, state)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE
       SET state = EXCLUDED.state,
           stripe_account_id = COALESCE(EXCLUDED.stripe_account_id, connect_onboarding.stripe_account_id),
           updated_at = now()
     RETURNING account_id, stripe_account_id, state, created_at, updated_at`,
    [accountId, stripeAccountId ?? null, state],
  );
  return rows[0];
}

async function createConnectedAccount(stripe, account) {
  return stripe.accounts.create({
    type: 'express',
    email: account.email || undefined,
    metadata: { paired_account_id: account.id },
  });
}

/**
 * Issue (or re-issue) the hosted onboarding link for the artist.
 * Creates the connected account on first use and reuses it after.
 * An already-active artist needs no onboarding: no link is issued.
 * Returns { row, url } — url is null when the account is already active.
 */
export async function issueOnboardingLink(pool, stripe, account) {
  let row = await getConnectRow(pool, account.id);
  if (row.state === 'active' && row.stripe_account_id) {
    return { row, url: null };
  }

  let stripeAccountId = row.stripe_account_id;
  if (!stripeAccountId) {
    const created = await createConnectedAccount(stripe, account);
    stripeAccountId = created.id;
    row = await setConnectState(pool, account.id, row.state, stripeAccountId);
  }

  const { refreshUrl, returnUrl } = onboardingUrls();
  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });

  // A fresh link moves not_started → link_issued. Later states (pending,
  // restricted) keep their more-informative value; status refresh owns them.
  if (row.state === 'not_started' || row.state === 'link_issued') {
    row = await setConnectState(pool, account.id, 'link_issued', stripeAccountId);
  }
  return { row, url: link.url };
}

/** Derive local state from a Stripe connected-account object. */
export function deriveConnectState(stripeAccount, storedState) {
  if (stripeAccount?.requirements?.disabled_reason) return 'restricted';
  if (stripeAccount?.charges_enabled && stripeAccount?.payouts_enabled) return 'active';
  if (stripeAccount?.details_submitted) return 'pending';
  return storedState;
}

/**
 * Refresh the stored state from Stripe (when configured + an account
 * exists) and persist any change. Returns the row either way; a Stripe
 * read failure leaves the stored state untouched rather than failing the
 * artist's status read.
 */
export async function refreshConnectStatus(pool, stripe, accountId) {
  const row = await getConnectRow(pool, accountId);
  if (!stripe || !row.stripe_account_id) return row;
  let stripeAccount;
  try {
    stripeAccount = await stripe.accounts.retrieve(row.stripe_account_id);
  } catch {
    return row;
  }
  const state = deriveConnectState(stripeAccount, row.state);
  if (state === row.state) return row;
  return setConnectState(pool, accountId, state, row.stripe_account_id);
}
