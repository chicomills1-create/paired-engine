// Stripe client — init guard only for M1.
// The engine builds on the Apex Stripe account (interim merchant of record,
// see ENGINE-M0-CONTRACTS). Keys stay in TEST MODE until M7 certification
// plus a separate live-commerce authorization. If no key is configured the
// engine still boots (identity legs don't need Stripe); money legs must
// check for null and fail closed.
import Stripe from 'stripe';

let _stripe = null;

export function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = new Stripe(key, { apiVersion: '2024-11-20.acacia' });
  return _stripe;
}
