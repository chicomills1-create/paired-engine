// Stripe client — lazy, guarded.
// The engine builds on the Apex Stripe account (interim merchant of
// record, see ENGINE-M0-CONTRACTS). Keys stay in TEST MODE until M7
// certification plus a separate live-commerce authorization. If no key
// is configured the engine still boots (identity legs don't need
// Stripe); money legs must check for null and fail closed.
import Stripe from 'stripe';

const API_VERSION = '2024-11-20.acacia';

let _stripe = null;

export function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = new Stripe(key, { apiVersion: API_VERSION });
  return _stripe;
}

/**
 * Verify + parse a Stripe webhook payload. Returns the event, or null
 * when no webhook secret is configured (the route answers 500
 * not_configured, mirroring the Clerk leg). Verification is pure HMAC —
 * it works on a throwaway instance when no API key is configured, so a
 * missing STRIPE_SECRET_KEY never masks a signature failure.
 * Throws on a bad signature / stale timestamp (the route answers 400).
 */
export function constructStripeEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return null;
  const stripe = getStripe() || new Stripe('sk_test_verification_only', { apiVersion: API_VERSION });
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
