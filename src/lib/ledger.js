// Ledger — append-only financial truth (M0).
//
// Entries are never updated or deleted (a trigger enforces it at the
// database level); a correction is a new entry. Every entry carries an
// idempotency key, so recording the same money fact twice — a retried
// worker, a redelivered webhook — lands exactly one row.
export async function appendLedger(
  db,
  { orderId = null, accountId = null, kind, amountCents, currency = 'USD', stripeObjectId = null, idempotencyKey, meta = {} } = {},
) {
  if (!kind) throw new Error('appendLedger: kind is required');
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error('appendLedger: amountCents must be a non-negative integer (cents)');
  }
  if (!idempotencyKey) throw new Error('appendLedger: idempotencyKey is required');
  const { rows } = await db.query(
    `INSERT INTO ledger_entries
       (order_id, account_id, kind, amount_cents, currency, stripe_object_id, idempotency_key, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [orderId, accountId, kind, amountCents, currency, stripeObjectId, idempotencyKey, JSON.stringify(meta)],
  );
  if (rows.length) return { entry: rows[0], created: true };
  const { rows: existing } = await db.query(
    'SELECT * FROM ledger_entries WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  return { entry: existing[0] || null, created: false };
}

export async function ledgerForOrder(db, orderId) {
  const { rows } = await db.query(
    'SELECT * FROM ledger_entries WHERE order_id = $1 ORDER BY created_at ASC, id ASC',
    [orderId],
  );
  return rows;
}
