// Immutable fee snapshot (M0 contracts).
//
// At purchase time the order stores: tier, entitled tier, rate, calculation
// version, artist share and platform share — locked forever, never recomputed
// when a membership changes later.
//
// Rates (platform share, basis points of the sale price):
//   Solo 8% · Paired 5% · Ensemble 3%
// Founding Paired ($6/mo) is a SUBSCRIPTION PRICE, not a rate: a founding
// artist's commission follows their entitled tier, so callers must pass
// `entitledTier` when tier === 'founding'.
// Processing is absorbed by the platform (M0): the artist share is exactly
// price × keep-rate; Stripe costs never come out of the artist's share.
//
// All amounts are integer cents. No floats anywhere in money math outputs.

export const CALC_VERSION = 'v1';

const RATE_BPS = Object.freeze({
  solo: 800,
  paired: 500,
  ensemble: 300,
});

const SELLING_TIERS = Object.keys(RATE_BPS);

/**
 * @param {{ tier: string, priceCents: number, entitledTier?: string }} input
 * @returns {{ tier: string, entitledTier: string, rateBps: number,
 *             priceCents: number, artistShareCents: number,
 *             platformShareCents: number, calcVersion: string }}
 */
export function feeSnapshot({ tier, priceCents, entitledTier } = {}) {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new Error('feeSnapshot: priceCents must be a non-negative integer (cents)');
  }

  let effectiveTier = tier;
  if (tier === 'founding') {
    if (!entitledTier) {
      throw new Error(
        "feeSnapshot: tier 'founding' is a subscription price, not a commission rate — pass entitledTier (the artist's entitled selling tier)",
      );
    }
    effectiveTier = entitledTier;
  }

  const rateBps = RATE_BPS[effectiveTier];
  if (rateBps === undefined) {
    throw new Error(
      `feeSnapshot: tier '${tier}' has no selling rate (selling tiers: ${SELLING_TIERS.join(', ')}; ` +
        `'inner_circle' is a collector tier and does not sell)`,
    );
  }

  const platformShareCents = Math.round((priceCents * rateBps) / 10000);
  const artistShareCents = priceCents - platformShareCents;

  return {
    tier,
    entitledTier: effectiveTier,
    rateBps,
    priceCents,
    artistShareCents,
    platformShareCents,
    calcVersion: CALC_VERSION,
  };
}

// ---------------------------------------------------------------------------
// MUSIC — 0% commission at EVERY tier, forever (PAIRED-SOUND-PLAN §1,
// ruling (C) adopted 2026-10-31). The tier buys capacity and surface,
// never a better cut — there is no cut. Card processing is absorbed by
// the platform from membership revenue; it is never netted from the
// artist's share and never added to the buyer's price, so the artist
// share of a music order is exactly the listed price. The snapshot
// records the artist's real tier (the capacity authority) with a 0 rate
// under its own calc version, so a music order can never be mistaken
// for a visual order that happened to round to zero.
// ---------------------------------------------------------------------------
export const MUSIC_CALC_VERSION = 'v1-music-0pct';

export function musicFeeSnapshot({ tier, priceCents, entitledTier } = {}) {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new Error('musicFeeSnapshot: priceCents must be a non-negative integer (cents)');
  }
  if (!tier) throw new Error('musicFeeSnapshot: tier is required (it is the capacity authority)');
  return {
    tier,
    entitledTier: entitledTier || tier,
    rateBps: 0,
    priceCents,
    artistShareCents: priceCents,
    platformShareCents: 0,
    calcVersion: MUSIC_CALC_VERSION,
  };
}

/**
 * The one fee entry point checkout uses: music listings snapshot at
 * 0% (any tier — even a collector tier's stray music listing cannot be
 * fee'd, and cannot throw the visual no-selling-rate error); every
 * other listing snapshots under the visual tier rates.
 */
export function feeSnapshotForListing({ medium, tier, priceCents, entitledTier } = {}) {
  if (medium === 'music') return musicFeeSnapshot({ tier, priceCents, entitledTier });
  return feeSnapshot({ tier, priceCents, entitledTier });
}
