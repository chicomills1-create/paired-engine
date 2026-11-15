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
