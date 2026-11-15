// The buy-door predicate (M0 + consult M3-02).
//
// A listing is purchasable ONLY when all seven conditions pass. This pure
// function is the single source of truth for the rule; the server re-checks
// it at checkout creation (a disabled frontend button is not a control).
// An artist may hold drafts before payout eligibility clears — drafts simply
// never pass this door.
//
// Input shape (plain object, all fields optional — anything missing fails):
// {
//   artist:          { status: 'active'|..., approved: boolean },
//   listing:         { status: 'published'|..., humanMadeVerification: 'approved'|...,
//                      inventoryAvailable: number },
//   sale:            { saleType: string, currency: string, destinationSupported: boolean },
//   connectedAccount:{ transfers: 'active'|..., payouts: 'active'|... },
//   holds:           { compliance: bool, fraud: bool, moderation: bool }  // or string[] of active holds
//   reservation:     { canReserve: boolean, checkoutCreatable: boolean }
// }
//
// Returns { ok: boolean, failed: string[] } with stable condition names.

export const BUY_DOOR_CONDITIONS = Object.freeze([
  'artist_account_active_approved',
  'listing_human_made_verified',
  'listing_published_with_inventory',
  'sale_type_destination_currency_supported',
  'connected_account_transfer_payout_capable',
  'no_compliance_fraud_moderation_hold',
  'server_can_reserve_and_create_checkout',
]);

const SUPPORTED_SALE_TYPES = new Set(['original', 'digital', 'commission']);
const SUPPORTED_CURRENCIES = new Set(['USD']);

function hasHold(holds, kind) {
  if (!holds) return false;
  if (Array.isArray(holds)) return holds.includes(kind);
  return holds[kind] === true;
}

export function buyDoor(input = {}) {
  const { artist, listing, sale, connectedAccount, holds, reservation } = input;
  const failed = [];

  // 1. Artist account is active and approved.
  if (!(artist && artist.status === 'active' && artist.approved === true)) {
    failed.push('artist_account_active_approved');
  }

  // 2. Human-made listing verification is approved.
  if (!(listing && listing.humanMadeVerification === 'approved')) {
    failed.push('listing_human_made_verified');
  }

  // 3. Listing is published, with available inventory.
  if (
    !(
      listing &&
      listing.status === 'published' &&
      Number.isInteger(listing.inventoryAvailable) &&
      listing.inventoryAvailable > 0
    )
  ) {
    failed.push('listing_published_with_inventory');
  }

  // 4. Supported sale type, shipping destination, and currency.
  if (
    !(
      sale &&
      SUPPORTED_SALE_TYPES.has(sale.saleType) &&
      SUPPORTED_CURRENCIES.has(sale.currency) &&
      sale.destinationSupported === true
    )
  ) {
    failed.push('sale_type_destination_currency_supported');
  }

  // 5. Connected account has the required transfer and payout capabilities.
  if (
    !(
      connectedAccount &&
      connectedAccount.transfers === 'active' &&
      connectedAccount.payouts === 'active'
    )
  ) {
    failed.push('connected_account_transfer_payout_capable');
  }

  // 6. No compliance, fraud, or moderation hold is active.
  if (hasHold(holds, 'compliance') || hasHold(holds, 'fraud') || hasHold(holds, 'moderation')) {
    failed.push('no_compliance_fraud_moderation_hold');
  }

  // 7. The server can reserve the item and create the checkout safely.
  if (!(reservation && reservation.canReserve === true && reservation.checkoutCreatable === true)) {
    failed.push('server_can_reserve_and_create_checkout');
  }

  return { ok: failed.length === 0, failed };
}
