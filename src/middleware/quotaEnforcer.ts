import type { Request, Response, NextFunction } from 'express';
import { getMonthlyUsageCount, getApiTier, getApiKeyTier } from '../db/database';
import type { AuthenticatedRequest } from './auth';
import { logger } from './logger';

/**
 * In-memory cache for monthly usage counts.
 * Structure: { [apiKeyId_monthKey]: { count: number, cachedAt: number } }
 */
const usageCache = new Map<string, { count: number; cachedAt: number }>();
const CACHE_TTL_MS = 60_000; // Refresh cache every 60 seconds

/**
 * quotaEnforcer — checks monthly usage against tier limits.
 *
 * Must be placed AFTER requireApiKey middleware.
 * Sends 429 with rate limit headers if quota exceeded.
 */
export function quotaEnforcer(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest;

  // Only enforce if we have an authenticated API key
  if (!authReq.apiKey?.id) {
    next();
    return;
  }

  try {
    const apiKeyId = authReq.apiKey.id;
    const tierName = getApiKeyTier(apiKeyId);
    const tier = getApiTier(tierName);

    if (!tier) {
      // Default to free tier limits if tier not found
      next();
      return;
    }

    const monthKey = new Date().toISOString().slice(0, 7);
    const cacheKey = `${apiKeyId}_${monthKey}`;

    let currentUsage: number;
    const cached = usageCache.get(cacheKey);

    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
      currentUsage = cached.count;
    } else {
      currentUsage = getMonthlyUsageCount(apiKeyId, monthKey);
      usageCache.set(cacheKey, { count: currentUsage, cachedAt: Date.now() });
    }

    const limit = tier.monthlyRequestLimit;
    const remaining = Math.max(0, limit - currentUsage);

    // Set rate limit headers on every response
    res.setHeader('X-RateLimit-Limit', limit.toString());
    res.setHeader('X-RateLimit-Remaining', remaining.toString());

    // Reset at the start of next month
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    res.setHeader('X-RateLimit-Reset', Math.floor(nextMonth.getTime() / 1000).toString());

    if (currentUsage >= limit) {
      logger.warn('API quota exceeded', {
        apiKeyId,
        tier: tierName,
        usage: currentUsage,
        limit,
      });

      res.status(429).json({
        success: false,
        error: 'Monthly API quota exceeded',
        quota: {
          tier: tierName,
          limit,
          used: currentUsage,
          resetsAt: nextMonth.toISOString(),
        },
        upgrade: 'Visit https://borealismark.com/dashboard.html#billing to upgrade your API tier.',
        timestamp: Date.now(),
      });
      return;
    }

    // Increment cached count (optimistic)
    if (cached) {
      cached.count++;
    }

    next();
  } catch (err) {
    // Quota enforcement should never break the request
    logger.error('Quota enforcer error', { error: (err as Error).message });
    next();
  }
}

/**
 * Clear the usage cache (for testing or manual reset).
 */
export function clearUsageCache(): void {
  usageCache.clear();
}
