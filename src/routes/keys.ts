import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey, requireScope } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { createApiKey, listApiKeys, revokeApiKey } from '../db/database';
import { auditLog } from '../middleware/logger';
import { keyCreationLimiter } from '../middleware/rateLimiter';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const VALID_SCOPES = ['audit', 'read', 'webhook', 'admin'] as const;

const CreateKeySchema = z.object({
  name: z.string().min(2).max(80),
  scopes: z
    .array(z.enum(VALID_SCOPES))
    .min(1)
    .default(['audit', 'read']),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(3650) // 10 years max
    .optional(),
});

const RevokeKeySchema = z.object({
  reason: z.string().max(200).optional(),
});

// ─── POST /v1/keys ─────────────────────────────────────────────────────────────
// Create a new API key. Requires admin scope.
// Returns the raw key ONCE — store it securely, it cannot be recovered.

router.post(
  '/',
  requireApiKey,
  requireScope('admin'),
  keyCreationLimiter,
  validateBody(CreateKeySchema),
  (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const { name, scopes, expiresInDays } = req.body as z.infer<typeof CreateKeySchema>;

    const expiresAt = expiresInDays
      ? Date.now() + expiresInDays * 24 * 60 * 60 * 1000
      : undefined;

    const newKey = createApiKey(name, scopes, expiresAt);

    auditLog('api_key.created', authReq.apiKey.id, {
      newKeyId: newKey.id,
      name,
      scopes,
      expiresAt: newKey.expiresAt,
      requestId: authReq.requestId,
    });

    res.status(201).json({
      success: true,
      data: {
        id: newKey.id,
        name: newKey.name,
        scopes: newKey.scopes,
        // Raw key returned ONCE — not stored, cannot be recovered
        key: newKey.rawKey,
        createdAt: newKey.createdAt,
        expiresAt: newKey.expiresAt,
        warning: 'Store this key securely. It will not be shown again.',
      },
      timestamp: Date.now(),
    });
  },
);

// ─── GET /v1/keys ─────────────────────────────────────────────────────────────
// List all API keys (raw key values are never returned).

router.get('/', requireApiKey, requireScope('admin'), keyCreationLimiter, (_req, res) => {
  const keys = listApiKeys();

  res.json({
    success: true,
    data: keys,
    total: keys.length,
    timestamp: Date.now(),
  });
});

// ─── DELETE /v1/keys/:id ──────────────────────────────────────────────────────
// Revoke a key. Immediate effect — ongoing requests using the key will fail.

router.delete(
  '/:id',
  requireApiKey,
  requireScope('admin'),
  validateBody(RevokeKeySchema),
  (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;
    const { reason } = (req.body ?? {}) as z.infer<typeof RevokeKeySchema>;

    // Prevent self-revocation — operators cannot cut their own access
    if (id === authReq.apiKey.id) {
      res.status(400).json({
        success: false,
        error: 'You cannot revoke your own API key. Use a different admin key.',
        timestamp: Date.now(),
      });
      return;
    }

    const revoked = revokeApiKey(id, reason);
    if (!revoked) {
      res.status(404).json({
        success: false,
        error: 'Key not found or already revoked',
        timestamp: Date.now(),
      });
      return;
    }

    auditLog('api_key.revoked', authReq.apiKey.id, {
      revokedKeyId: id,
      reason: reason ?? 'No reason provided',
      requestId: authReq.requestId,
    });

    res.json({
      success: true,
      data: { id, revoked: true, revokedAt: Date.now() },
      timestamp: Date.now(),
    });
  },
);

export default router;
