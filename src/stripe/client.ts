/**
 * BorealisMark Stripe Client
 * Singleton Stripe SDK instance with helper methods
 */

import Stripe from 'stripe';

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY not set in environment');
    }
    stripeInstance = new Stripe(key, {
      apiVersion: '2024-12-18' as any,
      typescript: true,
      appInfo: {
        name: 'BorealisMark Protocol',
        version: '1.2.0',
        url: 'https://borealismark.com',
      },
    });
  }
  return stripeInstance;
}

// ─── Checkout Session Helpers ────────────────────────────────────────────────

export interface CreateCheckoutParams {
  priceId: string;
  customerId?: string;
  customerEmail?: string;
  agentId?: string;           // attach as metadata for post-payment linking
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(params: CreateCheckoutParams): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      source: 'borealismark',
    },
  };

  if (params.customerId) {
    sessionParams.customer = params.customerId;
  } else if (params.customerEmail) {
    sessionParams.customer_email = params.customerEmail;
  }

  return stripe.checkout.sessions.create(sessionParams);
}

// ─── Customer Helpers ────────────────────────────────────────────────────────

export async function createCustomer(email: string, name?: string): Promise<Stripe.Customer> {
  const stripe = getStripe();
  return stripe.customers.create({
    email,
    name,
    metadata: { source: 'borealismark' },
  });
}

export async function getCustomerSubscriptions(customerId: string): Promise<Stripe.Subscription[]> {
  const stripe = getStripe();
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all' });
  return subs.data;
}

// ─── Subscription Portal ─────────────────────────────────────────────────────

export async function createBillingPortalSession(customerId: string, returnUrl: string): Promise<Stripe.BillingPortal.Session> {
  const stripe = getStripe();
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

// ─── Webhook Verification ────────────────────────────────────────────────────

export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string,
): Stripe.Event {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET not set');
  }
  return stripe.webhooks.constructEvent(payload, signature, secret);
}
