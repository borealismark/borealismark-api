/**
 * BorealisMark Stripe Configuration
 * Maps internal product tiers to Stripe product/price IDs
 *
 * Account: Borealis Protocol sandbox (acct_1T7KcEQsztBl8gR0)
 * Environment: Test/Sandbox
 */

export interface StripePlan {
  name: string;
  productId: string;
  priceId: string;
  amount: number;        // cents
  currency: 'usd';
  interval: 'month' | 'year';
  tier: string;
  features: string[];
}

// ─── Agent Certification Plans ───────────────────────────────────────────────

export const AGENT_PLANS: Record<string, StripePlan> = {
  pro: {
    name: 'BorealisMark Pro',
    productId: 'prod_U5VmfMgKCZCh18',
    priceId: 'price_1T7KkVQsztBl8gR06PqRED5X',
    amount: 9999,
    currency: 'usd',
    interval: 'year',
    tier: 'pro',
    features: [
      '3x CP multiplier',
      'Priority support',
      'Enhanced analytics',
      'Custom badge styling',
    ],
  },
  elite: {
    name: 'BorealisMark Elite',
    productId: 'prod_U5VqdtaqhEhCc3',
    priceId: 'price_1T7KpBQsztBl8gR0Sw0dIUlp',
    amount: 14999,
    currency: 'usd',
    interval: 'year',
    tier: 'elite',
    features: [
      '5x CP multiplier',
      'Full analytics suite',
      'Priority support',
      'Advanced features',
      'Custom integrations',
    ],
  },
};

// ─── Data Intelligence API Tiers ─────────────────────────────────────────────

export const API_TIERS: Record<string, StripePlan> = {
  starter: {
    name: 'API Starter (Verify)',
    productId: 'prod_U5Vsmz5uXncqiL',
    priceId: 'price_1T7KqgQsztBl8gR0tdsJbqPb',
    amount: 4900,
    currency: 'usd',
    interval: 'month',
    tier: 'starter',
    features: [
      'Real-time agent verification',
      '1,000 API calls/month',
      'Level 1 data access',
      'Basic webhooks',
    ],
  },
  business: {
    name: 'API Business (Analyze)',
    productId: 'prod_U5Vu2PTSyp5rN0',
    priceId: 'price_1T7KsQQsztBl8gR0CzR812k2',
    amount: 19900,
    currency: 'usd',
    interval: 'month',
    tier: 'business',
    features: [
      'Historical trends & domain analytics',
      '10,000 API calls/month',
      'Level 2 data access',
      'Advanced webhooks',
      'Batch queries',
    ],
  },
  enterprise: {
    name: 'API Enterprise (Predict)',
    productId: 'prod_U5VvYWoeKZPDo5',
    priceId: 'price_1T7KtzQsztBl8gR04V8Tw1Dt',
    amount: 49900,
    currency: 'usd',
    interval: 'month',
    tier: 'enterprise',
    features: [
      'Predictive intelligence API',
      'Unlimited API calls',
      'Level 3 data access',
      'White-label badges',
      'Dedicated support',
      'Custom SLA',
    ],
  },
};

// ─── Lookup Helpers ──────────────────────────────────────────────────────────

export const ALL_PLANS = { ...AGENT_PLANS, ...API_TIERS };

export function getPlanByPriceId(priceId: string): StripePlan | undefined {
  return Object.values(ALL_PLANS).find(p => p.priceId === priceId);
}

export function getPlanByProductId(productId: string): StripePlan | undefined {
  return Object.values(ALL_PLANS).find(p => p.productId === productId);
}
