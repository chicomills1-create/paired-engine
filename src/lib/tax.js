// Stripe Tax classification (activation §3 — ChatGPT consult
// 2026-11-16, TAX-01…TAX-04).
//
// Stripe Tax calculates from the LINE ITEM's product tax code; an item
// with no code inherits the account preset (General — Electronically
// Supplied Services), which is the WRONG classification for a shipped
// painting or a music download. Every Checkout line item this engine
// creates therefore carries an explicit code, resolved from what is
// actually being sold:
//
//   physical artwork (listing or commission)  txcd_99999999
//     General — Tangible Goods
//   digital finished artwork (listing or      txcd_10505001
//     commission)                               Digital Finished Artwork —
//                                               downloaded, non-subscription,
//                                               permanent rights
//   music release (permanent download)        txcd_10401100
//     Digital Audio Works — downloaded,
//     non-subscription, permanent rights
//     (Paired Sound sells permanent downloads only; the time-limited
//     code txcd_10401001 is deliberately never used)
//   artist services (commission whose         txcd_20030000
//     deliverable is a service)               General — Services
//
// Pricing is tax-EXCLUSIVE (TAX-04): the published price is the item
// price, tax is added on top by Stripe, and the collected tax never
// enters the fee snapshot or the artist transfer — settlement math is
// pinned to the order record (see stripeEvents.js / release.js).
//
// Liability stays with the platform ('self'): under the separate
// charges + transfers model the platform is merchant of record and
// remits; the connected artist never carries the tax liability.
//
// A classification that cannot be resolved returns null and the caller
// FAILS CLOSED — no session is created and nothing falls back to the
// account default.

export const TAX_CODE_PHYSICAL = 'txcd_99999999';
export const TAX_CODE_DIGITAL_ARTWORK = 'txcd_10505001';
export const TAX_CODE_MUSIC = 'txcd_10401100';
export const TAX_CODE_SERVICE = 'txcd_20030000';

/** The session-level automatic_tax parameter (fresh object per call). */
export function automaticTaxParam() {
  return { enabled: true, liability: { type: 'self' } };
}

/**
 * The session-level tax fragment: automatic tax + the address
 * collection the calculation (and, for physical goods, fulfillment)
 * needs. Physical orders collect a US shipping address (destination-
 * based tax + the artist ships to it); everything else lets Checkout
 * collect the billing address automatically.
 */
export function taxSessionParams({ physical }) {
  return {
    automatic_tax: automaticTaxParam(),
    ...(physical
      ? { shipping_address_collection: { allowed_countries: ['US'] } }
      : { billing_address_collection: 'auto' }),
  };
}

/**
 * Classify a LISTING for Checkout. The listing record itself declares
 * everything: medium 'music' is a release (always digital); a visual
 * listing's type is 'physical' or 'digital' by schema constraint.
 * Returns { taxCode, physical } or null if the record is somehow
 * outside the schema's own constraints (fail closed, never guess).
 */
export function classifyListingTax(listing) {
  if (!listing) return null;
  if (listing.medium === 'music') return { taxCode: TAX_CODE_MUSIC, physical: false };
  if (listing.type === 'physical') return { taxCode: TAX_CODE_PHYSICAL, physical: true };
  if (listing.type === 'digital') return { taxCode: TAX_CODE_DIGITAL_ARTWORK, physical: false };
  return null;
}

/**
 * Classify a COMMISSION from the brief's declared deliverable type
 * (briefs.deliverable_type, migration 0007): 'physical' | 'digital' |
 * 'service'. Anything else — including NULL, an undeclared legacy
 * brief — returns null and the accept door fails closed.
 */
export function classifyCommissionTax(deliverableType) {
  switch (deliverableType) {
    case 'physical':
      return { taxCode: TAX_CODE_PHYSICAL, physical: true };
    case 'digital':
      return { taxCode: TAX_CODE_DIGITAL_ARTWORK, physical: false };
    case 'service':
      return { taxCode: TAX_CODE_SERVICE, physical: false };
    default:
      return null;
  }
}

/**
 * The tax Stripe collected on a completed Checkout session, in cents,
 * or null when the session carries no trustworthy figure (the
 * payment-intent event has none — the session twin records it).
 */
export function sessionTaxCents(session) {
  const amt = session?.total_details?.amount_tax;
  return Number.isInteger(amt) && amt >= 0 ? amt : null;
}
