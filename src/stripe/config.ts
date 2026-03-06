/**
 * BorealisMark Stripe + USDC Pricing Configuration
 * Maps internal product tiers to Stripe product/price IDs
 * Env-var overrides allow seamless sandbox → live migration
 *
 * Account: Borealis Protocol (acct_1T7Kc2J5qkaENvhU) — LIVE
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
    productId: process.env.STRIPE_PRO_PRODUCT_ID ?? 'prod_U66ZErtSnBzoBL',
    priceId: process.env.STRIPE_PRO_PRICE_ID ?? 'price_1T7uLvJ5qkaENvhUnLYNkUrI',
    amount: 9999,
    currency: 'usd',
    interval: 'year',
    tier: 'pro',
    features: [
      '3x AP multiplier',
      'Priority support',
      'Enhanced analytics',
      'Custom badge styling',
    ],
  },
  elite: {
    name: 'BorealisMark Elite',
    productId: process.env.STRIPE_ELITE_PRODUCT_ID ?? 'prod_U66ZiaE5IPDZuf',
    priceId: process.env.STRIPE_ELITE_PRICE_ID ?? 'price_1T7uLsJ5qkaENvhU1X2hN83W',
    amount: 14999,
    currency: 'usd',
    interval: 'year',
    tier: 'elite',
    features: [
      '5x AP multiplier',
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
    productId: process.env.STRIPE_STARTER_PRODUCT_ID ?? 'prod_U66ZJLWLqbMeyt',
    priceId: process.env.STRIPE_STARTER_PRICE_ID ?? 'price_1T7uLtJ5qkaENvhUYrD3Ss5e',
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
    productId: process.env.STRIPE_BUSINESS_PRODUCT_ID ?? 'prod_U66YidiqsewMKf',
    priceId: process.env.STRIPE_BUSINESS_PRICE_ID ?? 'price_1T7uLrJ5qkaENvhUQ1GOXfhH',
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
    productId: process.env.STRIPE_ENTERPRISE_PRODUCT_ID ?? 'prod_U66Z8frvO4c8Ef',
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID ?? 'price_1T7uLuJ5qkaENvhUBvPN4AXr',
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

// ─── USDC Pricing (3% discount over Stripe — passes processing fee savings) ─

export const USDC_DISCOUNT_PERCENT = 3;

export interface UsdcPrice {
  amountUsd: number;
  stripePriceCents: number;
  discountPercent: number;
}

export const USDC_PRICES: Record<string, UsdcPrice> = {
  pro: {
    amountUsd: 96.99,          // $99.99 − 3% ≈ $96.99
    stripePriceCents: 9999,
    discountPercent: USDC_DISCOUNT_PERCENT,
  },
  elite: {
    amountUsd: 145.49,         // $149.99 − 3% ≈ $145.49
    stripePriceCents: 14999,
    discountPercent: USDC_DISCOUNT_PERCENT,
  },
  starter: {
    amountUsd: 47.53,          // $49.00 − 3% ≈ $47.53
    stripePriceCents: 4900,
    discountPercent: USDC_DISCOUNT_PERCENT,
  },
  business: {
    amountUsd: 193.03,         // $199.00 − 3% ≈ $193.03
    stripePriceCents: 19900,
    discountPercent: USDC_DISCOUNT_PERCENT,
  },
  enterprise: {
    amountUsd: 484.03,         // $499.00 − 3% ≈ $484.03
    stripePriceCents: 49900,
    discountPercent: USDC_DISCOUNT_PERCENT,
  },
};

/**
 * Get the USDC price for a plan, optionally with an additional coupon discount.
 */
export function getUsdcPriceWithDiscount(
  planId: string,
  couponDiscountPercent: number = 0,
): { amountUsd: number; originalUsd: number; totalDiscountPercent: number } | null {
  const usdcPrice = USDC_PRICES[planId];
  if (!usdcPrice) return null;

  const baseUsdcAmount = usdcPrice.amountUsd;
  const couponDiscount = couponDiscountPercent > 0
    ? baseUsdcAmount * (couponDiscountPercent / 100)
    : 0;
  const finalAmount = Math.round((baseUsdcAmount - couponDiscount) * 100) / 100;

  return {
    amountUsd: finalAmount,
    originalUsd: usdcPrice.amountUsd,
    totalDiscountPercent: usdcPrice.discountPercent + couponDiscountPercent,
  };
}
