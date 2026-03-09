/**
 * BorealisMark Unified Payment Routes
 * Dual payment system: Stripe (card) + Hedera USDC (crypto)
 * Includes: subscription expiry tracking, USDC discount pricing, coupon system
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  createCheckoutSession,
  getCustomerSubscriptions,
  createBillingPortalSession,
  constructWebhookEvent,
} from '../stripe/client';
import {
  ALL_PLANS, AGENT_PLANS, API_TIERS,
  getPlanByPriceId, USDC_PRICES,
  getUsdcPriceWithDiscount, USDC_DISCOUNT_PERCENT,
} from '../stripe/config';
import {
  createUsdcInvoice,
  getInvoice,
  updateInvoiceStatus,
  verifyUsdcPayment,
  anchorPaymentReceiptOnHCS,
  getInvoiceRecord,
  persistConfirmation,
  USDC_TOKEN_ID,
  TREASURY_ACCOUNT_ID,
} from '../hedera/usdc';
import { logger } from '../middleware/logger';
import {
  getUserByEmail,
  getUserById,
  updateUserTier,
  updateUserStripe,
  getUserByStripeCustomerId,
  setSubscriptionExpiry,
  validateCoupon,
  getCouponByCode,
  incrementCouponUsage,
  createCoupon,
  listCoupons,
  deactivateCoupon,
  saveUsdcInvoiceWithDiscount,
} from '../db/database';
import { v4 as uuidv4 } from 'uuid';
import { events as eventBus } from '../services/eventBus';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Calculate subscription expiry from now based on plan interval */
function calculateExpiryFromNow(planId: string): number {
  const plan = ALL_PLANS[planId];
  if (!plan) return Date.now() + 365 * 24 * 60 * 60 * 1000; // default: 1 year
  if (plan.interval === 'year') return Date.now() + 365 * 24 * 60 * 60 * 1000;
  return Date.now() + 30 * 24 * 60 * 60 * 1000; // monthly
}

/** Extend expiry from the current expiry date (for renewals) or from now */
function calculateRenewalExpiry(currentExpiresAt: number | null, planId: string): number {
  const plan = ALL_PLANS[planId];
  const duration = plan?.interval === 'year'
    ? 365 * 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000;

  // If current subscription hasn't expired yet, extend from expiry date
  if (currentExpiresAt && currentExpiresAt > Date.now()) {
    return currentExpiresAt + duration;
  }
  // Otherwise start from now
  return Date.now() + duration;
}

const planToTier: Record<string, 'standard' | 'pro' | 'elite'> = {
  pro: 'pro',
  elite: 'elite',
  starter: 'pro',
  business: 'pro',
  enterprise: 'elite',
};

// ─── GET /v1/payments/plans ──────────────────────────────────────────────────
// Public: List all available plans with pricing + accepted payment methods

router.get('/plans', (_req: Request, res: Response) => {
  const formatPlan = ([key, plan]: [string, any]) => {
    const usdcPrice = USDC_PRICES[key];
    return {
      id: key,
      name: plan.name,
      amount: plan.amount / 100,
      currency: plan.currency,
      interval: plan.interval,
      features: plan.features,
      paymentMethods: {
        stripe: {
          priceId: plan.priceId,
          type: 'card',
          processingFee: '~3.4%',
          amount: plan.amount / 100,
        },
        usdc: {
          tokenId: USDC_TOKEN_ID,
          treasuryAccount: TREASURY_ACCOUNT_ID,
          network: process.env.HEDERA_NETWORK ?? 'testnet',
          type: 'crypto',
          processingFee: '~$0.001',
          amount: usdcPrice?.amountUsd ?? plan.amount / 100,
          discountPercent: usdcPrice?.discountPercent ?? 0,
          savingsNote: usdcPrice ? `Save ${usdcPrice.discountPercent}% with USDC` : undefined,
        },
      },
    };
  };

  res.json({
    success: true,
    data: {
      agentPlans: Object.entries(AGENT_PLANS).map(formatPlan),
      apiTiers: Object.entries(API_TIERS).map(formatPlan),
      acceptedMethods: ['stripe', 'usdc'],
      usdcDiscountPercent: USDC_DISCOUNT_PERCENT,
      note: 'Choose "stripe" for card payments or "usdc" for USDC stablecoin on Hedera. USDC saves ~3% (no processing fees).',
    },
    timestamp: Date.now(),
  });
});

// ─── POST /v1/payments/checkout ──────────────────────────────────────────────
// Unified checkout — routes to Stripe or USDC based on `method` field

const checkoutSchema = z.object({
  planId: z.string().refine(id => id in ALL_PLANS, { message: 'Invalid plan ID' }),
  method: z.enum(['stripe', 'usdc']),
  email: z.string().email(),
  agentId: z.string().optional(),
  couponCode: z.string().optional(),
  isRenewal: z.boolean().optional().default(false),
  // Stripe-specific
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

router.post('/checkout', async (req: Request, res: Response) => {
  try {
    const body = checkoutSchema.parse(req.body);
    const plan = ALL_PLANS[body.planId];

    // ── Validate coupon if provided ──
    let couponDiscount = 0;
    let couponRecord: any = null;
    if (body.couponCode) {
      const validation = validateCoupon(body.couponCode, body.planId, body.isRenewal);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: validation.reason ?? 'Invalid coupon',
          timestamp: Date.now(),
        });
      }
      couponRecord = validation.coupon;
      couponDiscount = couponRecord!.discountPercent;
    }

    // ── Stripe Card Checkout ──
    if (body.method === 'stripe') {
      // For Stripe, coupons would need to be created as Stripe Coupon objects
      // For now, we apply coupons only to USDC payments
      const session = await createCheckoutSession({
        priceId: plan.priceId,
        customerEmail: body.email,
        agentId: body.agentId,
        successUrl: body.successUrl ?? `${process.env.FRONTEND_URL ?? 'https://borealismark.com'}/dashboard.html?payment=success`,
        cancelUrl: body.cancelUrl ?? `${process.env.FRONTEND_URL ?? 'https://borealismark.com'}/dashboard.html?payment=cancelled`,
      });

      logger.info('Stripe checkout created', {
        sessionId: session.id,
        planId: body.planId,
        email: body.email,
        method: 'stripe',
      });

      return res.json({
        success: true,
        data: {
          method: 'stripe',
          sessionId: session.id,
          url: session.url,
        },
        timestamp: Date.now(),
      });
    }

    // ── USDC Hedera Checkout ──
    if (body.method === 'usdc') {
      // Calculate USDC price with built-in 3% discount + any coupon
      const pricing = getUsdcPriceWithDiscount(body.planId, couponDiscount);
      const amountUsd = pricing ? pricing.amountUsd : plan.amount / 100;
      const originalUsd = pricing ? pricing.originalUsd : plan.amount / 100;

      const invoice = createUsdcInvoice(body.planId, amountUsd, body.email, body.agentId);

      // If there's a coupon, save the extended invoice with discount info
      if (couponRecord) {
        // The invoice was already saved by createUsdcInvoice — update the coupon fields
        // We'll handle this by saving extra fields after creation
        try {
          const { getDb } = await import('../db/database');
          getDb()
            .prepare('UPDATE usdc_invoices SET coupon_id = ?, discount_percent = ?, original_amount_usd = ? WHERE invoice_id = ?')
            .run(couponRecord.id, couponDiscount, plan.amount / 100, invoice.invoiceId);
          incrementCouponUsage(couponRecord.id);
        } catch (e) {
          logger.warn('Failed to update invoice with coupon info', { error: (e as Error).message });
        }
      }

      logger.info('USDC checkout created', {
        invoiceId: invoice.invoiceId,
        planId: body.planId,
        email: body.email,
        method: 'usdc',
        amountUsdc: invoice.amountUsdc,
        couponCode: body.couponCode ?? null,
        couponDiscount,
      });

      return res.json({
        success: true,
        data: {
          method: 'usdc',
          invoiceId: invoice.invoiceId,
          payment: {
            sendTo: invoice.treasuryAccountId,
            tokenId: invoice.tokenId,
            amount: invoice.amountUsdc,
            currency: 'USDC',
            memo: invoice.memo,
            network: process.env.HEDERA_NETWORK ?? 'testnet',
          },
          pricing: {
            stripePrice: plan.amount / 100,
            usdcPrice: amountUsd,
            usdcBaseDiscount: USDC_DISCOUNT_PERCENT,
            couponDiscount: couponDiscount,
            totalSavings: ((plan.amount / 100) - amountUsd).toFixed(2),
          },
          expiresAt: invoice.expiresAt,
          instructions: [
            `Send exactly ${invoice.amountUsdc} USDC to Hedera account ${invoice.treasuryAccountId}`,
            `Include memo: ${invoice.memo}`,
            `Payment must be received within 30 minutes`,
            `Use POST /v1/payments/usdc/verify/${invoice.invoiceId} to confirm`,
          ],
        },
        timestamp: Date.now(),
      });
    }
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: err.errors,
        timestamp: Date.now(),
      });
    }
    logger.error('Checkout creation failed', { error: err.message });
    res.status(500).json({
      success: false,
      error: 'Failed to create checkout session',
      timestamp: Date.now(),
    });
  }
});

// ─── GET /v1/payments/usdc/invoice/:invoiceId ────────────────────────────────
// Check USDC invoice status

router.get('/usdc/invoice/:invoiceId', (req: Request, res: Response) => {
  const invoice = getInvoice(req.params.invoiceId);
  if (!invoice) {
    return res.status(404).json({
      success: false,
      error: 'Invoice not found',
      timestamp: Date.now(),
    });
  }

  // Check if expired — use the canonical updater
  if (invoice.status === 'pending' && Date.now() > invoice.expiresAt) {
    updateInvoiceStatus(invoice.invoiceId, 'expired');
    invoice.status = 'expired'; // keep local ref in sync for this response
  }

  res.json({
    success: true,
    data: {
      invoiceId: invoice.invoiceId,
      planId: invoice.planId,
      amountUsdc: invoice.amountUsdc,
      status: invoice.status,
      treasuryAccountId: invoice.treasuryAccountId,
      tokenId: invoice.tokenId,
      memo: invoice.memo,
      expiresAt: invoice.expiresAt,
      createdAt: invoice.createdAt,
    },
    timestamp: Date.now(),
  });
});

// ─── POST /v1/payments/usdc/verify/:invoiceId ────────────────────────────────
// Verify a USDC payment via Hedera Mirror Node

router.post('/usdc/verify/:invoiceId', async (req: Request, res: Response) => {
  const { invoiceId } = req.params;
  const invoice = getInvoice(invoiceId);

  if (!invoice) {
    return res.status(404).json({
      success: false,
      error: 'Invoice not found',
      timestamp: Date.now(),
    });
  }

  if (invoice.status === 'confirmed') {
    return res.json({
      success: true,
      data: {
        status: 'already_confirmed',
        invoiceId,
        message: 'This payment has already been confirmed',
      },
      timestamp: Date.now(),
    });
  }

  if (invoice.status === 'expired') {
    return res.status(410).json({
      success: false,
      error: 'Invoice has expired. Please create a new checkout.',
      timestamp: Date.now(),
    });
  }

  try {
    const confirmation = await verifyUsdcPayment(invoiceId);

    if (!confirmation) {
      return res.json({
        success: true,
        data: {
          status: 'pending',
          invoiceId,
          message: 'Payment not yet detected. Please ensure you sent the correct amount with the right memo.',
          retryIn: 10, // seconds
        },
        timestamp: Date.now(),
      });
    }

    // Payment confirmed — anchor on HCS
    const hcsReceipt = await anchorPaymentReceiptOnHCS(confirmation, invoice.planId);

    // Persist full confirmation to database
    persistConfirmation(
      invoiceId,
      confirmation.transactionId,
      confirmation.fromAccount,
      confirmation.consensusTimestamp,
      hcsReceipt?.topicId,
      hcsReceipt?.sequenceNumber,
    );

    // ── Activate subscription: upgrade user tier + set expiry ──
    const invoiceRecord = getInvoiceRecord(invoiceId);
    let tierUpgraded = false;
    let newTier: string | null = null;

    if (invoiceRecord?.email) {
      const user = getUserByEmail(invoiceRecord.email);
      if (user) {
        const targetTier = planToTier[invoice.planId] ?? 'pro';
        updateUserTier(user.id, targetTier);

        // Set subscription expiry — extend from current if renewing
        const expiresAt = calculateRenewalExpiry(user.subscriptionExpiresAt, invoice.planId);
        setSubscriptionExpiry(user.id, expiresAt, 'usdc', invoice.planId);

        tierUpgraded = true;
        newTier = targetTier;
        logger.info('User tier upgraded via USDC payment', {
          userId: user.id,
          email: invoiceRecord.email,
          previousTier: user.tier,
          newTier: targetTier,
          planId: invoice.planId,
          invoiceId,
          subscriptionExpiresAt: new Date(expiresAt).toISOString(),
        });

        // Emit events for activity log + admin notification
        eventBus.usdcPaymentReceived(user.id, Number(invoice.amountUsdc) || 0, invoice.planId);
        eventBus.subscriptionCreated(user.id, targetTier, 'usdc', invoice.planId, {
          email: invoiceRecord.email,
          name: user.name,
          previousTier: user.tier,
        });
      } else {
        logger.warn('USDC payment confirmed but user not found', {
          email: invoiceRecord.email,
          invoiceId,
        });
      }
    }

    res.json({
      success: true,
      data: {
        status: 'confirmed',
        invoiceId,
        transactionId: confirmation.transactionId,
        consensusTimestamp: confirmation.consensusTimestamp,
        fromAccount: confirmation.fromAccount,
        amount: confirmation.amount,
        currency: 'USDC',
        planId: invoice.planId,
        hcsAnchored: !!hcsReceipt,
        hcsSequenceNumber: hcsReceipt?.sequenceNumber ?? null,
        tierUpgraded,
        newTier,
        message: tierUpgraded
          ? `Payment confirmed — account upgraded to ${newTier}`
          : 'Payment confirmed and subscription activated',
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('USDC verification failed', { invoiceId, error: err.message });
    res.status(500).json({
      success: false,
      error: 'Payment verification failed',
      timestamp: Date.now(),
    });
  }
});

// ─── GET /v1/payments/renewal-status ─────────────────────────────────────────
// Authenticated: Get subscription renewal info for current user

router.get('/renewal-status', (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Authentication required', timestamp: Date.now() });
  }

  const user = getUserById(userId);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found', timestamp: Date.now() });
  }

  const now = Date.now();
  const expiresAt = user.subscriptionExpiresAt;
  const daysRemaining = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000))) : null;
  const isExpired = expiresAt ? expiresAt < now : false;
  const isExpiringSoon = daysRemaining !== null && daysRemaining <= 30 && !isExpired;

  // Get USDC renewal pricing
  const planId = user.subscriptionPlanId;
  const renewalPricing = planId ? USDC_PRICES[planId] : null;
  const stripePlan = planId ? ALL_PLANS[planId] : null;

  res.json({
    success: true,
    data: {
      tier: user.tier,
      planId: user.subscriptionPlanId,
      method: user.subscriptionMethod,
      expiresAt: user.subscriptionExpiresAt,
      daysRemaining,
      isExpired,
      isExpiringSoon,
      renewalPricing: renewalPricing ? {
        usdcAmount: renewalPricing.amountUsd,
        stripeAmount: stripePlan ? stripePlan.amount / 100 : null,
        usdcDiscount: renewalPricing.discountPercent,
      } : null,
    },
    timestamp: Date.now(),
  });
});

// ─── POST /v1/payments/portal ────────────────────────────────────────────────
// Stripe billing portal for managing card subscriptions

const portalSchema = z.object({
  customerId: z.string(),
  returnUrl: z.string().url().optional(),
});

router.post('/portal', async (req: Request, res: Response) => {
  try {
    const body = portalSchema.parse(req.body);
    const session = await createBillingPortalSession(
      body.customerId,
      body.returnUrl ?? `${process.env.FRONTEND_URL ?? 'https://borealismark.com'}/dashboard`,
    );

    res.json({
      success: true,
      data: { url: session.url },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: err.errors,
        timestamp: Date.now(),
      });
    }
    logger.error('Portal session creation failed', { error: err.message });
    res.status(500).json({
      success: false,
      error: 'Failed to create portal session',
      timestamp: Date.now(),
    });
  }
});

// ─── GET /v1/payments/subscriptions/:customerId ──────────────────────────────
// List Stripe subscriptions for a customer

router.get('/subscriptions/:customerId', async (req: Request, res: Response) => {
  try {
    const subs = await getCustomerSubscriptions(req.params.customerId);
    res.json({
      success: true,
      data: subs.map(sub => ({
        id: sub.id,
        status: sub.status,
        method: 'stripe',
        plan: sub.items.data[0]?.price?.id
          ? getPlanByPriceId(sub.items.data[0].price.id)?.name ?? 'Unknown'
          : 'Unknown',
        priceId: sub.items.data[0]?.price?.id,
        currentPeriodStart: sub.current_period_start,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      })),
      timestamp: Date.now(),
    });
  } catch (err: any) {
    logger.error('Subscription fetch failed', { error: err.message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch subscriptions',
      timestamp: Date.now(),
    });
  }
});

// ─── Coupon Endpoints ───────────────────────────────────────────────────────

// POST /v1/payments/coupons — Create coupon (admin only)
router.post('/coupons', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required', timestamp: Date.now() });
  }

  try {
    const schema = z.object({
      code: z.string().min(3).max(30),
      discountPercent: z.number().min(1).max(100),
      validUntil: z.number().optional(),
      maxUses: z.number().optional(),
      planRestriction: z.string().optional(),
      renewalOnly: z.boolean().optional(),
    });
    const body = schema.parse(req.body);
    const id = uuidv4();

    createCoupon({
      id,
      code: body.code,
      discountPercent: body.discountPercent,
      validFrom: Date.now(),
      validUntil: body.validUntil,
      maxUses: body.maxUses,
      planRestriction: body.planRestriction,
      renewalOnly: body.renewalOnly,
      createdBy: user.id,
    });

    logger.info('Coupon created', { id, code: body.code, discount: body.discountPercent, createdBy: user.id });

    res.json({
      success: true,
      data: { id, code: body.code.toUpperCase(), discountPercent: body.discountPercent },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Validation error', details: err.errors, timestamp: Date.now() });
    }
    logger.error('Coupon creation failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create coupon', timestamp: Date.now() });
  }
});

// GET /v1/payments/coupons — List all coupons (admin only)
router.get('/coupons', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required', timestamp: Date.now() });
  }

  res.json({
    success: true,
    data: listCoupons(),
    timestamp: Date.now(),
  });
});

// DELETE /v1/payments/coupons/:id — Deactivate coupon (admin only)
router.delete('/coupons/:id', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required', timestamp: Date.now() });
  }

  deactivateCoupon(req.params.id);
  logger.info('Coupon deactivated', { id: req.params.id, deactivatedBy: user.id });

  res.json({
    success: true,
    message: 'Coupon deactivated',
    timestamp: Date.now(),
  });
});

// POST /v1/payments/coupons/validate — Validate a coupon code (any auth user)
router.post('/coupons/validate', (req: Request, res: Response) => {
  try {
    const schema = z.object({
      code: z.string(),
      planId: z.string(),
      isRenewal: z.boolean().optional().default(false),
    });
    const body = schema.parse(req.body);
    const result = validateCoupon(body.code, body.planId, body.isRenewal);

    if (!result.valid) {
      return res.json({
        success: true,
        data: { valid: false, reason: result.reason },
        timestamp: Date.now(),
      });
    }

    // Calculate discounted price
    const pricing = getUsdcPriceWithDiscount(body.planId, result.coupon!.discountPercent);
    const stripePlan = ALL_PLANS[body.planId];

    res.json({
      success: true,
      data: {
        valid: true,
        discountPercent: result.coupon!.discountPercent,
        usdcPriceAfterDiscount: pricing?.amountUsd ?? null,
        usdcPriceBefore: USDC_PRICES[body.planId]?.amountUsd ?? null,
        stripePrice: stripePlan ? stripePlan.amount / 100 : null,
      },
      timestamp: Date.now(),
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Validation error', details: err.errors, timestamp: Date.now() });
    }
    res.status(500).json({ success: false, error: 'Validation failed', timestamp: Date.now() });
  }
});

// ─── POST /v1/payments/webhook ───────────────────────────────────────────────
// Stripe webhook handler

router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;

  if (!sig) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  try {
    const event = constructWebhookEvent(req.body, sig);

    logger.info('Stripe webhook received', { type: event.type, id: event.id });

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any;
        const customerEmail = session.customer_email as string | undefined;
        const customerId = session.customer as string | undefined;
        const priceId = session.line_items?.data?.[0]?.price?.id;

        logger.info('Checkout completed', {
          sessionId: session.id,
          customerId,
          email: customerEmail,
          agentId: session.metadata?.agentId,
        });

        // Link Stripe customer to user and upgrade tier
        if (customerEmail && customerId) {
          const user = getUserByEmail(customerEmail);
          if (user) {
            updateUserStripe(user.id, customerId, session.subscription as string);
            // Determine tier from plan
            const plan = priceId ? getPlanByPriceId(priceId) : undefined;
            const targetTier = plan ? (planToTier[plan.tier] ?? 'pro') : 'pro';
            updateUserTier(user.id, targetTier);

            // Set subscription expiry from Stripe's period end
            const sub = session.subscription;
            // Default to 1 year from now for annual plans
            const expiresAt = calculateExpiryFromNow(plan?.tier ?? 'pro');
            setSubscriptionExpiry(user.id, expiresAt, 'stripe', plan?.tier ?? 'pro');

            logger.info('Stripe checkout → tier upgraded', {
              userId: user.id, newTier: targetTier, customerId,
              subscriptionExpiresAt: new Date(expiresAt).toISOString(),
            });

            // Emit subscription event for admin notification + activity log
            eventBus.subscriptionCreated(user.id, targetTier, 'stripe', plan?.tier, {
              email: customerEmail,
              name: user.name,
              previousTier: user.tier,
            });
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as any;
        logger.info('Subscription updated', {
          subscriptionId: sub.id,
          status: sub.status,
          customerId: sub.customer,
        });
        // If subscription is active, ensure tier is current
        if (sub.status === 'active' && sub.customer) {
          const user = getUserByStripeCustomerId(sub.customer);
          if (user) {
            const priceId = sub.items?.data?.[0]?.price?.id;
            const plan = priceId ? getPlanByPriceId(priceId) : undefined;
            if (plan) {
              updateUserTier(user.id, planToTier[plan.tier] ?? 'pro');
              // Update expiry from Stripe's current_period_end
              if (sub.current_period_end) {
                const expiresAt = sub.current_period_end * 1000; // Stripe uses seconds
                setSubscriptionExpiry(user.id, expiresAt, 'stripe', plan.tier);
              }
            }
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as any;
        logger.info('Subscription cancelled', {
          subscriptionId: sub.id,
          customerId: sub.customer,
        });
        // Downgrade to standard tier
        if (sub.customer) {
          const user = getUserByStripeCustomerId(sub.customer);
          if (user) {
            updateUserTier(user.id, 'standard');
            setSubscriptionExpiry(user.id, Date.now(), 'stripe', 'standard');
            logger.info('Stripe subscription cancelled → downgraded to standard', {
              userId: user.id, customerId: sub.customer,
            });
            eventBus.subscriptionExpired(user.id, user.tier);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object as any;
        logger.warn('Payment failed', {
          invoiceId: inv.id,
          customerId: inv.customer,
        });
        // Grace period: don't downgrade immediately, just log
        // After 3 failed attempts, Stripe will cancel the subscription
        // which triggers customer.subscription.deleted above
        break;
      }

      default:
        logger.info('Unhandled webhook event', { type: event.type });
    }

    res.json({ received: true });
  } catch (err: any) {
    logger.error('Webhook processing failed', { error: err.message });
    res.status(400).json({ error: 'Webhook verification failed' });
  }
});

export default router;
