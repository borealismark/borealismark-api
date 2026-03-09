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
  userRegistered: (userId: string, email: string) => emit({
    eventType: EventTypes.USER_REGISTERED,
    category: 'auth',
    actorId: userId,
    actorType: 'user',
    payload: { email },
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

  systemError: (component: string, error: string) => emit({
    eventType: EventTypes.SYSTEM_ERROR,
    category: 'system',
    actorType: 'system',
    payload: { component, error },
  }),
};
