/**
 * Stripe Mode Detection & Validation
 *
 * Detects whether Stripe is in test or live mode based on the secret key prefix.
 * Validates that the correct mode is being used for the environment.
 */

import { logger } from '../middleware/logger';

export type StripeMode = 'test' | 'live' | 'unconfigured';

export function getStripeMode(): StripeMode {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return 'unconfigured';
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  return 'unconfigured';
}

export function validateStripeConfig(): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mode = getStripeMode();
  const isProd = process.env.NODE_ENV === 'production';

  if (mode === 'unconfigured') {
    if (isProd) {
      errors.push('STRIPE_SECRET_KEY not configured in production');
    } else {
      warnings.push('Stripe not configured — payment features disabled');
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  if (isProd && mode === 'test') {
    warnings.push('WARNING: Stripe is in TEST mode in production. Switch to live keys before accepting real payments.');
  }

  if (!isProd && mode === 'live') {
    errors.push('DANGER: Stripe LIVE keys detected in non-production environment. This will process real charges.');
  }

  // Validate webhook secret
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    warnings.push('STRIPE_WEBHOOK_SECRET not set — webhook signature verification disabled');
  }

  // Validate product IDs match mode
  const prodIds = [
    process.env.STRIPE_PRO_PRODUCT_ID,
    process.env.STRIPE_ELITE_PRODUCT_ID,
    process.env.STRIPE_STARTER_PRODUCT_ID,
    process.env.STRIPE_BUSINESS_PRODUCT_ID,
    process.env.STRIPE_ENTERPRISE_PRODUCT_ID,
  ].filter(Boolean);

  if (mode === 'live' && prodIds.some(id => id?.startsWith('prod_') === false)) {
    warnings.push('Some Stripe product IDs may be test IDs — verify they match live mode');
  }

  logger.info(`Stripe mode: ${mode}`, { mode, isProd, webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET });

  return { valid: errors.length === 0, errors, warnings };
}
