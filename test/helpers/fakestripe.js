// Fake Stripe for M3 tests: stubbed at the module level (same pattern as
// the Clerk stub in testapp.js), so src/stripe.js builds its client from
// this class. Behavior is driven through stripeState: tests can inspect
// every session/transfer the engine created and force failures.
import { mock } from 'node:test';

export const stripeState = {
  sessions: [],
  transfers: [],
  failNextSessionCreate: false,
  failNextTransfer: false,
  sessionSeq: 0,
  transferSeq: 0,
  reset() {
    this.sessions = [];
    this.transfers = [];
    this.failNextSessionCreate = false;
    this.failNextTransfer = false;
  },
};

class FakeStripe {
  constructor(key, opts) {
    this.key = key;
    this.opts = opts;
  }

  checkout = {
    sessions: {
      create: async (params) => {
        if (stripeState.failNextSessionCreate) {
          stripeState.failNextSessionCreate = false;
          throw new Error('fake stripe: session create failed');
        }
        const n = ++stripeState.sessionSeq;
        const session = {
          id: `cs_test_${n}`,
          url: `https://checkout.stripe.test/pay/cs_test_${n}`,
          payment_intent: `pi_test_${n}`,
          amount_total: params.line_items[0].price_data.unit_amount,
          currency: 'usd',
          metadata: params.metadata,
        };
        stripeState.sessions.push({ session, params });
        return session;
      },
    },
  };

  transfers = {
    create: async (params, opts) => {
      if (stripeState.failNextTransfer) {
        stripeState.failNextTransfer = false;
        throw new Error('fake stripe: transfer failed');
      }
      const n = ++stripeState.transferSeq;
      const transfer = { id: `tr_test_${n}`, status: 'pending', ...params };
      stripeState.transfers.push({ transfer, params, opts });
      return transfer;
    },
  };

  accounts = {
    create: async (params) => ({ id: `acct_fake_${stripeState.sessionSeq}`, ...params }),
    retrieve: async (id) => ({
      id,
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      requirements: {},
    }),
  };

  accountLinks = {
    create: async ({ account }) => ({
      url: `https://connect.stripe.test/onboard/${account}`,
      expires_at: 9999999999,
    }),
  };

  webhooks = {
    constructEvent: (body, signature) => {
      if (signature !== 'sig_valid') {
        throw new Error('No signatures found matching the expected signature for payload.');
      }
      return JSON.parse(body);
    },
  };
}

export function installFakeStripe() {
  mock.module('stripe', {
    cache: true,
    exports: { default: FakeStripe },
  });
}
