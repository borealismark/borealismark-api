/**
 * BorealisMark — Admin Mail Center
 *
 * Secure admin-only email management system. Full inbox/outbox with compose,
 * reply, forward, star, archive, trash, search, and label support.
 *
 * All endpoints require JWT + admin role.
 *
 *   GET    /v1/admin/mail/messages        — List emails (inbox/sent/starred/archived/trash)
 *   GET    /v1/admin/mail/messages/:id    — Read single email + thread
 *   POST   /v1/admin/mail/compose         — Compose & send new email
 *   POST   /v1/admin/mail/messages/:id/reply   — Reply to email
 *   POST   /v1/admin/mail/messages/:id/forward — Forward email
 *   PUT    /v1/admin/mail/messages/:id/star    — Toggle star
 *   PUT    /v1/admin/mail/messages/:id/read    — Toggle read/unread
 *   PUT    /v1/admin/mail/messages/:id/archive — Move to archive
 *   PUT    /v1/admin/mail/messages/:id/trash   — Move to trash
 *   PUT    /v1/admin/mail/messages/:id/restore — Restore from trash/archive
 *   PUT    /v1/admin/mail/messages/:id/label   — Add/remove labels
 *   DELETE /v1/admin/mail/messages/:id         — Permanent delete
 *   GET    /v1/admin/mail/stats           — Mailbox statistics
 *   GET    /v1/admin/mail/labels          — List labels
 *   POST   /v1/admin/mail/labels          — Create label
 *   DELETE /v1/admin/mail/labels/:id      — Delete label
 *   POST   /v1/admin/mail/bulk            — Bulk actions
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { Resend } from 'resend';
import { requireAuth } from './auth';
import { logger } from '../middleware/logger';
import { getDb, getUserById } from '../db/database';

const router = Router();

// ─── Admin Gating ───────────────────────────────────────────────────────────

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
  (req as any).adminUser = user;
  next();
}

router.use(requireAuth, requireAdmin);

// ─── Schema Init ────────────────────────────────────────────────────────────

let _initialized = false;

function initMailSchema(): void {
  if (_initialized) return;
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_emails (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      parent_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      from_address TEXT NOT NULL,
      from_name TEXT DEFAULT '',
      to_address TEXT NOT NULL,
      to_name TEXT DEFAULT '',
      cc TEXT DEFAULT '',
      bcc TEXT DEFAULT '',
      subject TEXT NOT NULL DEFAULT '(no subject)',
      body_text TEXT NOT NULL DEFAULT '',
      body_html TEXT DEFAULT '',
      snippet TEXT DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_trashed INTEGER NOT NULL DEFAULT 0,
      is_draft INTEGER NOT NULL DEFAULT 0,
      labels TEXT DEFAULT '[]',
      attachments TEXT DEFAULT '[]',
      message_id_header TEXT,
      in_reply_to TEXT,
      references_header TEXT,
      resend_id TEXT,
      source TEXT DEFAULT 'manual',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_admin_emails_thread ON admin_emails(thread_id);
    CREATE INDEX IF NOT EXISTS idx_admin_emails_direction ON admin_emails(direction);
    CREATE INDEX IF NOT EXISTS idx_admin_emails_created ON admin_emails(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_emails_from ON admin_emails(from_address);
    CREATE INDEX IF NOT EXISTS idx_admin_emails_to ON admin_emails(to_address);
    CREATE INDEX IF NOT EXISTS idx_admin_emails_starred ON admin_emails(is_starred);
    CREATE INDEX IF NOT EXISTS idx_admin_emails_archived ON admin_emails(is_archived);
    CREATE INDEX IF NOT EXISTS idx_admin_emails_trashed ON admin_emails(is_trashed);

    CREATE TABLE IF NOT EXISTS admin_mail_labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#d4a853',
      created_at INTEGER NOT NULL
    );
  `);

  // Seed default labels
  const existing = db.prepare('SELECT COUNT(*) as c FROM admin_mail_labels').get() as any;
  if (existing.c === 0) {
    const now = Date.now();
    const stmt = db.prepare('INSERT OR IGNORE INTO admin_mail_labels (id, name, color, created_at) VALUES (?,?,?,?)');
    stmt.run(uuid(), 'Important', '#f87171', now);
    stmt.run(uuid(), 'Business', '#d4a853', now);
    stmt.run(uuid(), 'Support', '#34d399', now);
    stmt.run(uuid(), 'Finance', '#60a5fa', now);
    stmt.run(uuid(), 'Personal', '#a78bfa', now);
  }

  _initialized = true;
  logger.info('Admin mail schema initialized');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// CRITICAL: Outbound emails MUST use verified branded domains — NEVER *.cloudflare.dev or *.workers.dev
const FROM_ADDRESS = process.env.EMAIL_FROM ?? 'BorealisMark <support@borealisprotocol.ai>';
const ADMIN_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL ?? 'esimon.ng@gmail.com';

// Safety check on FROM address
if (FROM_ADDRESS.includes('.workers.dev') || FROM_ADDRESS.includes('.pages.dev') || FROM_ADDRESS.includes('cloudflare.dev')) {
  throw new Error('EMAIL_FROM must not use .workers.dev, .pages.dev, or cloudflare.dev domains');
}

function makeSnippet(text: string, maxLen = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean;
}

async function sendViaResend(opts: {
  to: string; subject: string; html?: string; text: string;
  cc?: string; bcc?: string; inReplyTo?: string; references?: string;
}): Promise<{ id: string } | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('Admin mail send skipped — no RESEND_API_KEY');
    return null;
  }

  try {
    const r = new Resend(apiKey);
    const headers: Record<string, string> = {};
    if (opts.inReplyTo) headers['In-Reply-To'] = opts.inReplyTo;
    if (opts.references) headers['References'] = opts.references;

    const payload: any = {
      from: FROM_ADDRESS,
      to: opts.to.split(',').map(e => e.trim()).filter(Boolean),
      subject: opts.subject,
      text: opts.text,
      headers,
    };
    if (opts.html) payload.html = opts.html;
    if (opts.cc) payload.cc = opts.cc.split(',').map(e => e.trim()).filter(Boolean);
    if (opts.bcc) payload.bcc = opts.bcc.split(',').map(e => e.trim()).filter(Boolean);

    const result = await r.emails.send(payload);
    return { id: (result as any).data?.id ?? 'sent' };
  } catch (err: any) {
    logger.error('Resend send failed', { error: err.message });
    return null;
  }
}

function buildHtmlEmail(body: string, subject: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; background:#0C0D10; color:#E0E0E0; }
  .container { max-width:600px; margin:40px auto; padding:0 20px; }
  .card { background:#16171C; border:1px solid #2A2B33; border-radius:12px; padding:32px; border-top:3px solid #D4A853; }
  .logo { color:#D4A853; font-size:18px; font-weight:700; letter-spacing:-0.3px; margin-bottom:20px; }
  .logo span { color:#888; }
  .body-text { font-size:15px; line-height:1.7; color:#CCC; white-space:pre-wrap; }
  .divider { border-top:1px solid #2A2B33; margin:24px 0; }
  .footer { text-align:center; padding:20px 0; font-size:12px; color:#555; }
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <div class="logo"><span>Borealis</span>Mark</div>
    <div class="body-text">${body.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>
  </div>
  <div class="footer">BorealisMark Protocol &mdash; Blockchain-Anchored AI Trust</div>
</div>
</body>
</html>`;
}

// ─── GET /messages — List Emails ────────────────────────────────────────────

router.get('/messages', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const db = getDb();

    const folder = (req.query.folder as string) || 'inbox';
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string | undefined;
    const label = req.query.label as string | undefined;
    const starred = req.query.starred === 'true';

    let where = 'WHERE is_draft = 0';
    const params: any[] = [];

    switch (folder) {
      case 'inbox':
        where += ' AND is_archived = 0 AND is_trashed = 0';
        break;
      case 'sent':
        where += " AND direction = 'outbound' AND is_trashed = 0";
        break;
      case 'starred':
        where += ' AND is_starred = 1 AND is_trashed = 0';
        break;
      case 'archived':
        where += ' AND is_archived = 1 AND is_trashed = 0';
        break;
      case 'trash':
        where += ' AND is_trashed = 1';
        break;
      case 'all':
        where += ' AND is_trashed = 0';
        break;
      default:
        where += ' AND is_archived = 0 AND is_trashed = 0';
    }

    if (starred) where += ' AND is_starred = 1';

    if (search) {
      where += ' AND (subject LIKE ? OR body_text LIKE ? OR from_address LIKE ? OR to_address LIKE ? OR from_name LIKE ?)';
      const q = `%${search}%`;
      params.push(q, q, q, q, q);
    }

    if (label) {
      where += ' AND labels LIKE ?';
      params.push(`%"${label}"%`);
    }

    const total = (db.prepare(`SELECT COUNT(*) as c FROM admin_emails ${where}`).get(...params) as any).c;
    const messages = db.prepare(
      `SELECT id, thread_id, direction, from_address, from_name, to_address, to_name, cc, subject, snippet,
              is_read, is_starred, is_archived, is_trashed, labels, source, created_at, updated_at
       FROM admin_emails ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    res.json({
      success: true,
      data: { messages, total, limit, offset, folder },
    });
  } catch (err: any) {
    logger.error('Admin mail list error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list emails' });
  }
});

// ─── GET /messages/:id — Read Single Email ──────────────────────────────────

router.get('/messages/:id', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const db = getDb();

    const email = db.prepare('SELECT * FROM admin_emails WHERE id = ?').get(req.params.id) as any;
    if (!email) {
      return res.status(404).json({ success: false, error: 'Email not found' });
    }

    // Mark as read
    if (!email.is_read) {
      db.prepare('UPDATE admin_emails SET is_read = 1, updated_at = ? WHERE id = ?').run(Date.now(), req.params.id);
      email.is_read = 1;
    }

    // Get thread (all emails in the same conversation)
    const thread = db.prepare(
      'SELECT id, direction, from_address, from_name, to_address, subject, snippet, body_text, body_html, is_read, created_at FROM admin_emails WHERE thread_id = ? ORDER BY created_at ASC'
    ).all(email.thread_id);

    res.json({
      success: true,
      data: { email, thread, threadCount: thread.length },
    });
  } catch (err: any) {
    logger.error('Admin mail read error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to read email' });
  }
});

// ─── POST /compose — Compose & Send ────────────────────────────────────────

const composeSchema = z.object({
  to: z.string().min(1),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50000),
  cc: z.string().optional().default(''),
  bcc: z.string().optional().default(''),
  isDraft: z.boolean().optional().default(false),
});

router.post('/compose', async (req: Request, res: Response) => {
  try {
    initMailSchema();
    const parsed = composeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten() });
    }

    const { to, subject, body, cc, bcc, isDraft } = parsed.data;
    const now = Date.now();
    const id = uuid();
    const threadId = uuid();

    let resendId: string | null = null;
    if (!isDraft) {
      const html = buildHtmlEmail(body, subject);
      const result = await sendViaResend({ to, subject, html, text: body, cc, bcc });
      resendId = result?.id ?? null;
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO admin_emails (id, thread_id, direction, from_address, from_name, to_address, to_name, cc, bcc, subject, body_text, body_html, snippet, is_read, is_draft, resend_id, source, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)
    `).run(
      id, threadId, 'outbound',
      ADMIN_EMAIL, 'BorealisMark Admin',
      to, '', cc, bcc,
      subject, body, buildHtmlEmail(body, subject),
      makeSnippet(body),
      isDraft ? 1 : 0,
      resendId,
      'compose',
      now, now,
    );

    logger.info('Admin composed email', { id, to, subject, isDraft });
    res.json({
      success: true,
      data: { id, threadId, sent: !isDraft, resendId },
      message: isDraft ? 'Draft saved' : 'Email sent',
    });
  } catch (err: any) {
    logger.error('Admin compose error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to compose email' });
  }
});

// ─── POST /messages/:id/reply — Reply to Email ─────────────────────────────

const replySchema = z.object({
  body: z.string().min(1).max(50000),
  replyAll: z.boolean().optional().default(false),
});

router.post('/messages/:id/reply', async (req: Request, res: Response) => {
  try {
    initMailSchema();
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed' });
    }

    const db = getDb();
    const original = db.prepare('SELECT * FROM admin_emails WHERE id = ?').get(req.params.id) as any;
    if (!original) {
      return res.status(404).json({ success: false, error: 'Email not found' });
    }

    const { body, replyAll } = parsed.data;
    const now = Date.now();
    const id = uuid();

    // Determine recipients
    const replyTo = original.direction === 'inbound' ? original.from_address : original.to_address;
    let cc = '';
    if (replyAll && original.cc) cc = original.cc;

    const subject = original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`;
    const html = buildHtmlEmail(body, subject);

    const result = await sendViaResend({
      to: replyTo, subject, html, text: body, cc,
      inReplyTo: original.message_id_header,
      references: original.references_header
        ? `${original.references_header} ${original.message_id_header}`
        : original.message_id_header,
    });

    db.prepare(`
      INSERT INTO admin_emails (id, thread_id, parent_id, direction, from_address, from_name, to_address, cc, subject, body_text, body_html, snippet, is_read, resend_id, source, message_id_header, in_reply_to, references_header, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)
    `).run(
      id, original.thread_id, original.id, 'outbound',
      ADMIN_EMAIL, 'BorealisMark Admin',
      replyTo, cc, subject, body, html,
      makeSnippet(body),
      result?.id ?? null,
      'reply',
      null, original.message_id_header,
      original.references_header || original.message_id_header,
      now, now,
    );

    logger.info('Admin replied to email', { id, to: replyTo, threadId: original.thread_id });
    res.json({ success: true, data: { id, sent: !!result }, message: 'Reply sent' });
  } catch (err: any) {
    logger.error('Admin reply error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to send reply' });
  }
});

// ─── POST /messages/:id/forward — Forward Email ────────────────────────────

const forwardSchema = z.object({
  to: z.string().min(1),
  body: z.string().optional().default(''),
});

router.post('/messages/:id/forward', async (req: Request, res: Response) => {
  try {
    initMailSchema();
    const parsed = forwardSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed' });
    }

    const db = getDb();
    const original = db.prepare('SELECT * FROM admin_emails WHERE id = ?').get(req.params.id) as any;
    if (!original) {
      return res.status(404).json({ success: false, error: 'Email not found' });
    }

    const { to, body } = parsed.data;
    const now = Date.now();
    const id = uuid();
    const subject = `Fwd: ${original.subject.replace(/^Fwd:\s*/i, '')}`;

    const forwardBody = `${body}\n\n---------- Forwarded message ----------\nFrom: ${original.from_address}\nDate: ${new Date(original.created_at).toLocaleString()}\nSubject: ${original.subject}\n\n${original.body_text}`;
    const html = buildHtmlEmail(forwardBody, subject);

    const result = await sendViaResend({ to, subject, html, text: forwardBody });

    db.prepare(`
      INSERT INTO admin_emails (id, thread_id, parent_id, direction, from_address, from_name, to_address, subject, body_text, body_html, snippet, is_read, resend_id, source, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)
    `).run(
      id, uuid(), original.id, 'outbound',
      ADMIN_EMAIL, 'BorealisMark Admin',
      to, subject, forwardBody, html,
      makeSnippet(forwardBody),
      result?.id ?? null,
      'forward',
      now, now,
    );

    logger.info('Admin forwarded email', { id, to, originalId: original.id });
    res.json({ success: true, data: { id, sent: !!result }, message: 'Email forwarded' });
  } catch (err: any) {
    logger.error('Admin forward error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to forward email' });
  }
});

// ─── PUT /messages/:id/star — Toggle Star ───────────────────────────────────

router.put('/messages/:id/star', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const db = getDb();
    const email = db.prepare('SELECT id, is_starred FROM admin_emails WHERE id = ?').get(req.params.id) as any;
    if (!email) return res.status(404).json({ success: false, error: 'Email not found' });

    const newVal = email.is_starred ? 0 : 1;
    db.prepare('UPDATE admin_emails SET is_starred = ?, updated_at = ? WHERE id = ?').run(newVal, Date.now(), req.params.id);
    res.json({ success: true, data: { starred: !!newVal } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to toggle star' });
  }
});

// ─── PUT /messages/:id/read — Toggle Read ───────────────────────────────────

router.put('/messages/:id/read', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const db = getDb();
    const email = db.prepare('SELECT id, is_read FROM admin_emails WHERE id = ?').get(req.params.id) as any;
    if (!email) return res.status(404).json({ success: false, error: 'Email not found' });

    const newVal = req.body.read !== undefined ? (req.body.read ? 1 : 0) : (email.is_read ? 0 : 1);
    db.prepare('UPDATE admin_emails SET is_read = ?, updated_at = ? WHERE id = ?').run(newVal, Date.now(), req.params.id);
    res.json({ success: true, data: { read: !!newVal } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to toggle read' });
  }
});

// ─── PUT /messages/:id/archive — Archive ────────────────────────────────────

router.put('/messages/:id/archive', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const db = getDb();
    db.prepare('UPDATE admin_emails SET is_archived = 1, is_trashed = 0, updated_at = ? WHERE id = ?').run(Date.now(), req.params.id);
    res.json({ success: true, message: 'Email archived' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to archive' });
  }
});

// ─── PUT /messages/:id/trash — Trash ────────────────────────────────────────

router.put('/messages/:id/trash', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const db = getDb();
    db.prepare('UPDATE admin_emails SET is_trashed = 1, is_archived = 0, updated_at = ? WHERE id = ?').run(Date.now(), req.params.id);
    res.json({ success: true, message: 'Email moved to trash' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to trash' });
  }
});

// ─── PUT /messages/:id/restore — Restore ────────────────────────────────────

router.put('/messages/:id/restore', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const db = getDb();
    db.prepare('UPDATE admin_emails SET is_trashed = 0, is_archived = 0, updated_at = ? WHERE id = ?').run(Date.now(), req.params.id);
    res.json({ success: true, message: 'Email restored' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to restore' });
  }
});

// ─── PUT /messages/:id/label — Add/Remove Labels ───────────────────────────

const labelSchema = z.object({
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
});

router.put('/messages/:id/label', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const parsed = labelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Validation failed' });

    const db = getDb();
    const email = db.prepare('SELECT id, labels FROM admin_emails WHERE id = ?').get(req.params.id) as any;
    if (!email) return res.status(404).json({ success: false, error: 'Email not found' });

    let labels: string[] = [];
    try { labels = JSON.parse(email.labels || '[]'); } catch { labels = []; }

    if (parsed.data.add) labels = [...new Set([...labels, ...parsed.data.add])];
    if (parsed.data.remove) labels = labels.filter(l => !parsed.data.remove!.includes(l));

    db.prepare('UPDATE admin_emails SET labels = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(labels), Date.now(), req.params.id);
    res.json({ success: true, data: { labels } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to update labels' });
  }
});

// ─── DELETE /messages/:id — Permanent Delete ────────────────────────────────

router.delete('/messages/:id', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const db = getDb();
    const email = db.prepare('SELECT id, is_trashed FROM admin_emails WHERE id = ?').get(req.params.id) as any;
    if (!email) return res.status(404).json({ success: false, error: 'Email not found' });
    if (!email.is_trashed) return res.status(400).json({ success: false, error: 'Must be trashed before permanent delete' });

    db.prepare('DELETE FROM admin_emails WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Email permanently deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to delete' });
  }
});

// ─── GET /stats — Mailbox Statistics ────────────────────────────────────────

router.get('/stats', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const db = getDb();

    const inbox = (db.prepare('SELECT COUNT(*) as c FROM admin_emails WHERE is_archived=0 AND is_trashed=0 AND is_draft=0').get() as any).c;
    const unread = (db.prepare('SELECT COUNT(*) as c FROM admin_emails WHERE is_read=0 AND is_archived=0 AND is_trashed=0 AND is_draft=0').get() as any).c;
    const starred = (db.prepare('SELECT COUNT(*) as c FROM admin_emails WHERE is_starred=1 AND is_trashed=0').get() as any).c;
    const sent = (db.prepare("SELECT COUNT(*) as c FROM admin_emails WHERE direction='outbound' AND is_trashed=0 AND is_draft=0").get() as any).c;
    const drafts = (db.prepare('SELECT COUNT(*) as c FROM admin_emails WHERE is_draft=1').get() as any).c;
    const archived = (db.prepare('SELECT COUNT(*) as c FROM admin_emails WHERE is_archived=1 AND is_trashed=0').get() as any).c;
    const trash = (db.prepare('SELECT COUNT(*) as c FROM admin_emails WHERE is_trashed=1').get() as any).c;

    res.json({
      success: true,
      data: { inbox, unread, starred, sent, drafts, archived, trash },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to load stats' });
  }
});

// ─── Labels CRUD ────────────────────────────────────────────────────────────

router.get('/labels', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const labels = getDb().prepare('SELECT * FROM admin_mail_labels ORDER BY name').all();
    res.json({ success: true, data: { labels } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to load labels' });
  }
});

router.post('/labels', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Label name required' });

    const id = uuid();
    getDb().prepare('INSERT INTO admin_mail_labels (id, name, color, created_at) VALUES (?,?,?,?)').run(id, name, color || '#d4a853', Date.now());
    res.json({ success: true, data: { id, name, color } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to create label' });
  }
});

router.delete('/labels/:id', (req: Request, res: Response) => {
  try {
    initMailSchema();
    getDb().prepare('DELETE FROM admin_mail_labels WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Label deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to delete label' });
  }
});

// ─── POST /bulk — Bulk Actions ──────────────────────────────────────────────

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
  action: z.enum(['read', 'unread', 'star', 'unstar', 'archive', 'trash', 'restore', 'delete']),
});

router.post('/bulk', (req: Request, res: Response) => {
  try {
    initMailSchema();
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Validation failed' });

    const db = getDb();
    const { ids, action } = parsed.data;
    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');

    switch (action) {
      case 'read':
        db.prepare(`UPDATE admin_emails SET is_read=1, updated_at=? WHERE id IN (${placeholders})`).run(now, ...ids);
        break;
      case 'unread':
        db.prepare(`UPDATE admin_emails SET is_read=0, updated_at=? WHERE id IN (${placeholders})`).run(now, ...ids);
        break;
      case 'star':
        db.prepare(`UPDATE admin_emails SET is_starred=1, updated_at=? WHERE id IN (${placeholders})`).run(now, ...ids);
        break;
      case 'unstar':
        db.prepare(`UPDATE admin_emails SET is_starred=0, updated_at=? WHERE id IN (${placeholders})`).run(now, ...ids);
        break;
      case 'archive':
        db.prepare(`UPDATE admin_emails SET is_archived=1, is_trashed=0, updated_at=? WHERE id IN (${placeholders})`).run(now, ...ids);
        break;
      case 'trash':
        db.prepare(`UPDATE admin_emails SET is_trashed=1, updated_at=? WHERE id IN (${placeholders})`).run(now, ...ids);
        break;
      case 'restore':
        db.prepare(`UPDATE admin_emails SET is_trashed=0, is_archived=0, updated_at=? WHERE id IN (${placeholders})`).run(now, ...ids);
        break;
      case 'delete':
        db.prepare(`DELETE FROM admin_emails WHERE is_trashed=1 AND id IN (${placeholders})`).run(...ids);
        break;
    }

    res.json({ success: true, message: `Bulk ${action} applied to ${ids.length} emails` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Bulk action failed' });
  }
});

// ─── Export helper for support integration ──────────────────────────────────

export function storeInboundEmail(opts: {
  from: string; fromName?: string; to?: string; subject: string;
  bodyText: string; bodyHtml?: string; messageId?: string;
  inReplyTo?: string; source?: string; threadId?: string;
}): string {
  initMailSchema();
  const db = getDb();
  const id = uuid();
  const threadId = opts.threadId || opts.inReplyTo
    ? (db.prepare('SELECT thread_id FROM admin_emails WHERE message_id_header = ?').get(opts.inReplyTo) as any)?.thread_id || uuid()
    : uuid();

  const now = Date.now();
  db.prepare(`
    INSERT INTO admin_emails (id, thread_id, direction, from_address, from_name, to_address, subject, body_text, body_html, snippet, message_id_header, in_reply_to, source, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, threadId, 'inbound',
    opts.from, opts.fromName || opts.from.split('@')[0],
    opts.to || ADMIN_EMAIL,
    opts.subject || '(no subject)',
    opts.bodyText,
    opts.bodyHtml || '',
    makeSnippet(opts.bodyText),
    opts.messageId || null,
    opts.inReplyTo || null,
    opts.source || 'email',
    now, now,
  );

  return id;
}

export function storeOutboundEmail(opts: {
  to: string; subject: string; bodyText: string; bodyHtml?: string;
  resendId?: string; source?: string; threadId?: string;
}): string {
  initMailSchema();
  const db = getDb();
  const id = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO admin_emails (id, thread_id, direction, from_address, from_name, to_address, subject, body_text, body_html, snippet, is_read, resend_id, source, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)
  `).run(
    id, opts.threadId || uuid(), 'outbound',
    ADMIN_EMAIL, 'BorealisMark Admin',
    opts.to,
    opts.subject || '(no subject)',
    opts.bodyText,
    opts.bodyHtml || '',
    makeSnippet(opts.bodyText),
    opts.resendId || null,
    opts.source || 'system',
    now, now,
  );

  return id;
}

export default router;
