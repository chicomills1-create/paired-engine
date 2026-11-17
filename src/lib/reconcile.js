// Reconciliation (M6) — the truth pass between Stripe and the ledger.
// Stripe is the external record of money movement; ledger_entries is
// ours. Where they disagree, a human decides: every discrepancy lands in
// the exception queue (dedupe-keyed, so re-running the job is safe and
// never piles up duplicates), and NOTHING here auto-corrects money.
//
// Compared, per run:
//   TRANSFERS — every Stripe transfer in the lookback window should be
//     exactly the release of one order: matched by the release record
//     (releases.stripe_transfer_id) and amount (the order's immutable
//     artist share). A Stripe transfer with no local release, an amount
//     mismatch, a reversed transfer behind a live release, or a recent
//     local transfer Stripe has never heard of — each is named.
//   LEDGER — every transferred release (Stripe or manual rail) must have
//     exactly its 'transfer' ledger entry at the artist share.
//   PAYMENTS — every settled Stripe charge in the window should match a
//     local payment: settled is payments.status 'succeeded' (+ settled_at)
//     in this engine's vocabulary.
//   PAYOUTS — transfer ≠ payout (M0): when the artist's Connect account
//     shows a PAID payout covering completed transfers, the releases'
//     payout_state advances to 'paid' (this job is the mechanism the M3
//     remainder named). A FAILED payout is an exception.
//
// Without Stripe configured the job is a no-op that says so — it never
// fabricates a clean bill of health.
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 35; // covers the weekly payout cycle + slack
const TRANSFERRED_STATES = ['created', 'paid', 'manual_recorded'];

async function listAll(listFn, params) {
  const out = [];
  let startingAfter;
  for (let page = 0; page < 50; page += 1) {
    const res = await listFn({ limit: 100, ...params, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    const data = res?.data || [];
    out.push(...data);
    if (!res?.has_more || !data.length) break;
    startingAfter = data[data.length - 1].id;
  }
  return out;
}

async function raiseException(pool, { kind, orderId = null, accountId = null, stripeObjectId = null, detail = {} }) {
  const dedupeKey = `${kind}:${stripeObjectId || orderId || accountId || 'global'}`;
  const { rows } = await pool.query(
    `INSERT INTO exception_queue (kind, order_id, account_id, stripe_object_id, detail, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET detail = EXCLUDED.detail, updated_at = now()
       WHERE exception_queue.state = 'open'
     RETURNING id, (xmax = 0) AS inserted`,
    [kind, orderId, accountId, stripeObjectId, JSON.stringify(detail), dedupeKey],
  );
  // No row back = an existing acknowledged/resolved exception already
  // carries this discrepancy; the job leaves human decisions alone.
  return rows[0] ? { id: rows[0].id, fresh: rows[0].inserted } : null;
}

export async function runReconciliation(pool, stripe, { lookbackDays = DEFAULT_LOOKBACK_DAYS, now = new Date() } = {}) {
  if (!stripe) {
    return { ran: false, reason: 'stripe_not_configured', discrepancies: [], raised: 0, payoutsAdvanced: 0, transfersSeen: 0, chargesSeen: 0 };
  }
  const windowStartMs = now.getTime() - lookbackDays * DAY_MS;
  const created = { gte: Math.floor(windowStartMs / 1000) };
  const discrepancies = [];
  let raised = 0;
  let payoutsAdvanced = 0;
  const note = async (d) => {
    discrepancies.push(d);
    const r = await raiseException(pool, d);
    if (r?.fresh) raised += 1;
  };

  // The local release picture, with the order's immutable artist share as
  // the expected transfer amount.
  const { rows: releaseRows } = await pool.query(
    `SELECT r.*, o.artist_account_id, o.artist_share_cents
       FROM releases r JOIN orders o ON o.id = r.order_id
      WHERE r.stripe_transfer_id IS NOT NULL
         OR r.transfer_state IN ('created', 'paid', 'manual_recorded')`,
  );

  // --- Transfers ---------------------------------------------------------
  const transfers = await listAll((p) => stripe.transfers.list(p), { created });
  const releasesByTransfer = new Map();
  for (const r of releaseRows) {
    if (r.stripe_transfer_id) releasesByTransfer.set(r.stripe_transfer_id, r);
  }
  const stripeTransferIds = new Set();
  for (const t of transfers) {
    stripeTransferIds.add(t.id);
    const release = releasesByTransfer.get(t.id);
    if (!release) {
      await note({
        kind: 'transfer_missing_locally',
        stripeObjectId: t.id,
        detail: { amountCents: t.amount, destination: t.destination || null, transferGroup: t.transfer_group || null },
      });
      continue;
    }
    if (t.amount !== release.artist_share_cents) {
      await note({
        kind: 'transfer_amount_mismatch',
        orderId: release.order_id,
        accountId: release.artist_account_id,
        stripeObjectId: t.id,
        detail: { stripeAmountCents: t.amount, expectedArtistShareCents: release.artist_share_cents },
      });
    }
    if ((t.amount_reversed ?? 0) > 0 && TRANSFERRED_STATES.includes(release.transfer_state)) {
      await note({
        kind: 'transfer_reversed_after_release',
        orderId: release.order_id,
        accountId: release.artist_account_id,
        stripeObjectId: t.id,
        detail: { amountReversedCents: t.amount_reversed, transferState: release.transfer_state },
      });
    }
  }
  for (const r of releaseRows) {
    if (
      r.stripe_transfer_id &&
      TRANSFERRED_STATES.includes(r.transfer_state) &&
      !stripeTransferIds.has(r.stripe_transfer_id) &&
      r.updated_at &&
      new Date(r.updated_at).getTime() >= windowStartMs
    ) {
      await note({
        kind: 'release_without_stripe_transfer',
        orderId: r.order_id,
        accountId: r.artist_account_id,
        stripeObjectId: r.stripe_transfer_id,
        detail: { expectedArtistShareCents: r.artist_share_cents, transferState: r.transfer_state },
      });
    }
  }

  // --- Ledger cross-check --------------------------------------------------
  const { rows: ledgerTransfers } = await pool.query(
    `SELECT order_id, amount_cents FROM ledger_entries WHERE kind = 'transfer'`,
  );
  const ledgerByOrder = new Map(ledgerTransfers.map((r) => [r.order_id, r.amount_cents]));
  for (const r of releaseRows) {
    if (!TRANSFERRED_STATES.includes(r.transfer_state)) continue;
    const ledgerAmount = ledgerByOrder.get(r.order_id);
    if (ledgerAmount === undefined) {
      await note({
        kind: 'release_missing_ledger_entry',
        orderId: r.order_id,
        accountId: r.artist_account_id,
        stripeObjectId: r.stripe_transfer_id,
        detail: { expectedArtistShareCents: r.artist_share_cents, rail: r.rail },
      });
    } else if (ledgerAmount !== r.artist_share_cents) {
      await note({
        kind: 'ledger_amount_mismatch',
        orderId: r.order_id,
        accountId: r.artist_account_id,
        stripeObjectId: r.stripe_transfer_id,
        detail: { ledgerAmountCents: ledgerAmount, expectedArtistShareCents: r.artist_share_cents },
      });
    }
  }

  // --- Payments ------------------------------------------------------------
  const charges = await listAll((p) => stripe.charges.list(p), { created });
  const settledCharges = charges.filter((c) => c.paid === true && c.status === 'succeeded');
  if (settledCharges.length) {
    const piIds = settledCharges.map((c) => c.payment_intent).filter(Boolean);
    const { rows: paymentRows } = piIds.length
      ? await pool.query(
          'SELECT order_id, amount_cents, tax_cents, status, stripe_payment_intent_id FROM payments WHERE stripe_payment_intent_id = ANY($1)',
          [piIds],
        )
      : [];
    const localByPi = new Map(paymentRows.map((p) => [p.stripe_payment_intent_id, p]));
    for (const c of settledCharges) {
      const local = c.payment_intent ? localByPi.get(c.payment_intent) : null;
      if (!local) {
        await note({
          kind: 'payment_settled_not_recorded',
          stripeObjectId: c.payment_intent || c.id,
          detail: { chargeId: c.id, amountCents: c.amount },
        });
        continue;
      }
      if (local.status !== 'succeeded' && local.status !== 'partially_refunded') {
        await note({
          kind: 'payment_settled_not_recorded',
          orderId: local.order_id,
          stripeObjectId: c.payment_intent,
          detail: { chargeId: c.id, amountCents: c.amount, localStatus: local.status },
        });
      } else if (local.amount_cents + (local.tax_cents ?? 0) !== c.amount) {
        // Pricing is tax-EXCLUSIVE (§3): the charge total is the item
        // price plus the tax Stripe collected, while amount_cents stays
        // the item price. The expected charge is the two together —
        // comparing against the price alone would flag every taxed
        // sale as a discrepancy.
        await note({
          kind: 'payment_amount_mismatch',
          orderId: local.order_id,
          stripeObjectId: c.payment_intent,
          detail: {
            stripeAmountCents: c.amount,
            localAmountCents: local.amount_cents,
            localTaxCents: local.tax_cents ?? null,
            expectedTotalCents: local.amount_cents + (local.tax_cents ?? 0),
          },
        });
      }
    }
  }

  // --- Payouts ---------------------------------------------------------------
  // For each artist with a paid transfer still awaiting payout
  // confirmation, read the Connect account's payouts: PAID payouts
  // confirm the oldest awaiting releases up to the paid total; a FAILED
  // payout is an exception a human must see.
  const { rows: awaiting } = await pool.query(
    `SELECT r.order_id, o.artist_account_id, c.stripe_account_id
       FROM releases r
       JOIN orders o ON o.id = r.order_id
       JOIN connect_onboarding c ON c.account_id = o.artist_account_id
      WHERE r.transfer_state = 'paid'
        AND r.payout_state = 'pending'
        AND c.stripe_account_id IS NOT NULL`,
  );
  const byAccount = new Map();
  for (const row of awaiting) {
    if (!byAccount.has(row.stripe_account_id)) byAccount.set(row.stripe_account_id, []);
    byAccount.get(row.stripe_account_id).push(row);
  }
  for (const [stripeAccountId, rowsForAccount] of byAccount) {
    let payouts;
    try {
      payouts = await listAll((p) => stripe.payouts.list(p, { stripeAccount: stripeAccountId }), { created });
    } catch {
      continue; // a restricted account's read failure is not a discrepancy
    }
    for (const p of payouts.filter((x) => x.status === 'failed')) {
      await note({
        kind: 'payout_failed',
        accountId: rowsForAccount[0].artist_account_id,
        stripeObjectId: p.id,
        detail: { stripeAccountId, amountCents: p.amount, failureCode: p.failure_code || null },
      });
    }
    const paid = payouts.filter((x) => x.status === 'paid');
    if (paid.length) {
      let remaining = paid.reduce((n, p) => n + p.amount, 0);
      const { rows: amounts } = await pool.query(
        `SELECT r.order_id, o.artist_share_cents
           FROM releases r JOIN orders o ON o.id = r.order_id
          WHERE r.order_id = ANY($1)
          ORDER BY r.updated_at ASC`,
        [rowsForAccount.map((r) => r.order_id)],
      );
      for (const a of amounts) {
        if (remaining < a.artist_share_cents) break;
        remaining -= a.artist_share_cents;
        const { rows: updated } = await pool.query(
          `UPDATE releases
              SET payout_state = 'paid', stripe_payout_id = $2, updated_at = now()
            WHERE order_id = $1 AND payout_state = 'pending'
            RETURNING order_id`,
          [a.order_id, paid[0].id],
        );
        payoutsAdvanced += updated.length;
      }
    }
  }

  return { ran: true, discrepancies, raised, payoutsAdvanced, transfersSeen: transfers.length, chargesSeen: settledCharges.length };
}
