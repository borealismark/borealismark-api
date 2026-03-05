/**
 * BorealisMark Unified Payment Routes
 * Dual payment system: Stripe (card) + Hedera USDC (crypto)
 * Consumers choose their preferred payment method at checkout.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  createCheckoutSession,
  getCustomerSubscriptions,
  createBillingPortalSession,
  constructWebhookEvent,
} from '../stripe/client';
import { ALL_PLANS, AGENT_PLANS, API_TIERS, getPlanByPriceId } from '../stripe/config';
import {
  createUsdcInvoice,
  getInvoice,
  updateInvoiceStatus,
  verifyUsdcPayment,
  anchorPaymentReceiptOnHCS,
  USDC_TOKEN_ID,
  TREASURY_ACCOUNT_ID,
} from '../hedera/usdc';
import { logger } from '../middleware/logger';

const router = Router();

// ─── GET /v1/payments/plans ──────────────────────────────────────────────────
// Public: List all available plans with pricing + accepted payment methods

router.get('/plans', (_req: Request, res: Response) => {
  const formatPlan = ([key, plan]: [string, any]) => ({
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
      },
      usdc: {
        tokenId: USDC_TOKEN_ID,
        treasuryAccount: TREASURY_ACCOUNT_ID,
        network: process.env.HEDERA_NETWORK ?? 'testnet',
        type: 'crypto',
        processingFee: '~$0.001',
      },
    },
  });

  res.json({
    success: true,
    data: {
      agentPlans: Object.entries(AGENT_PLANS).map(formatPlan),
      apiTiers: Object.entries(API_TIERS).map(formatPlan),
      acceptedMethods: ['stripe', 'usdc'],
      note: 'Choose "stripe" for card payments or "usdc" for USDC stablecoin on Hedera',
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
  // Stripe-specific
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

router.post('/checkout', async (req: Request, res: Response) => {
  try {
    const body = checkoutSchema.parse(req.body);
    const plan = ALL_PLANS[body.planId];
    const amountUsd = plan.amount / 100;

    // ── Stripe Card Checkout ──
    if (body.method === 'stripe') {
      const session = await createCheckoutSession({
        priceId: plan.priceId,
        customerEmail: body.email,
        agentId: body.agentId,
        successUrl: body.successUrl ?? `${process.env.FRONTEND_URL ?? 'https://borealismark.com'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: body.cancelUrl ?? `${process.env.FRONTEND_URL ?? 'https://borealismark.com'}/payment/cancelled`,
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
      const invoice = createUsdcInvoice(body.planId, amountUsd, body.email, body.agentId);

      logger.info('USDC checkout created', {
        invoiceId: invoice.invoiceId,
        planId: body.planId,
        email: body.email,
        method: 'usdc',
        amountUsdc: invoice.amountUsdc,
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
        message: 'Payment confirmed and subscription activated',
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
        logger.info('Checkout completed', {
          sessionId: session.id,
          customerId: session.customer,
          email: session.customer_email,
          agentId: session.metadata?.agentId,
        });
        // TODO: Activate subscription in DB, link agent to customer, upgrade CP multiplier
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as any;
        logger.info('Subscription updated', {
          subscriptionId: sub.id,
          status: sub.status,
          customerId: sub.customer,
        });
        // TODO: Update subscription status in DB
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as any;
        logger.info('Subscription cancelled', {
          subscriptionId: sub.id,
          customerId: sub.customer,
        });
        // TODO: Downgrade agent to free tier, reset CP multiplier
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        logger.warn('Payment failed', {
          invoiceId: invoice.id,
          customerId: invoice.customer,
        });
        // TODO: Notify agent owner, grace period logic
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
