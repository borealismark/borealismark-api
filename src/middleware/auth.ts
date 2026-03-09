import type { Request, Response, NextFunction } from 'express';
import { validateApiKey } from '../db/database';

// ─── Extended Request Type ─────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  apiKey: {
    id: string;
    name: string;
    scopes: string[];
  };
  requestId: string;
}

// ─── Authentication Middleware ─────────────────────────────────────────────────

/**
 * requireApiKey — validates X-Api-Key or Authorization: Bearer header.
 * On success, attaches apiKey metadata to req for downstream scope checks.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const rawKey =
    (req.headers['x-api-key'] as string) ??
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined);

  if (!rawKey) {
    res.status(401).json({
      success: false,
      error: 'Missing API key. Provide via X-Api-Key header or Authorization: Bearer <key>',
      timestamp: Date.now(),
    });
    return;
  }

  const keyInfo = validateApiKey(rawKey);

  if (!keyInfo) {
    res.status(403).json({
      success: false,
      error: 'Invalid, expired, or revoked API key',
      timestamp: Date.now(),
    });
    return;
  }

  // Attach to request for downstream handlers
  (req as AuthenticatedRequest).apiKey = keyInfo;
  next();
}

// ─── Scope Guard ──────────────────────────────────────────────────────────────

/**
 * requireScope — ensures the authenticated key has the required permission.
 * Must be used AFTER requireApiKey.
 *
 * Scope hierarchy:
 *   admin  → can do everything (create/revoke keys, manage webhooks, run audits, write, read)
 *   audit  → can register agents and run audits
 *   write  → can upload images and modify resources
 *   webhook → can manage webhooks
 *   read   → can retrieve certificates and scores
 */
export function requireScope(scope: 'audit' | 'read' | 'write' | 'webhook' | 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;
    const { scopes } = authReq.apiKey;

    // admin scope grants all permissions
    if (scopes.includes('admin') || scopes.includes(scope)) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      error: `Insufficient permissions. Required scope: '${scope}'.`,
      timestamp: Date.now(),
    });
  };
}
