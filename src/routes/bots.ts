/**
 * BorealisMark — AI Bot Registration & Management Routes
 *
 * Bot registration, management, job assignment, and tier progression.
 *
 *   POST /v1/bots              — Register a new bot (check limits)
 *   GET /v1/bots               — List user's bots
 *   GET /v1/bots/:id           — Get bot details
 *   PUT /v1/bots/:id           — Update bot (only owner)
 *   DELETE /v1/bots/:id        — Deactivate bot (only owner)
 *   GET /v1/bots/leaderboard   — Public leaderboard (top bots by AP)
 *   POST /v1/bots/:id/jobs     — Assign a job to a bot
 *   PUT /v1/bots/:id/jobs/:jobId — Update job status (complete/fail)
 *   POST /v1/bots/:id/rate     — Rate a bot after job completion
 *   GET /v1/bots/:id/jobs      — Get bot's job history
 *   POST /v1/bots/:id/review   — Admin/Senior AI review endpoint
 *   GET /v1/bots/stats         — Global bot stats
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { requireAuth, type AuthRequest } from './auth';
import { logger } from '../middleware/logger';
import { getUserById } from '../db/database';
import {
  createBot,
  getBotById,
  getBotsByOwnerId,
  updateBot,
  countBotsByOwnerId,
  getBotLeaderboard,
  getBotStats,
  createBotJob,
  getBotJobById,
  getBotJobs,
  updateBotJobStatus,
  createBotReview,
  getBotReviews,
} from '../db/database';

const router = Router();

// ─── Config ──────────────────────────────────────────────────────────────────

const BOT_LIMITS = {
  standard: 5,
  pro: 20,
  elite: 100,
};

const TIER_THRESHOLDS: Record<string, number> = {
  bronze: 0,
  silver: 1000,
  gold: 5000,
  platinum: 15000,
  sovereign: 50000,
};

const AP_BY_RATING: Record<number, number> = {
  5: 100,
  4: 75,
  3: 50,
  2: 25,
  1: 10,
};

// ─── Schemas ─────────────────────────────────────────────────────────────────

const createBotSchema = z.object({
  name: z.string().min(1).max(100),
  bio: z.string().max(500).optional(),
  capabilities: z.array(z.string()).optional(),
  specialties: z.array(z.string()).optional(),
  avatar_url: z.string().url().optional(),
});

const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).optional(),
  capabilities: z.array(z.string()).optional(),
  specialties: z.array(z.string()).optional(),
  avatar_url: z.string().url().optional(),
});

const createJobSchema = z.object({
  listing_id: z.string().optional(),
  job_type: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const updateJobSchema = z.object({
  status: z.enum(['assigned', 'in_progress', 'completed', 'failed']),
  rating: z.number().min(1).max(5).optional(),
  rating_comment: z.string().max(1000).optional(),
});

const rateBotSchema = z.object({
  rating: z.number().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

const reviewBotSchema = z.object({
  review_type: z.enum(['re-evaluation', 'periodic', 'manual']),
  decision: z.enum(['approved', 'warning', 'suspended', 'deactivated']),
  notes: z.string().max(2000).optional(),
  jobs_reviewed: z.number().int().nonnegative().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Calculate AP earned from a rating and update bot's AP + tier.
 */
function calculateApFromRating(rating: number): number {
  return AP_BY_RATING[Math.floor(rating)] ?? 10;
}

/**
 * Auto-upgrade bot tier based on AP points.
 */
function autoUpgradeTier(bot: any): string {
  let newTier = bot.tier;

  const apPoints = bot.ap_points;
  if (apPoints >= TIER_THRESHOLDS.sovereign) {
    newTier = 'sovereign';
  } else if (apPoints >= TIER_THRESHOLDS.platinum) {
    newTier = 'platinum';
  } else if (apPoints >= TIER_THRESHOLDS.gold) {
    newTier = 'gold';
  } else if (apPoints >= TIER_THRESHOLDS.silver) {
    newTier = 'silver';
  } else {
    newTier = 'bronze';
  }

  if (newTier !== bot.tier) {
    logger.info('Bot auto-upgraded', { botId: bot.id, fromTier: bot.tier, toTier: newTier, apPoints });
  }

  return newTier;
}

// ─── POST /v1/bots ───────────────────────────────────────────────────────────
// Register a new bot for the authenticated user

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const user = getUserById(userId);

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Validate request body
    const parsed = createBotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { name, bio, capabilities, specialties, avatar_url } = parsed.data;

    // Check bot limit based on user tier
    const limit = BOT_LIMITS[user.tier as keyof typeof BOT_LIMITS] || BOT_LIMITS.standard;
    const currentCount = countBotsByOwnerId(userId);

    if (currentCount >= limit) {
      res.status(402).json({
        success: false,
        error: `Bot limit reached for ${user.tier} tier (${limit} bots)`,
        limit,
        current: currentCount,
      });
      return;
    }

    // Create the bot
    const botId = `bot_${uuid().replace(/-/g, '').slice(0, 20)}`;
    const bot = createBot({
      id: botId,
      owner_id: userId,
      name,
      bio,
      capabilities: capabilities ? JSON.stringify(capabilities) : undefined,
      specialties: specialties ? JSON.stringify(specialties) : undefined,
      avatar_url,
    });

    logger.info('Bot created', {
      botId,
      userId,
      name,
      tier: user.tier,
    });

    res.status(201).json({
      success: true,
      data: {
        id: bot.id,
        ownerId: bot.owner_id,
        name: bot.name,
        bio: bot.bio,
        capabilities: bot.capabilities ? JSON.parse(bot.capabilities) : [],
        specialties: bot.specialties ? JSON.parse(bot.specialties) : [],
        avatarUrl: bot.avatar_url,
        tier: bot.tier,
        apPoints: bot.ap_points,
        bmScore: bot.bm_score,
        starRating: bot.star_rating,
        totalRatings: bot.total_ratings,
        jobsCompleted: bot.jobs_completed,
        jobsFailed: bot.jobs_failed,
        status: bot.status,
        createdAt: bot.created_at,
        updatedAt: bot.updated_at,
      },
    });
  } catch (err: any) {
    logger.error('Create bot error', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: 'Failed to create bot' });
  }
});

// ─── GET /v1/bots ────────────────────────────────────────────────────────────
// List the authenticated user's bots

router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;

    const bots = getBotsByOwnerId(userId);

    const data = bots.map(bot => ({
      id: bot.id,
      ownerId: bot.owner_id,
      name: bot.name,
      bio: bot.bio,
      capabilities: bot.capabilities ? JSON.parse(bot.capabilities) : [],
      specialties: bot.specialties ? JSON.parse(bot.specialties) : [],
      avatarUrl: bot.avatar_url,
      tier: bot.tier,
      apPoints: bot.ap_points,
      bmScore: bot.bm_score,
      starRating: bot.star_rating,
      totalRatings: bot.total_ratings,
      jobsCompleted: bot.jobs_completed,
      jobsFailed: bot.jobs_failed,
      status: bot.status,
      createdAt: bot.created_at,
      updatedAt: bot.updated_at,
    }));

    res.json({ success: true, data });
  } catch (err: any) {
    logger.error('List bots error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list bots' });
  }
});

// ─── GET /v1/bots/:id ────────────────────────────────────────────────────────
// Get bot details

router.get('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const bot = getBotById(id);

    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    res.json({
      success: true,
      data: {
        id: bot.id,
        ownerId: bot.owner_id,
        name: bot.name,
        bio: bot.bio,
        capabilities: bot.capabilities ? JSON.parse(bot.capabilities) : [],
        specialties: bot.specialties ? JSON.parse(bot.specialties) : [],
        avatarUrl: bot.avatar_url,
        tier: bot.tier,
        apPoints: bot.ap_points,
        bmScore: bot.bm_score,
        starRating: bot.star_rating,
        totalRatings: bot.total_ratings,
        jobsCompleted: bot.jobs_completed,
        jobsFailed: bot.jobs_failed,
        status: bot.status,
        createdAt: bot.created_at,
        updatedAt: bot.updated_at,
      },
    });
  } catch (err: any) {
    logger.error('Get bot error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get bot' });
  }
});

// ─── PUT /v1/bots/:id ────────────────────────────────────────────────────────
// Update bot (only owner)

router.put('/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const { id } = req.params;

    const bot = getBotById(id);
    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    if (bot.owner_id !== userId) {
      res.status(403).json({ success: false, error: 'Only the bot owner can update it' });
      return;
    }

    const parsed = updateBotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { name, bio, capabilities, specialties, avatar_url } = parsed.data;

    updateBot(id, {
      name: name ?? bot.name,
      bio: bio ?? bot.bio,
      capabilities: capabilities ? JSON.stringify(capabilities) : bot.capabilities,
      specialties: specialties ? JSON.stringify(specialties) : bot.specialties,
      avatar_url: avatar_url ?? bot.avatar_url,
      updated_at: Date.now(),
    } as any);

    const updated = getBotById(id)!;

    logger.info('Bot updated', { botId: id, userId });

    res.json({
      success: true,
      data: {
        id: updated.id,
        ownerId: updated.owner_id,
        name: updated.name,
        bio: updated.bio,
        capabilities: updated.capabilities ? JSON.parse(updated.capabilities) : [],
        specialties: updated.specialties ? JSON.parse(updated.specialties) : [],
        avatarUrl: updated.avatar_url,
        tier: updated.tier,
        apPoints: updated.ap_points,
        bmScore: updated.bm_score,
        starRating: updated.star_rating,
        totalRatings: updated.total_ratings,
        jobsCompleted: updated.jobs_completed,
        jobsFailed: updated.jobs_failed,
        status: updated.status,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err: any) {
    logger.error('Update bot error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update bot' });
  }
});

// ─── DELETE /v1/bots/:id ─────────────────────────────────────────────────────
// Deactivate bot (soft delete)

router.delete('/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const { id } = req.params;

    const bot = getBotById(id);
    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    if (bot.owner_id !== userId) {
      res.status(403).json({ success: false, error: 'Only the bot owner can deactivate it' });
      return;
    }

    updateBot(id, { status: 'deactivated', updated_at: Date.now() } as any);

    logger.info('Bot deactivated', { botId: id, userId });

    res.json({
      success: true,
      data: { message: 'Bot deactivated successfully' },
    });
  } catch (err: any) {
    logger.error('Delete bot error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to deactivate bot' });
  }
});

// ─── GET /v1/bots/leaderboard ────────────────────────────────────────────────
// Public leaderboard (top bots by AP)

router.get('/leaderboard', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const bots = getBotLeaderboard(limit);

    const data = bots.map(bot => ({
      id: bot.id,
      ownerId: bot.owner_id,
      name: bot.name,
      tier: bot.tier,
      apPoints: bot.ap_points,
      starRating: bot.star_rating,
      totalRatings: bot.total_ratings,
      jobsCompleted: bot.jobs_completed,
    }));

    res.json({ success: true, data });
  } catch (err: any) {
    logger.error('Get leaderboard error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get leaderboard' });
  }
});

// ─── POST /v1/bots/:id/jobs ──────────────────────────────────────────────────
// Assign a job to a bot (admin/system only in production)

router.post('/:id/jobs', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const { id } = req.params;
    const user = getUserById(userId);

    // Check if user is admin or bot owner
    const bot = getBotById(id);
    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    if (bot.owner_id !== userId && user?.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Only bot owner or admin can assign jobs' });
      return;
    }

    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { listing_id, job_type, title, description } = parsed.data;
    const jobId = `job_${uuid().replace(/-/g, '').slice(0, 20)}`;

    createBotJob({
      id: jobId,
      bot_id: id,
      listing_id,
      job_type,
      title,
      description,
    });

    logger.info('Job assigned to bot', { jobId, botId: id, jobType: job_type });

    res.status(201).json({
      success: true,
      data: {
        id: jobId,
        botId: id,
        listingId: listing_id,
        jobType: job_type,
        title,
        description,
        status: 'assigned',
        rating: null,
        apEarned: 0,
        createdAt: Date.now(),
      },
    });
  } catch (err: any) {
    logger.error('Create job error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to assign job' });
  }
});

// ─── PUT /v1/bots/:id/jobs/:jobId ────────────────────────────────────────────
// Update job status and rating

router.put('/:id/jobs/:jobId', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const { id, jobId } = req.params;

    const bot = getBotById(id);
    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    if (bot.owner_id !== userId) {
      res.status(403).json({ success: false, error: 'Only the bot owner can update its jobs' });
      return;
    }

    const job = getBotJobById(jobId);
    if (!job || job.bot_id !== id) {
      res.status(404).json({ success: false, error: 'Job not found' });
      return;
    }

    const parsed = updateJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { status, rating, rating_comment } = parsed.data;

    let apEarned = 0;
    let newStatus = bot.status;

    if (status === 'completed' && rating) {
      apEarned = calculateApFromRating(rating);

      // Update bot stats
      updateBot(id, {
        ap_points: bot.ap_points + apEarned,
        jobs_completed: bot.jobs_completed + 1,
        star_rating:
          (bot.star_rating * bot.total_ratings + rating) / (bot.total_ratings + 1),
        total_ratings: bot.total_ratings + 1,
        updated_at: Date.now(),
      } as any);

      // Check for auto-upgrade or under_review status
      const updated = getBotById(id)!;
      const newTier = autoUpgradeTier(updated);
      if (newTier !== updated.tier) {
        updateBot(id, { tier: newTier as any } as any);
      }

      // Check if rating dropped below 2.5
      const newBot = getBotById(id)!;
      if (newBot.star_rating < 2.5) {
        newStatus = 'under_review';
        updateBot(id, { status: 'under_review' as any } as any);
      }
    } else if (status === 'failed') {
      updateBot(id, {
        jobs_failed: bot.jobs_failed + 1,
        updated_at: Date.now(),
      } as any);
    }

    updateBotJobStatus(jobId, status, rating, rating_comment, apEarned);

    logger.info('Job updated', {
      jobId,
      botId: id,
      status,
      apEarned,
      rating,
    });

    res.json({
      success: true,
      data: {
        id: jobId,
        botId: id,
        status,
        rating: rating || null,
        ratingComment: rating_comment,
        apEarned,
        updatedBot: {
          apPoints: getBotById(id)!.ap_points,
          starRating: getBotById(id)!.star_rating,
          tier: getBotById(id)!.tier,
          status: newStatus,
        },
      },
    });
  } catch (err: any) {
    logger.error('Update job error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update job' });
  }
});

// ─── POST /v1/bots/:id/rate ──────────────────────────────────────────────────
// Rate a bot after job completion (triggers re-evaluation if < 2.5)

router.post('/:id/rate', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const { id } = req.params;

    const bot = getBotById(id);
    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    const parsed = rateBotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { rating, comment } = parsed.data;

    // Calculate new average rating
    const newAvgRating =
      (bot.star_rating * bot.total_ratings + rating) / (bot.total_ratings + 1);

    // Update bot
    updateBot(id, {
      star_rating: newAvgRating,
      total_ratings: bot.total_ratings + 1,
      updated_at: Date.now(),
    } as any);

    const updated = getBotById(id)!;

    // Check if needs under_review
    let underReview = false;
    if (newAvgRating < 2.5) {
      updateBot(id, { status: 'under_review' as any } as any);
      underReview = true;

      // Create automatic review
      createBotReview({
        id: `review_${uuid().replace(/-/g, '').slice(0, 20)}`,
        bot_id: id,
        reviewer_id: userId,
        review_type: 're-evaluation',
        decision: 'approved',
        notes: `Auto re-evaluation triggered: star rating dropped below 2.5 (current: ${newAvgRating.toFixed(
          2,
        )})`,
      });

      logger.warn('Bot flagged for re-evaluation', {
        botId: id,
        starRating: newAvgRating,
      });
    }

    logger.info('Bot rated', {
      botId: id,
      rating,
      newAvgRating: newAvgRating.toFixed(2),
      underReview,
    });

    res.json({
      success: true,
      data: {
        id: bot.id,
        starRating: updated.star_rating,
        totalRatings: updated.total_ratings,
        status: updated.status,
        underReview,
      },
    });
  } catch (err: any) {
    logger.error('Rate bot error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to rate bot' });
  }
});

// ─── GET /v1/bots/:id/jobs ───────────────────────────────────────────────────
// Get bot's job history

router.get('/:id/jobs', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const { id } = req.params;

    const bot = getBotById(id);
    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    // Only owner or admin can view full job history
    const user = getUserById(userId);
    if (bot.owner_id !== userId && user?.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Not authorized' });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const jobs = getBotJobs(id, limit);

    const data = jobs.map(job => ({
      id: job.id,
      botId: job.bot_id,
      listingId: job.listing_id,
      jobType: job.job_type,
      title: job.title,
      description: job.description,
      status: job.status,
      rating: job.rating,
      ratingComment: job.rating_comment,
      apEarned: job.ap_earned,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      createdAt: job.created_at,
    }));

    res.json({ success: true, data });
  } catch (err: any) {
    logger.error('Get bot jobs error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get bot jobs' });
  }
});

// ─── POST /v1/bots/:id/review ────────────────────────────────────────────────
// Admin/Senior AI review endpoint

router.post('/:id/review', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const user = getUserById(userId);

    // Only admin can perform reviews
    if (!user || user.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Only admins can perform reviews' });
      return;
    }

    const { id } = req.params;
    const bot = getBotById(id);

    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    const parsed = reviewBotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const {
      review_type,
      decision,
      notes,
      jobs_reviewed,
    } = parsed.data;

    const reviewId = `review_${uuid().replace(/-/g, '').slice(0, 20)}`;

    createBotReview({
      id: reviewId,
      bot_id: id,
      reviewer_id: userId,
      review_type,
      decision,
      notes,
      jobs_reviewed,
    });

    // Update bot status based on decision
    if (decision === 'suspended') {
      updateBot(id, {
        status: 'suspended' as any,
        reviewed_by: userId,
        review_reason: notes,
        updated_at: Date.now(),
      } as any);
    } else if (decision === 'deactivated') {
      updateBot(id, {
        status: 'deactivated' as any,
        reviewed_by: userId,
        review_reason: notes,
        updated_at: Date.now(),
      } as any);
    } else if (decision === 'approved' && bot.status === 'under_review') {
      updateBot(id, {
        status: 'active' as any,
        reviewed_by: userId,
        updated_at: Date.now(),
      } as any);
    }

    logger.info('Bot review completed', {
      botId: id,
      reviewerId: userId,
      decision,
      reviewType: review_type,
    });

    res.json({
      success: true,
      data: {
        reviewId,
        botId: id,
        decision,
        botStatus: getBotById(id)!.status,
      },
    });
  } catch (err: any) {
    logger.error('Review bot error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to review bot' });
  }
});

// ─── GET /v1/bots/stats ──────────────────────────────────────────────────────
// Global bot stats

router.get('/stats', (req: Request, res: Response) => {
  try {
    const stats = getBotStats();

    res.json({
      success: true,
      data: {
        totalBots: stats.totalBots,
        byTier: stats.byTier,
        avgStarRating: stats.avgStarRating.toFixed(2),
        avgApPoints: stats.avgApPoints.toFixed(0),
      },
    });
  } catch (err: any) {
    logger.error('Get stats error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

export default router;
