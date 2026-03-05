import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey, requireScope } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { createWebhook, listWebhooks, deleteWebhook } from '../db/database';
import { auditLog } from '../middleware/logger';
import { webhookLimiter } from '../middleware/rateLimiter';
import { WEBHOOK_EVENTS, emit } from '../engine/webhook-dispatcher';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const CreateWebhookSchema = z.object({
  url: z
    .string()
    .url()
    .startsWith('https://', { message: 'Webhook URLs must use HTTPS' }),
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1, { message: 'Subscribe to at least one event' })
    .max(WEBHOOK_EVENTS.length),
});

// ─── POST /v1/webhooks ────────────────────────────────────────────────────────
// Register a new webhook endpoint.
// Returns the signing secret ONCE — store it to verify incoming payloads.

router.post(
  '/',
  requireApiKey,
  requireScope('webhook'),
  webhookLimiter,
  validateBody(CreateWebhookSchema),
  (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const { url, events } = req.body as z.infer<typeof CreateWebhookSchema>;

    // Validate webhook URL to prevent SSRF attacks
    try {
      const webhookUrl = new URL(url);
      const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', 'metadata.google.internal'];
      const isBlocked = blockedHosts.some(h => webhookUrl.hostname === h) ||
                        webhookUrl.hostname.endsWith('.internal') ||
                        webhookUrl.hostname.startsWith('10.') ||
                        webhookUrl.hostname.startsWith('192.168.') ||
                        webhookUrl.hostname.startsWith('172.');
      if (isBlocked) {
        res.status(400).json({
          success: false,
          error: 'Webhook URLs cannot point to private/internal addresses',
          timestamp: Date.now(),
        });
        return;
      }
    } catch (err) {
      res.status(400).json({
        success: false,
        error: 'Invalid webhook URL',
        timestamp: Date.now(),
      });
      return;
    }

    // Check webhook limit per API key
    const existing = listWebhooks(authReq.apiKey.id);
    if (existing.length >= 10) {
      res.status(400).json({
        success: false,
        error: 'Maximum 10 webhooks per API key',
        timestamp: Date.now(),
      });
      return;
    }

    const { id, rawSecret } = createWebhook(authReq.apiKey.id, url, events);

    auditLog('webhook.created', authReq.apiKey.id, {
      webhookId: id,
      url,
      events,
      requestId: authReq.requestId,
    });

    res.status(201).json({
      success: true,
      data: {
        id,
        url,
        events,
        // Signing secret returned ONCE — use to verify X-BorealisMark-Signature
        secret: rawSecret,
        createdAt: Date.now(),
        verificationNote: [
          'Verify incoming webhooks by computing HMAC-SHA256(secret, rawBody)',
          'and comparing with the X-BorealisMark-Signature header.',
          'Format: sha256=<hex_digest>',
        ].join(' '),
      },
      timestamp: Date.now(),
    });
  },
);

// ─── GET /v1/webhooks ─────────────────────────────────────────────────────────
// List all webhooks owned by the authenticated key.

router.get('/', requireApiKey, requireScope('webhook'), (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const hooks = listWebhooks(authReq.apiKey.id);

  res.json({
    success: true,
    data: hooks,
    total: hooks.length,
    timestamp: Date.now(),
  });
});

// ─── POST /v1/webhooks/:id/test ───────────────────────────────────────────────
// Send a test ping to confirm the endpoint is reachable and HMAC verification works.

router.post('/:id/test', requireApiKey, requireScope('webhook'), (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const hooks = listWebhooks(authReq.apiKey.id);
  const hook = hooks.find(h => h.id === req.params.id);

  if (!hook) {
    res.status(404).json({
      success: false,
      error: 'Webhook not found or not owned by this key',
      timestamp: Date.now(),
    });
    return;
  }

  // Fire async — don't await
  emit.webhookTest(hook.id);

  res.json({
    success: true,
    data: {
      message: 'Test event dispatched. Check your endpoint for the webhook.test payload.',
      webhookId: hook.id,
      url: hook.url,
    },
    timestamp: Date.now(),
  });
});

// ─── DELETE /v1/webhooks/:id ──────────────────────────────────────────────────
// Remove a webhook. Immediate — no more events will be delivered.

router.delete('/:id', requireApiKey, requireScope('webhook'), (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const deleted = deleteWebhook(req.params.id, authReq.apiKey.id);

  if (!deleted) {
    res.status(404).json({
      success: false,
      error: 'Webhook not found or not owned by this key',
      timestamp: Date.now(),
    });
    return;
  }

  auditLog('webhook.deleted', authReq.apiKey.id, {
    webhookId: req.params.id,
    requestId: authReq.requestId,
  });

  res.json({
    success: true,
    data: { id: req.params.id, deleted: true },
    timestamp: Date.now(),
  });
});

// ─── GET /v1/webhooks/events ─────────────────────────────────────────────────
// Returns the full list of subscribable event types.

router.get('/events', requireApiKey, (_req, res) => {
  res.json({
    success: true,
    data: WEBHOOK_EVENTS.map(event => ({
      event,
      description: EVENT_DESCRIPTIONS[event] ?? event,
    })),
    timestamp: Date.now(),
  });
});

// ─── Event Descriptions ───────────────────────────────────────────────────────

const EVENT_DESCRIPTIONS: Record<string, string> = {
  'audit.completed':   'Fired when an audit certificate is successfully issued.',
  'audit.anchored':    'Fired when the certificate is confirmed on Hedera HCS.',
  'score.degraded':    'Fired when an agent score drops by 50+ points vs previous audit.',
  'score.improved':    'Fired when an agent score improves by 50+ points vs previous audit.',
  'stake.allocated':   'Fired when BMT stake is allocated to an agent.',
  'slash.executed':    'Fired when a slashing event is executed.',
  'agent.registered':  'Fired when a new agent is registered.',
  'key.revoked':       'Fired when an API key is revoked.',
  'webhook.test':      'Test ping — use to verify your endpoint configuration.',
};

export default router;
