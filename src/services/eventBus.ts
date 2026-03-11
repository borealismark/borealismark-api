/**
 * BorealisMark — EventBus Service
 *
 * Centralized event collection system. All platform actions emit events
 * through this bus, which persists them to SQLite, computes aggregates,
 * and queues them for Hedera anchoring.
 *
 * Event Categories:
 *   auth       — registration, login, password reset
 *   bot        — registration, job assignment, rating, status change
 *   marketplace — listing, order, escrow, settlement
 *   payment    — checkout, subscription, USDC transfer
 *   support    — chat, email, escalation
 *   audit      — agent audit, certificate issuance
 *   admin      — user management, moderation actions
 *   system     — health, errors, scheduled tasks
 */

import { v4 as uuid } from 'uuid';
import { logger } from '../middleware/logger';
import { getDb, insertPlatformEvent, upsertAggregate } from '../db/database';

// ─── Event Schema Types ─────────────────────────────────────────────────────

export interface PlatformEvent {
  eventType: string;
  category: EventCategory;
  actorId?: string;
  actorType?: 'user' | 'bot' | 'agent' | 'system' | 'admin';
  targetId?: string;
  targetType?: string;
  payload?: Record<string, any>;
  metadata?: Record<string, any>;
}

export type EventCategory =
  | 'auth'
  | 'bot'
  | 'marketplace'
  | 'payment'
  | 'support'
  | 'audit'
  | 'admin'
  | 'system';

// ─── Event Type Constants ───────────────────────────────────────────────────

export const EventTypes = {
  // Auth
  USER_REGISTERED: 'user.registered',
  USER_LOGIN: 'user.login',
  USER_PASSWORD_RESET: 'user.password_reset',
  USER_VERIFIED: 'user.verified',

  // Bot
  BOT_REGISTERED: 'bot.registered',
  BOT_UPDATED: 'bot.updated',
  BOT_SUSPENDED: 'bot.suspended',
  BOT_REACTIVATED: 'bot.reactivated',
  BOT_JOB_ASSIGNED: 'bot.job.assigned',
  BOT_JOB_COMPLETED: 'bot.job.completed',
  BOT_JOB_FAILED: 'bot.job.failed',
  BOT_RATED: 'bot.rated',

  // Marketplace
  LISTING_CREATED: 'listing.created',
  LISTING_PUBLISHED: 'listing.published',
  LISTING_SOLD: 'listing.sold',
  ORDER_CREATED: 'order.created',
  ORDER_PAYMENT_RECEIVED: 'order.payment_received',
  ORDER_SHIPPED: 'order.shipped',
  ORDER_DELIVERED: 'order.delivered',
  ORDER_SETTLED: 'order.settled',
  ORDER_DISPUTED: 'order.disputed',

  // Payment
  CHECKOUT_STARTED: 'payment.checkout_started',
  SUBSCRIPTION_CREATED: 'payment.subscription_created',
  SUBSCRIPTION_RENEWED: 'payment.subscription_renewed',
  SUBSCRIPTION_EXPIRED: 'payment.subscription_expired',
  USDC_PAYMENT_RECEIVED: 'payment.usdc_received',

  // Support
  SUPPORT_THREAD_CREATED: 'support.thread_created',
  SUPPORT_MESSAGE_SENT: 'support.message_sent',
  SUPPORT_ESCALATED: 'support.escalated',
  SUPPORT_RESOLVED: 'support.resolved',

  // Audit
  AUDIT_STARTED: 'audit.started',
  AUDIT_COMPLETED: 'audit.completed',
  CERTIFICATE_ISSUED: 'certificate.issued',
  CERTIFICATE_ANCHORED: 'certificate.anchored',

  // Admin
  ADMIN_USER_UPDATED: 'admin.user_updated',
  ADMIN_MODERATION: 'admin.moderation',

  // System
  SYSTEM_STARTUP: 'system.startup',
  SYSTEM_ERROR: 'system.error',
  ANCHOR_BATCH_COMPLETED: 'system.anchor_batch',
} as const;

// ─── Event Listeners ────────────────────────────────────────────────────────

type EventListener = (event: PlatformEvent & { id: string; createdAt: number }) => void;

const listeners: Map<string, EventListener[]> = new Map();

export function onEvent(eventType: string, listener: EventListener): void {
  const existing = listeners.get(eventType) || [];
  existing.push(listener);
  listeners.set(eventType, existing);
}

export function onCategory(category: EventCategory, listener: EventListener): void {
  const existing = listeners.get(`category:${category}`) || [];
  existing.push(listener);
  listeners.set(`category:${category}`, existing);
}

// ─── Emit ───────────────────────────────────────────────────────────────────

export function emit(event: PlatformEvent): string {
  const id = uuid();
  const createdAt = Date.now();

  try {
    // Persist to database
    insertPlatformEvent({
      id,
      eventType: event.eventType,
      category: event.category,
      actorId: event.actorId,
      actorType: event.actorType,
      targetId: event.targetId,
      targetType: event.targetType,
      payload: event.payload,
      metadata: event.metadata,
    });

    // Update real-time aggregates
    updateAggregates(event);

    // Notify listeners
    const enrichedEvent = { ...event, id, createdAt };

    // Type-specific listeners
    const typeListeners = listeners.get(event.eventType) || [];
    for (const listener of typeListeners) {
      try { listener(enrichedEvent); } catch (err: any) {
        logger.error('Event listener error', { eventType: event.eventType, error: err.message });
      }
    }

    // Category-wide listeners
    const catListeners = listeners.get(`category:${event.category}`) || [];
    for (const listener of catListeners) {
      try { listener(enrichedEvent); } catch (err: any) {
        logger.error('Category listener error', { category: event.category, error: err.message });
      }
    }

    // Wildcard listeners
    const wildcardListeners = listeners.get('*') || [];
    for (const listener of wildcardListeners) {
      try { listener(enrichedEvent); } catch (err: any) {
        logger.error('Wildcard listener error', { error: err.message });
      }
    }
  } catch (err: any) {
    // Event persistence failure should never crash the app
    logger.error('Failed to persist event', {
      eventType: event.eventType,
      error: err.message,
    });
  }

  return id;
}

// ─── Aggregate Updates ──────────────────────────────────────────────────────

function updateAggregates(event: PlatformEvent): void {
  try {
    const now = Date.now();
    const hourStart = Math.floor(now / (60 * 60 * 1000)) * (60 * 60 * 1000);
    const dayStart = Math.floor(now / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);

    // Increment hourly event count by category
    upsertAggregateIncrement(`events.${event.category}`, 'hourly', hourStart);
    // Increment daily event count by category
    upsertAggregateIncrement(`events.${event.category}`, 'daily', dayStart);
    // Increment total daily event count
    upsertAggregateIncrement('events.total', 'daily', dayStart);

    // Category-specific aggregates
    if (event.category === 'auth' && event.eventType === EventTypes.USER_REGISTERED) {
      upsertAggregateIncrement('users.registrations', 'daily', dayStart);
    }
    if (event.category === 'payment') {
      upsertAggregateIncrement('payments.total', 'daily', dayStart);
    }
    if (event.category === 'bot' && event.eventType === EventTypes.BOT_JOB_COMPLETED) {
      upsertAggregateIncrement('bots.jobs_completed', 'daily', dayStart);
    }
  } catch (err: any) {
    // Non-critical — log and move on
    logger.warn('Aggregate update failed', { error: err.message });
  }
}

function upsertAggregateIncrement(metricKey: string, period: string, periodStart: number): void {
  // Get current value and increment
  const db = getDb();
  const existing = db.prepare(
    'SELECT value FROM data_aggregates WHERE metric_key = ? AND period = ? AND period_start = ?'
  ).get(metricKey, period, periodStart) as { value: number } | undefined;

  const newValue = (existing?.value ?? 0) + 1;
  upsertAggregate(metricKey, period, periodStart, newValue);
}

// ─── Convenience Emitters ───────────────────────────────────────────────────

export const events = {
  userRegistered: (userId: string, email: string, name?: string) => emit({
    eventType: EventTypes.USER_REGISTERED,
    category: 'auth',
    actorId: userId,
    actorType: 'user',
    payload: { email, name: name ?? email.split('@')[0] },
  }),

  userLogin: (userId: string) => emit({
    eventType: EventTypes.USER_LOGIN,
    category: 'auth',
    actorId: userId,
    actorType: 'user',
  }),

  botRegistered: (botId: string, ownerId: string, botName: string) => emit({
    eventType: EventTypes.BOT_REGISTERED,
    category: 'bot',
    actorId: ownerId,
    actorType: 'user',
    targetId: botId,
    targetType: 'bot',
    payload: { botName },
  }),

  botJobCompleted: (botId: string, jobId: string, apEarned: number) => emit({
    eventType: EventTypes.BOT_JOB_COMPLETED,
    category: 'bot',
    actorId: botId,
    actorType: 'bot',
    targetId: jobId,
    targetType: 'job',
    payload: { apEarned },
  }),

  botRated: (botId: string, raterId: string, rating: number) => emit({
    eventType: EventTypes.BOT_RATED,
    category: 'bot',
    actorId: raterId,
    actorType: 'user',
    targetId: botId,
    targetType: 'bot',
    payload: { rating },
  }),

  listingCreated: (listingId: string, userId: string, title: string) => emit({
    eventType: EventTypes.LISTING_CREATED,
    category: 'marketplace',
    actorId: userId,
    actorType: 'user',
    targetId: listingId,
    targetType: 'listing',
    payload: { title },
  }),

  orderCreated: (orderId: string, buyerId: string, sellerId: string, totalUsdc: number) => emit({
    eventType: EventTypes.ORDER_CREATED,
    category: 'marketplace',
    actorId: buyerId,
    actorType: 'user',
    targetId: orderId,
    targetType: 'order',
    payload: { sellerId, totalUsdc },
  }),

  orderSettled: (orderId: string, totalUsdc: number) => emit({
    eventType: EventTypes.ORDER_SETTLED,
    category: 'marketplace',
    targetId: orderId,
    targetType: 'order',
    actorType: 'system',
    payload: { totalUsdc },
  }),

  paymentReceived: (userId: string, planId: string, method: string, amount: number) => emit({
    eventType: EventTypes.SUBSCRIPTION_CREATED,
    category: 'payment',
    actorId: userId,
    actorType: 'user',
    payload: { planId, method, amount },
  }),

  supportThreadCreated: (threadId: string, channel: string, email?: string) => emit({
    eventType: EventTypes.SUPPORT_THREAD_CREATED,
    category: 'support',
    targetId: threadId,
    targetType: 'support_thread',
    actorType: 'system',
    payload: { channel, email },
  }),

  supportEscalated: (threadId: string, reason: string) => emit({
    eventType: EventTypes.SUPPORT_ESCALATED,
    category: 'support',
    targetId: threadId,
    targetType: 'support_thread',
    actorType: 'system',
    payload: { reason },
  }),

  auditCompleted: (agentId: string, score: number, creditRating: string) => emit({
    eventType: EventTypes.AUDIT_COMPLETED,
    category: 'audit',
    targetId: agentId,
    targetType: 'agent',
    actorType: 'system',
    payload: { score, creditRating },
  }),

  certificateAnchored: (certId: string, hcsTxId: string) => emit({
    eventType: EventTypes.CERTIFICATE_ANCHORED,
    category: 'audit',
    targetId: certId,
    targetType: 'certificate',
    actorType: 'system',
    payload: { hcsTxId },
  }),

  // Payment
  checkoutStarted: (userId: string, planId: string, method: string) => emit({
    eventType: EventTypes.CHECKOUT_STARTED,
    category: 'payment',
    actorId: userId,
    actorType: 'user',
    payload: { planId, method },
  }),

  subscriptionCreated: (userId: string, tier: string, method: string, planId?: string, extra?: { email?: string; name?: string; previousTier?: string }) => emit({
    eventType: EventTypes.SUBSCRIPTION_CREATED,
    category: 'payment',
    actorId: userId,
    actorType: 'user',
    payload: { tier, method, planId, ...extra },
  }),

  subscriptionRenewed: (userId: string, tier: string, method: string) => emit({
    eventType: EventTypes.SUBSCRIPTION_RENEWED,
    category: 'payment',
    actorId: userId,
    actorType: 'user',
    payload: { tier, method },
  }),

  subscriptionExpired: (userId: string, previousTier: string) => emit({
    eventType: EventTypes.SUBSCRIPTION_EXPIRED,
    category: 'payment',
    actorId: userId,
    actorType: 'user',
    payload: { previousTier },
  }),

  usdcPaymentReceived: (userId: string, amount: number, planId: string) => emit({
    eventType: EventTypes.USDC_PAYMENT_RECEIVED,
    category: 'payment',
    actorId: userId,
    actorType: 'user',
    payload: { amount, planId },
  }),

  systemError: (component: string, error: string) => emit({
    eventType: EventTypes.SYSTEM_ERROR,
    category: 'system',
    actorType: 'system',
    payload: { component, error },
  }),
};

// ─── Admin Notification Listeners ─────────────────────────────────────────

/**
 * Initialize event listeners that send admin email notifications.
 * Called once at server startup.
 */
export function initAdminNotifications(): void {
  // Notify admin on new user registration
  onEvent(EventTypes.USER_REGISTERED, async (event) => {
    try {
      const { sendAdminNewUserNotification } = await import('./email');
      const email = event.payload?.email ?? 'unknown';
      const name = event.payload?.name ?? email.split('@')[0];
      await sendAdminNewUserNotification(email, name, event.actorId ?? 'unknown', 'standard');
    } catch (err: any) {
      logger.error('Admin registration notification failed', { error: err.message });
    }
  });

  // Notify admin on subscription upgrade
  onEvent(EventTypes.SUBSCRIPTION_CREATED, async (event) => {
    try {
      const { sendAdminSubscriptionNotification } = await import('./email');
      const { tier, method, planId, email, name, previousTier } = event.payload ?? {};
      await sendAdminSubscriptionNotification(
        email ?? 'unknown',
        name ?? 'User',
        event.actorId ?? 'unknown',
        tier ?? 'pro',
        previousTier ?? 'standard',
        method ?? 'unknown',
        planId,
      );
    } catch (err: any) {
      logger.error('Admin subscription notification failed', { error: err.message });
    }
  });

  logger.info('Admin notification listeners initialized');
}

// ─── v40 Signal Tower: In-App Notification Listeners ─────────────────────

/**
 * Initialize in-app notification generation from platform events.
 * Creates user_notifications rows and pushes them via SSE.
 * Called once at server startup.
 */
export function initNotificationListeners(): void {
  // Order events → notify buyer and seller
  onEvent(EventTypes.ORDER_PAYMENT_RECEIVED, async (event) => {
    try {
      const { createNotification, getNotificationPreferences, getUserById } = await import('../db/database');
      const { pushToUser } = await import('../routes/notifications');
      const sellerId = event.payload?.sellerId;
      if (sellerId) {
        const prefs = getNotificationPreferences(sellerId);
        if (prefs.inappOrders) {
          const notif = createNotification({
            userId: sellerId,
            type: 'order',
            title: 'Payment Received',
            body: `A buyer has deposited payment for your listing. Deposit your trust bond to proceed.`,
            icon: 'dollar',
            link: `/dashboard/orders`,
          });
          pushToUser(sellerId, { event: 'notification', ...notif });
        }
        // Send email if preference enabled
        if (prefs.emailOrders) {
          try {
            const { sendOrderNotificationEmail } = await import('./email');
            const user = getUserById(sellerId);
            if (user) {
              await sendOrderNotificationEmail(user.email, user.name ?? user.email, 'payment_received', 'A buyer has deposited payment for your listing.');
            }
          } catch (emailErr: any) {
            logger.error('Order email notification failed', { error: emailErr.message });
          }
        }
      }
    } catch (err: any) {
      logger.error('Order notification error', { error: err.message });
    }
  });

  onEvent(EventTypes.ORDER_SHIPPED, async (event) => {
    try {
      const { createNotification, getNotificationPreferences, getUserById } = await import('../db/database');
      const { pushToUser } = await import('../routes/notifications');
      const buyerId = event.payload?.buyerId;
      if (buyerId) {
        const prefs = getNotificationPreferences(buyerId);
        if (prefs.inappOrders) {
          const notif = createNotification({
            userId: buyerId,
            type: 'order',
            title: 'Order Shipped',
            body: `Your order has been shipped! Track your package and confirm delivery when it arrives.`,
            icon: 'truck',
            link: `/dashboard/orders`,
          });
          pushToUser(buyerId, { event: 'notification', ...notif });
        }
        // Send email if preference enabled
        if (prefs.emailOrders) {
          try {
            const { sendOrderNotificationEmail } = await import('./email');
            const user = getUserById(buyerId);
            if (user) {
              await sendOrderNotificationEmail(user.email, user.name ?? user.email, 'order_shipped', 'Your order has been shipped! Track your package and confirm delivery when it arrives.');
            }
          } catch (emailErr: any) {
            logger.error('Order email notification failed', { error: emailErr.message });
          }
        }
      }
    } catch (err: any) {
      logger.error('Shipped notification error', { error: err.message });
    }
  });

  onEvent(EventTypes.ORDER_SETTLED, async (event) => {
    try {
      const { createNotification, getNotificationPreferences, getUserById } = await import('../db/database');
      const { pushToUser } = await import('../routes/notifications');
      const { buyerId, sellerId, totalUsdc } = event.payload ?? {};
      const amount = totalUsdc ? ` (${Number(totalUsdc).toFixed(2)} USDC)` : '';

      for (const uid of [buyerId, sellerId].filter(Boolean)) {
        const prefs = getNotificationPreferences(uid);
        if (prefs.inappOrders) {
          const isSeller = uid === sellerId;
          const notif = createNotification({
            userId: uid,
            type: 'order',
            title: 'Order Settled',
            body: isSeller
              ? `Your sale has been settled${amount}. Funds are being released to your account.`
              : `Your purchase has been settled${amount}. Transaction complete!`,
            icon: 'check-circle',
            link: `/dashboard/orders`,
          });
          pushToUser(uid, { event: 'notification', ...notif });
        }
        // Send email if preference enabled
        if (prefs.emailOrders) {
          try {
            const { sendOrderNotificationEmail } = await import('./email');
            const user = getUserById(uid);
            if (user) {
              const isSeller = uid === sellerId;
              const message = isSeller
                ? `Your sale has been settled${amount}. Funds are being released to your account.`
                : `Your purchase has been settled${amount}. Transaction complete!`;
              await sendOrderNotificationEmail(user.email, user.name ?? user.email, 'order_settled', message);
            }
          } catch (emailErr: any) {
            logger.error('Order email notification failed', { error: emailErr.message });
          }
        }
      }
    } catch (err: any) {
      logger.error('Settlement notification error', { error: err.message });
    }
  });

  // Verification events → notify user
  onEvent(EventTypes.USER_VERIFIED, async (event) => {
    try {
      const { createNotification, getNotificationPreferences, getUserById } = await import('../db/database');
      const { pushToUser } = await import('../routes/notifications');
      const userId = event.actorId;
      if (userId) {
        const prefs = getNotificationPreferences(userId);
        if (prefs.inappVerification) {
          const notif = createNotification({
            userId,
            type: 'verification',
            title: 'Email Verified',
            body: 'Your email has been verified. You earned trust points!',
            icon: 'shield',
            link: `/dashboard/trust`,
          });
          pushToUser(userId, { event: 'notification', ...notif });
        }
        // Send email if preference enabled
        if (prefs.emailVerification) {
          try {
            const { sendVerificationNotificationEmail } = await import('./email');
            const user = getUserById(userId);
            if (user) {
              await sendVerificationNotificationEmail(user.email, user.name ?? user.email, 'Your email has been verified. You earned trust points!');
            }
          } catch (emailErr: any) {
            logger.error('Verification email notification failed', { error: emailErr.message });
          }
        }
      }
    } catch (err: any) {
      logger.error('Verification notification error', { error: err.message });
    }
  });

  // Payment events → notify user
  onEvent(EventTypes.SUBSCRIPTION_CREATED, async (event) => {
    try {
      const { createNotification, getNotificationPreferences, getUserById } = await import('../db/database');
      const { pushToUser } = await import('../routes/notifications');
      const userId = event.actorId;
      if (userId) {
        const prefs = getNotificationPreferences(userId);
        const tier = event.payload?.tier ?? 'Pro';
        if (prefs.inappPayment) {
          const notif = createNotification({
            userId,
            type: 'payment',
            title: 'Subscription Activated',
            body: `Your ${tier.charAt(0).toUpperCase() + tier.slice(1)} plan is now active. Enjoy your upgraded features!`,
            icon: 'star',
            link: `/dashboard/settings`,
          });
          pushToUser(userId, { event: 'notification', ...notif });
        }
        // Send email if preference enabled
        if (prefs.emailPayment) {
          try {
            const { sendPaymentNotificationEmail } = await import('./email');
            const user = getUserById(userId);
            if (user) {
              await sendPaymentNotificationEmail(user.email, user.name ?? user.email, 'subscription_created', `Your ${tier} subscription is now active. Enjoy your upgraded features!`);
            }
          } catch (emailErr: any) {
            logger.error('Subscription email notification failed', { error: emailErr.message });
          }
        }
      }
    } catch (err: any) {
      logger.error('Subscription notification error', { error: err.message });
    }
  });

  onEvent(EventTypes.SUBSCRIPTION_EXPIRED, async (event) => {
    try {
      const { createNotification, getNotificationPreferences, getUserById } = await import('../db/database');
      const { pushToUser } = await import('../routes/notifications');
      const userId = event.actorId;
      if (userId) {
        const prefs = getNotificationPreferences(userId);
        if (prefs.inappPayment) {
          const notif = createNotification({
            userId,
            type: 'payment',
            title: 'Subscription Expired',
            body: 'Your subscription has expired. Renew to keep your premium features.',
            icon: 'alert-triangle',
            link: `/dashboard/settings`,
          });
          pushToUser(userId, { event: 'notification', ...notif });
        }
        // Send email if preference enabled
        if (prefs.emailPayment) {
          try {
            const { sendPaymentNotificationEmail } = await import('./email');
            const user = getUserById(userId);
            if (user) {
              await sendPaymentNotificationEmail(user.email, user.name ?? user.email, 'subscription_expired', 'Your subscription has expired. Renew to keep your premium features.');
            }
          } catch (emailErr: any) {
            logger.error('Subscription email notification failed', { error: emailErr.message });
          }
        }
      }
    } catch (err: any) {
      logger.error('Expiry notification error', { error: err.message });
    }
  });

  // Bot events → notify owner
  onEvent(EventTypes.BOT_RATED, async (event) => {
    try {
      const { createNotification, getNotificationPreferences, getDb } = await import('../db/database');
      const { pushToUser } = await import('../routes/notifications');
      const botId = event.targetId;
      if (!botId) return;
      const bot = getDb().prepare('SELECT owner_id, name FROM bots WHERE id = ?').get(botId) as any;
      if (!bot) return;
      const prefs = getNotificationPreferences(bot.owner_id);
      if (prefs.inappSystem) {
        const rating = event.payload?.rating ?? 0;
        const notif = createNotification({
          userId: bot.owner_id,
          type: 'system',
          title: 'Bot Rated',
          body: `${bot.name} received a ${rating}/5 rating.`,
          icon: 'star',
          link: `/dashboard/bots`,
        });
        pushToUser(bot.owner_id, { event: 'notification', ...notif });
      }
    } catch (err: any) {
      logger.error('Bot rating notification error', { error: err.message });
    }
  });

  // Support events → notify user
  onEvent(EventTypes.SUPPORT_RESOLVED, async (event) => {
    try {
      const { createNotification, getNotificationPreferences, getDb } = await import('../db/database');
      const { pushToUser } = await import('../routes/notifications');
      const threadId = event.targetId;
      if (!threadId) return;
      const thread = getDb().prepare('SELECT user_id FROM support_threads WHERE id = ?').get(threadId) as any;
      if (!thread?.user_id) return;
      const prefs = getNotificationPreferences(thread.user_id);
      if (prefs.inappSupport) {
        const notif = createNotification({
          userId: thread.user_id,
          type: 'support',
          title: 'Support Ticket Resolved',
          body: 'Your support request has been resolved. Let us know if you need anything else.',
          icon: 'message-circle',
          link: `/dashboard/support`,
        });
        pushToUser(thread.user_id, { event: 'notification', ...notif });
      }
    } catch (err: any) {
      logger.error('Support notification error', { error: err.message });
    }
  });

  logger.info('In-app notification listeners initialized (Signal Tower v40)');
}
