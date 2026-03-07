import type { Request, Response, NextFunction } from 'express';
import { recordApiUsage } from '../db/database';
import type { AuthenticatedRequest } from './auth';

/**
 * usageTracker — logs every API-key-authenticated request to the api_usage table.
 *
 * Captures endpoint, method, status code, and response time.
 * Insert is async (non-blocking) so it doesn't slow down the response.
 * Must be placed AFTER requireApiKey middleware.
 */
export function usageTracker(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest;

  // Only track if we have an authenticated API key
  if (!authReq.apiKey?.id) {
    next();
    return;
  }

  const startTime = Date.now();
  const apiKeyId = authReq.apiKey.id;
  const endpoint = req.path;
  const method = req.method;

  // Hook into response finish to capture status code and timing
  res.on('finish', () => {
    try {
      const responseTime = Date.now() - startTime;
      // Fire-and-forget — don't await
      recordApiUsage(apiKeyId, endpoint, method, res.statusCode, responseTime);
    } catch {
      // Silently ignore — usage tracking should never break the request
    }
  });

  next();
}
