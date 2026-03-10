/**
 * BorealisMark — v40 Signal Tower: Notification Center
 *
 * Real-time notification system with SSE streaming, in-app notification
 * management, and user preference controls.
 *
 *   GET  /v1/notifications          — List notifications (paginated)
 *   GET  /v1/notifications/count    — Unread count
 *   GET  /v1/notifications/stream   — SSE real-time stream
 *   PATCH /v1/notifications/:id/read — Mark single notification as read
 *   POST /v1/notifications/read-all — Mark all as read
 *   GET  /v1/notifications/preferences — Get notification preferences
 *   PATCH /v1/notifications/preferences — Update notification preferences
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from './auth';
import { logger } from '../middleware/logger';
import {
  getUserNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  createNotification,
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../db/database';

const router = Router();

// ─── SSE Client Registry ────────────────────────────────────────────────────

interface SSEClient {
  userId: string;
  res: Response;
  connectedAt: number;
}

const sseClients: Map<string, SSEClient[]> = new Map();

/**
 * Push a notification to all SSE-connected clients for a given user.
 * Called by the event bus when a new notification is created.
 */
export function pushToUser(userId: string, notification: any): void {
  const clients = sseClients.get(userId) || [];
  const data = JSON.stringify(notification);
  for (const client of clients) {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch {
      // Client disconnected — will be cleaned up on 'close' event
    }
  }
}

/**
 * Get the count of connected SSE clients (for admin monitoring).
 */
export function getSSEClientCount(): number {
  let count = 0;
  for (const clients of sseClients.values()) {
    count += clients.length;
  }
  return count;
}

// ─── GET /v1/notifications — List notifications ─────────────────────────────

router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const unreadOnly = req.query.unread === 'true';

    const notifications = getUserNotifications(userId, { limit, offset, unreadOnly });
    const unreadCount = getUnreadNotificationCount(userId);

    res.json({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: { limit, offset, hasMore: notifications.length === limit },
      },
    });
  } catch (err: any) {
    logger.error('Notification list error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list notifications' });
  }
});

// ─── GET /v1/notifications/count — Unread count ─────────────────────────────

router.get('/count', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const unreadCount = getUnreadNotificationCount(userId);
    res.json({ success: true, data: { unreadCount } });
  } catch (err: any) {
    logger.error('Notification count error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get count' });
  }
});

// ─── GET /v1/notifications/stream — SSE real-time stream ────────────────────

router.get('/stream', (req: Request, res: Response) => {
  try {
    // SSE requires query-param auth since EventSource doesn't support headers
    const token = (req.query.token as string) || req.headers.authorization?.slice(7);
    if (!token) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const JWT_SECRET = process.env.JWT_SECRET || '';
    let userId: string;
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      userId = decoded.sub;
    } catch {
      res.status(401).json({ success: false, error: 'Invalid token' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send initial connection event with unread count
    const unreadCount = getUnreadNotificationCount(userId);
    res.write(`event: connected\ndata: ${JSON.stringify({ unreadCount })}\n\n`);

    // Register client
    const client: SSEClient = { userId, res, connectedAt: Date.now() };
    const existing = sseClients.get(userId) || [];
    existing.push(client);
    sseClients.set(userId, existing);

    logger.info('SSE client connected', { userId, totalClients: getSSEClientCount() });

    // Keep-alive ping every 30 seconds
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(keepAlive);
      const clients = sseClients.get(userId) || [];
      const idx = clients.indexOf(client);
      if (idx !== -1) clients.splice(idx, 1);
      if (clients.length === 0) sseClients.delete(userId);
      else sseClients.set(userId, clients);

      logger.info('SSE client disconnected', { userId, totalClients: getSSEClientCount() });
    });
  } catch (err: any) {
    logger.error('SSE stream error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to establish stream' });
  }
});

// ─── PATCH /v1/notifications/:id/read — Mark single as read ────────────────

router.patch('/:id/read', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const success = markNotificationRead(req.params.id, userId);

    if (!success) {
      res.status(404).json({ success: false, error: 'Notification not found' });
      return;
    }

    res.json({ success: true, data: { id: req.params.id, read: true } });
  } catch (err: any) {
    logger.error('Mark read error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to mark as read' });
  }
});

// ─── POST /v1/notifications/read-all — Mark all as read ────────────────────

router.post('/read-all', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const count = markAllNotificationsRead(userId);

    // Push updated count to SSE clients
    pushToUser(userId, { type: 'count_update', unreadCount: 0 });

    res.json({ success: true, data: { markedRead: count } });
  } catch (err: any) {
    logger.error('Mark all read error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to mark all as read' });
  }
});

// ─── GET /v1/notifications/preferences — Get preferences ───────────────────

router.get('/preferences', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const prefs = getNotificationPreferences(userId);
    res.json({ success: true, data: prefs });
  } catch (err: any) {
    logger.error('Get preferences error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get preferences' });
  }
});

// ─── PATCH /v1/notifications/preferences — Update preferences ──────────────

router.patch('/preferences', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const allowed = [
      'emailOrders', 'emailVerification', 'emailPayment', 'emailSystem', 'emailMarketing',
      'inappOrders', 'inappVerification', 'inappPayment', 'inappSystem', 'inappTrust', 'inappSupport',
    ];
    const updates: Record<string, boolean> = {};
    for (const key of allowed) {
      if (typeof req.body[key] === 'boolean') {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: 'No valid preference fields provided' });
      return;
    }

    const prefs = updateNotificationPreferences(userId, updates);
    res.json({ success: true, data: prefs });
  } catch (err: any) {
    logger.error('Update preferences error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update preferences' });
  }
});

export default router;
