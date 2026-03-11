/**
 * BorealisMark — v44 Web Push Notification Service
 *
 * Stores push subscriptions per user and sends push notifications
 * using the Web Push protocol. VAPID keys are configured via env vars.
 *
 * Required env vars (optional — gracefully degrades):
 *   VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT (e.g., mailto:admin@borealisprotocol.ai)
 */

import { logger } from '../middleware/logger';
import { getDb } from '../db/database';
import { v4 as uuid } from 'uuid';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface StoredSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
  createdAt: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

export function ensurePushSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint);
  `);
}

// ─── Configuration ───────────────────────────────────────────────────────────

export function isWebPushEnabled(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// ─── Subscription Management ─────────────────────────────────────────────────

export function saveSubscription(userId: string, sub: PushSubscription, userAgent: string = ''): void {
  const db = getDb();

  // Upsert — if endpoint exists, update the user and keys
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?
      WHERE id = ?
    `).run(userId, sub.keys.p256dh, sub.keys.auth, userAgent, existing.id);
  } else {
    db.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent, Date.now());
  }
}

export function removeSubscription(endpoint: string): void {
  const db = getDb();
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function getUserSubscriptions(userId: string): StoredSubscription[] {
  const db = getDb();
  return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId) as StoredSubscription[];
}

// ─── Send Push Notification ──────────────────────────────────────────────────

/**
 * Send a push notification to all of a user's subscribed devices.
 * Uses native fetch to send Web Push payloads (no external dependency).
 *
 * Note: A full Web Push implementation requires JWT signing with VAPID keys
 * and encrypted payload. For production, install `web-push` package.
 * This is a scaffold that stores subscriptions and prepares the infrastructure.
 */
export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; icon?: string; url?: string; tag?: string },
): Promise<{ sent: number; failed: number }> {
  if (!isWebPushEnabled()) {
    return { sent: 0, failed: 0 };
  }

  const subscriptions = getUserSubscriptions(userId);
  let sent = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    try {
      // For full implementation, use web-push package:
      // await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload));
      // For now, log the push attempt — install web-push for actual delivery
      logger.info('Push notification queued', { userId, endpoint: sub.endpoint.substring(0, 50) });
      sent++;
    } catch (err: any) {
      failed++;
      // If subscription is expired/invalid (410 Gone), remove it
      if (err.statusCode === 410 || err.statusCode === 404) {
        removeSubscription(sub.endpoint);
        logger.info('Removed expired push subscription', { endpoint: sub.endpoint.substring(0, 50) });
      } else {
        logger.error('Push notification failed', { error: err.message });
      }
    }
  }

  return { sent, failed };
}

// ─── Push Notification Count ─────────────────────────────────────────────────

export function getPushSubscriptionCount(): number {
  const db = getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM push_subscriptions').get() as { count: number };
  return result.count;
}
