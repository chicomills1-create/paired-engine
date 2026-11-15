// One-of-one inventory state machine (M0 contracts).
//
// Every Paired artwork is one of one: a piece can be sold exactly once.
// The state lives on listings.inventory_state:
//
//   available → reserved   (checkout creation places a 15-minute hold — M3)
//   reserved  → available  (hold released / expired)
//   reserved  → sold       (release completed)
//   available → sold       (direct completion without a hold)
//
// Transitions happen ONLY through transitionInventory(): a single guarded
// UPDATE ... WHERE inventory_state = $from ... RETURNING. The guard makes
// the transition atomic — under a race, exactly one caller's UPDATE matches
// the row; the other matches nothing and learns the current state. Routes
// and workers never write inventory_state directly.

export const INVENTORY_STATES = Object.freeze(['available', 'reserved', 'sold']);

const ALLOWED = Object.freeze({
  available: Object.freeze(['reserved', 'sold']),
  reserved: Object.freeze(['available', 'sold']),
  sold: Object.freeze([]),
});

export function isAllowedTransition(from, to) {
  return Boolean(ALLOWED[from] && ALLOWED[from].includes(to));
}

/**
 * Attempt one inventory transition.
 *
 * @param {object} db  pg Pool or Client (anything with .query).
 * @param {{ listingId: string, from: string, to: string,
 *           reservedUntil?: Date|string|null, reservationRef?: string|null }} input
 *   reservedUntil / reservationRef are recorded when moving INTO 'reserved';
 *   both are cleared when moving back to 'available'; reservedUntil is
 *   cleared on 'sold' (the ref is kept for traceability).
 * @returns {Promise<{ transitioned: true, listing: object } |
 *                    { transitioned: false, currentState: string|null }>}
 *   currentState is null when the listing does not exist.
 * @throws on a (from, to) pair the state machine forbids — that is a caller
 *   bug, not a runtime condition, so it never resolves as a quiet false.
 */
export async function transitionInventory(db, { listingId, from, to, reservedUntil = null, reservationRef = null } = {}) {
  if (!listingId) throw new Error('transitionInventory: listingId is required');
  if (!isAllowedTransition(from, to)) {
    throw new Error(`transitionInventory: transition ${from} -> ${to} is not allowed`);
  }

  const { rows } = await db.query(
    `UPDATE listings
        SET inventory_state = $1,
            reserved_until = CASE
              WHEN $2 = 'reserved' THEN $3::timestamptz
              ELSE NULL
            END,
            reservation_ref = CASE
              WHEN $2 = 'reserved' THEN $4
              WHEN $2 = 'available' THEN NULL
              ELSE reservation_ref
            END,
            updated_at = now()
      WHERE id = $5 AND inventory_state = $6
      RETURNING *`,
    [to, to, reservedUntil, reservationRef, listingId, from],
  );
  if (rows.length) {
    return { transitioned: true, listing: rows[0] };
  }

  const { rows: current } = await db.query(
    'SELECT inventory_state FROM listings WHERE id = $1',
    [listingId],
  );
  return { transitioned: false, currentState: current.length ? current[0].inventory_state : null };
}
