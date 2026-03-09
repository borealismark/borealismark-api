/**
 * CORE PRINCIPLE: BorealisMark is the data layer, not the risk layer.
 * Revenue comes from: (1) Certification subscriptions, (2) Marketplace platform fees,
 * (3) Data Intelligence API access. NO insurance products. NO risk underwriting.
 */

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
    productId: process.env.STRIPE_PRO_PRODUCT_ID ?? 'prod_U75klfzF8JQGGB',
    priceId: process.env.STRIPE_PRO_PRICE_ID ?? 'price_1T8rYhJ5qkaENvhUPWdG40Gf',
    amount: 14900,
    currency: 'usd',
    interval: 'year',
    tier: 'pro',
    features: [
      'Up to 10 bot deployments',
      '3x AP multiplier',
      'Priority audit queue',
      'Enhanced analytics',
      'Pro badge on profile',
      'Email support',
      'Free first year for early adopters',
    ],
  },
  elite: {
    name: 'BorealisMark Elite',
    productId: process.env.STRIPE_ELITE_PRODUCT_ID ?? 'prod_U75kbvUp2uKsCR',
    priceId: process.env.STRIPE_ELITE_PRICE_ID ?? 'price_1T8rZ8J5qkaENvhU4ltxismU',
    amount: 34900,
    currency: 'usd',
    interval: 'year',
    tier: 'elite',
    features: [
      'Up to 50 bot deployments',
      '5x AP multiplier',
      'Dedicated audit liaison',
      '1.5% platform fee (vs 2.5% Standard)',
      'Full analytics suite',
      'Priority incident response',
      'Custom SLA options',
    ],
  },
};

// ─── Data Intelligence API Tiers ─────────────────────────────────────────────

export const API_TIERS: Record<string, StripePlan> = {
  starter: {
    name: 'API Starter (Verify)',
    productId: process.env.STRIPE_STARTER_PRODUCT_ID ?? 'prod_U75lBiQda1OI5I',
    priceId: process.env.STRIPE_STARTER_PRICE_ID ?? 'price_1T8raFJ5qkaENvhUv88yTKQH',
    amount: 2900,
    currency: 'usd',
    interval: 'month',
    tier: 'starter',
    features: [
      'Real-time agent verification',
      '25,000 API calls/month',
      'Level 1 data access',
      '5 webhooks',
    ],
  },
  business: {
    name: 'API Business (Analyze)',
    productId: process.env.STRIPE_BUSINESS_PRODUCT_ID ?? 'prod_U75mJ0CSFC36JO',
    priceId: process.env.STRIPE_BUSINESS_PRICE_ID ?? 'price_1T8ragJ5qkaENvhUtXAti480',
    amount: 14900,
    currency: 'usd',
    interval: 'month',
    tier: 'business',
    features: [
      'Historical trends & domain analytics',
      '100,000 API calls/month',
      'Level 2 data access',
      '25 webhooks',
      'Batch queries',
    ],
  },
  enterprise: {
    name: 'API Enterprise (Predict)',
    productId: process.env.STRIPE_ENTERPRISE_PRODUCT_ID ?? 'prod_U75nSvMjZVwBRa',
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID ?? 'price_1T8rbcJ5qkaENvhUF65knR1q',
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
      '1.0% platform fee',
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

// ─── USDC Pricing (5% discount over Stripe — passes processing fee savings + adoption incentive) ─

export const USDC_DISCOUNT_PERCENT = 5;

export interface UsdcPrice {
  amountUsd: number;
  stripePriceCents: number;
  discountPercent: number;
}

export const USDC_PRICES: Record<string, UsdcPrice> = {
  pro: {
    amountUsd: 141.55,         // $149.00 − 5% ≈ $141.55
    stripePriceCents: 14900,
    discountPercent: USDC_DISCOUNT_PERCENT,
  },
  elite: {
    amountUsd: 331.55,         // $349.00 − 5% ≈ $331.55
    stripePriceCents: 34900,
    discountPercent: USDC_DISCOUNT_PERCENT,
  },
  starter: {
    amountUsd: 27.55,          // $29.00 − 5% ≈ $27.55
    stripePriceCents: 2900,
    discountPercent: USDC_DISCOUNT_PERCENT,
  },
  business: {
    amountUsd: 141.55,         // $149.00 − 5% ≈ $141.55
    stripePriceCents: 14900,
    discountPercent: USDC_DISCOUNT_PERCENT,
  },
  enterprise: {
    amountUsd: 474.05,         // $499.00 − 5% ≈ $474.05
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
