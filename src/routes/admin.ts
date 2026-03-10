/**
 * BorealisMark — Admin Console Routes
 *
 * Authenticated admin-only endpoints for platform oversight.
 *
 *   GET  /v1/admin/dashboard         — Platform overview stats
 *   GET  /v1/admin/users             — List/search users
 *   GET  /v1/admin/users/:id         — User detail
 *   PATCH /v1/admin/users/:id        — Update user (tier, role, active)
 *   GET  /v1/admin/support           — List support threads (inbox)
 *   GET  /v1/admin/support/:id       — Thread detail + messages
 *   PATCH /v1/admin/support/:id      — Update thread (status, assign)
 *   POST /v1/admin/support/:id/reply — Admin reply to thread
 *   GET  /v1/admin/support/stats     — Support statistics
 *   GET  /v1/admin/events            — Platform event log
 *   GET  /v1/admin/events/stats      — Event statistics
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import path from 'path';
import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { requireAuth } from './auth';
import { logger } from '../middleware/logger';
import {
  getDb,
  getUserById,
  getAllUsers,
  getAdminDashboardStats,
  updateUserTier,
  updateUserRole,
  getSupportThreads,
  getSupportMessages,
  updateSupportThreadStatus,
  assignSupportThread,
  escalateSupportThread,
  addSupportMessage,
  getSupportStats,
  getPlatformEvents,
  getEventStats,
} from '../db/database';
import { handleSupportChat } from '../services/aiSupport';
import { uploadDatabaseBackup, isR2Enabled, getR2Status } from '../services/r2Storage';

const router = Router();

// ─── Admin Gating Middleware ────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: Function): void {
  const userId = (req as any).user?.sub;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  const user = getUserById(userId);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }
  next();
}

// ─── GET /dashboard — Platform Overview ─────────────────────────────────────

router.get('/dashboard', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const stats = getAdminDashboardStats();
    const supportStats = getSupportStats();
    res.json({
      success: true,
      data: { ...stats, support: supportStats, generatedAt: new Date().toISOString() },
    });
  } catch (err: any) {
    logger.error('Admin dashboard error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load dashboard' });
  }
});

// ─── GET /users — List/Search Users ─────────────────────────────────────────

router.get('/users', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const tier = req.query.tier as string | undefined;
    const role = req.query.role as string | undefined;
    const search = req.query.search as string | undefined;

    const { users, total } = getAllUsers({ limit, offset, tier, role, search });
    res.json({ success: true, data: { users, total, limit, offset } });
  } catch (err: any) {
    logger.error('Admin list users error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

// ─── GET /users/:id — User Detail ──────────────────────────────────────────

router.get('/users/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const user = getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const db = getDb();
    // Get user's bots
    const bots = db.prepare('SELECT id, name, type, status, tier, ap_points, star_rating, jobs_completed FROM bots WHERE owner_id = ?').all(req.params.id);
    // Get user's orders
    const orders = db.prepare("SELECT id, status, total_usdc, created_at FROM marketplace_orders WHERE buyer_id = ? OR seller_id = ? ORDER BY created_at DESC LIMIT 20").all(req.params.id, req.params.id);
    // Get support threads for this user
    const threads = db.prepare("SELECT id, session_id, channel, status, escalated, message_count, created_at FROM support_threads WHERE customer_email = ? ORDER BY updated_at DESC LIMIT 10").all(user.email);

    res.json({
      success: true,
      data: { user, bots, orders, supportThreads: threads },
    });
  } catch (err: any) {
    logger.error('Admin user detail error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load user' });
  }
});

// ─── PATCH /users/:id — Update User ────────────────────────────────────────

const updateUserSchema = z.object({
  tier: z.enum(['standard', 'pro', 'elite']).optional(),
  role: z.enum(['user', 'admin']).optional(),
  active: z.boolean().optional(),
});

router.patch('/users/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
    }

    const user = getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const adminId = (req as any).user.sub;
    const { tier, role, active } = parsed.data;

    if (tier) updateUserTier(req.params.id, tier);
    if (role) updateUserRole(req.params.id, role);
    if (active !== undefined) {
      getDb().prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
    }

    logger.info('Admin updated user', { adminId, userId: req.params.id, changes: parsed.data });
    res.json({ success: true, message: 'User updated' });
  } catch (err: any) {
    logger.error('Admin update user error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// ─── GET /support — Support Inbox (List Threads) ───────────────────────────

router.get('/support', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;
    const channel = req.query.channel as string | undefined;
    const escalated = req.query.escalated === 'true' ? true : req.query.escalated === 'false' ? false : undefined;

    const { threads, total } = getSupportThreads({ status, channel, escalated, limit, offset });
    res.json({ success: true, data: { threads, total, limit, offset } });
  } catch (err: any) {
    logger.error('Admin support inbox error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load support inbox' });
  }
});

// ─── GET /support/stats — Support Statistics ────────────────────────────────

router.get('/support/stats', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const stats = getSupportStats();
    res.json({ success: true, data: stats });
  } catch (err: any) {
    logger.error('Admin support stats error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load support stats' });
  }
});

// ─── GET /support/:id — Thread Detail + Messages ───────────────────────────

router.get('/support/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const thread = getDb().prepare('SELECT * FROM support_threads WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }

    const messages = getSupportMessages(req.params.id);
    res.json({ success: true, data: { thread, messages } });
  } catch (err: any) {
    logger.error('Admin thread detail error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load thread' });
  }
});

// ─── PATCH /support/:id — Update Thread Status ─────────────────────────────

const updateThreadSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'escalated']).optional(),
  assignTo: z.string().optional(),
});

router.patch('/support/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const parsed = updateThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
    }

    const thread = getDb().prepare('SELECT * FROM support_threads WHERE id = ?').get(req.params.id);
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }

    const adminId = (req as any).user.sub;
    const { status, assignTo } = parsed.data;

    if (status) updateSupportThreadStatus(req.params.id, status);
    if (assignTo) assignSupportThread(req.params.id, assignTo);

    logger.info('Admin updated support thread', { adminId, threadId: req.params.id, changes: parsed.data });
    res.json({ success: true, message: 'Thread updated' });
  } catch (err: any) {
    logger.error('Admin update thread error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update thread' });
  }
});

// ─── POST /support/:id/reply — Admin Reply to Thread ────────────────────────

const replySchema = z.object({
  message: z.string().min(1).max(5000),
  sendEmail: z.boolean().optional().default(false),
});

router.post('/support/:id/reply', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
    }

    const thread = getDb().prepare('SELECT * FROM support_threads WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }

    const adminId = (req as any).user.sub;
    const { message, sendEmail } = parsed.data;

    // Save admin reply as assistant message
    addSupportMessage({
      id: uuid(),
      threadId: req.params.id,
      role: 'assistant',
      content: `[ADMIN REPLY] ${message}`,
    });

    // Update thread status to in_progress if it was open
    if (thread.status === 'open' || thread.status === 'escalated') {
      updateSupportThreadStatus(req.params.id, 'in_progress');
      assignSupportThread(req.params.id, adminId);
    }

    // Optionally send email reply
    if (sendEmail && thread.customer_email) {
      try {
        const { Resend } = await import('resend');
        const apiKey = process.env.RESEND_API_KEY;
        if (apiKey) {
          const resend = new Resend(apiKey);
          await resend.emails.send({
            from: process.env.EMAIL_FROM ?? 'BorealisMark Support <support@borealisprotocol.ai>',
            to: [thread.customer_email],
            subject: thread.subject ? `Re: ${thread.subject}` : 'BorealisMark Support Follow-up',
            text: `Hi ${thread.customer_name || 'there'},\n\n${message}\n\n---\nBorealisMark Support Team\nsupport@borealisprotocol.ai`,
          });
          logger.info('Admin email reply sent', { threadId: req.params.id, to: thread.customer_email });
        }
      } catch (emailErr: any) {
        logger.error('Failed to send admin email reply', { error: emailErr.message });
      }
    }

    logger.info('Admin replied to support thread', { adminId, threadId: req.params.id, sendEmail });
    res.json({ success: true, message: 'Reply sent' });
  } catch (err: any) {
    logger.error('Admin reply error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to send reply' });
  }
});

// ─── GET /events — Platform Event Log ──────────────────────────────────────

router.get('/events', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const category = req.query.category as string | undefined;
    const eventType = req.query.type as string | undefined;
    const actorId = req.query.actor as string | undefined;
    const since = req.query.since ? parseInt(req.query.since as string) : undefined;

    const { events, total } = getPlatformEvents({ category, eventType, actorId, since, limit, offset });
    res.json({ success: true, data: { events, total, limit, offset } });
  } catch (err: any) {
    logger.error('Admin events error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load events' });
  }
});

// ─── GET /events/stats — Event Statistics ──────────────────────────────────

router.get('/events/stats', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const since = req.query.since ? parseInt(req.query.since as string) : undefined;
    const stats = getEventStats(since);
    res.json({ success: true, data: stats });
  } catch (err: any) {
    logger.error('Admin event stats error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load event stats' });
  }
});

// ─── POST /backup — Create database backup and upload to R2 ─────────────────

router.post('/backup', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!isR2Enabled()) {
      return res.status(503).json({
        success: false,
        error: 'R2 storage is not configured. Set R2_* environment variables to enable backups.',
        r2Status: getR2Status(),
      });
    }

    const db = getDb();
    const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'borealismark.db');

    if (!existsSync(dbPath)) {
      return res.status(500).json({
        success: false,
        error: 'Database file not found at expected path.',
      });
    }

    // Create a backup copy using SQLite's backup API (safe for WAL mode)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const backupPath = path.join('/tmp', `borealismark-backup-${timestamp}.db`);

    // Use SQLite VACUUM INTO for a clean, consistent backup
    db.exec(`VACUUM INTO '${backupPath}'`);

    // Compress the backup
    const compressedPath = `${backupPath}.gz`;
    execSync(`gzip -c "${backupPath}" > "${compressedPath}"`);

    const backupStats = statSync(compressedPath);
    logger.info('Database backup created', {
      originalSize: statSync(backupPath).size,
      compressedSize: backupStats.size,
      path: compressedPath,
    });

    // Upload to R2
    const result = await uploadDatabaseBackup(compressedPath, `borealismark-${timestamp}.db.gz`);

    // Clean up temp files
    try {
      execSync(`rm -f "${backupPath}" "${compressedPath}"`);
    } catch { /* best effort cleanup */ }

    logger.info('Database backup uploaded to R2', {
      key: result.key,
      size: result.size,
      url: result.url,
    });

    res.json({
      success: true,
      data: {
        key: result.key,
        size: result.size,
        sizeHuman: `${(result.size / 1024 / 1024).toFixed(2)} MB`,
        url: result.url,
        createdAt: Date.now(),
      },
    });
  } catch (err: any) {
    logger.error('Database backup failed', { error: err.message });
    res.status(500).json({
      success: false,
      error: 'Database backup failed',
      details: err.message,
    });
  }
});

// ─── GET /r2-status — Check R2 storage configuration ────────────────────────

router.get('/r2-status', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: getR2Status(),
  });
});

export default router;
