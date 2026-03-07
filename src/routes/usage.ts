import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthRequest } from './auth';
import { getMonthlyUsageCount, getApiTier, getApiKeyTier, getAllApiTiers } from '../db/database';

const router = Router();

// GET /v1/usage/me — Current user's API usage stats
router.get('/me', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const monthKey = new Date().toISOString().slice(0, 7);

    // For now, return tier info and aggregate usage
    // In a more mature system, keys would be linked to users
    res.json({
      success: true,
      data: {
        month: monthKey,
        message: 'Usage tracking is active. API key-level usage available via X-RateLimit headers.',
        tiers: getAllApiTiers().map(t => ({
          name: t.name,
          displayName: t.displayName,
          monthlyLimit: t.monthlyRequestLimit,
          maxAgents: t.maxAgents === -1 ? 'Unlimited' : t.maxAgents,
          maxWebhooks: t.maxWebhooks === -1 ? 'Unlimited' : t.maxWebhooks,
          rateLimitPerMin: t.rateLimitPerMin,
          priceMonthly: `$${t.priceMonthly}`,
        })),
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to retrieve usage data' });
  }
});

// GET /v1/usage/tiers — List all available API tiers (public)
router.get('/tiers', (_req: Request, res: Response) => {
  try {
    const tiers = getAllApiTiers();
    res.json({
      success: true,
      data: tiers.map(t => ({
        name: t.name,
        displayName: t.displayName,
        monthlyRequestLimit: t.monthlyRequestLimit,
        maxAgents: t.maxAgents === -1 ? 'Unlimited' : t.maxAgents,
        maxWebhooks: t.maxWebhooks === -1 ? 'Unlimited' : t.maxWebhooks,
        rateLimitPerMin: t.rateLimitPerMin,
        priceMonthly: t.priceMonthly,
        stripePriceId: t.stripePriceId,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to retrieve tiers' });
  }
});

export default router;
