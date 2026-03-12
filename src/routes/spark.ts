/**
 * BorealisMark — The Spark Routes
 *
 * Trust Token economy, Trust Guide selection, lesson flow, shop, and avatar system.
 * The Spark is the next-gen learning layer of Borealis Academy.
 *
 *   GET  /v1/spark/guides              — All active Trust Guides
 *   GET  /v1/spark/guides/:slug        — Single guide details
 *   POST /v1/spark/guides/select       — Select a guide (auth required)
 *   GET  /v1/spark/lessons/:guideSlug  — Lessons for a guide
 *   GET  /v1/spark/lesson/:slug        — Full lesson content
 *   POST /v1/spark/lesson/:id/start    — Start a lesson
 *   POST /v1/spark/lesson/:id/progress — Update lesson progress (stage completion)
 *   POST /v1/spark/lesson/:id/complete — Complete a lesson & earn TT
 *   GET  /v1/spark/me                  — Spark stats (TT balance, progress, guide)
 *   GET  /v1/spark/me/progress         — All lesson progress
 *   GET  /v1/spark/shop                — Shop items
 *   POST /v1/spark/shop/purchase       — Purchase item with TT
 *   GET  /v1/spark/me/purchases        — User's purchased items
 *   GET  /v1/spark/me/avatar           — User's avatar config
 *   POST /v1/spark/me/avatar/equip     — Equip an item
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthRequest, type JwtPayload } from './auth';
import {
  getSparkGuides,
  getSparkGuideBySlug,
  selectSparkGuide,
  getSelectedGuide,
  getSparkLessons,
  getSparkLessonBySlug,
  getSparkLessonById,
  startSparkLesson,
  updateSparkProgress,
  completeSparkLesson,
  getSparkProgress,
  getSparkStats,
  getSparkShopItems,
  purchaseSparkItem,
  getUserPurchases,
  getSparkAvatar,
  equipSparkItem,
  getTrustTokenBalance,
  ensureUserProgression,
} from '../db/database';
import { logger } from '../middleware/logger';

const router = Router();

// ─── GET /guides — All Trust Guides ──────────────────────────────────────────

router.get('/guides', (_req: Request, res: Response) => {
  try {
    const guides = getSparkGuides();
    res.json({ guides });
  } catch (err: any) {
    logger.error('Failed to fetch guides', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch guides' });
  }
});

// ─── GET /guides/:slug — Single Guide ───────────────────────────────────────

router.get('/guides/:slug', (req: Request, res: Response) => {
  try {
    const guide = getSparkGuideBySlug(req.params.slug);
    if (!guide) return res.status(404).json({ error: 'Guide not found' });
    res.json({ guide });
  } catch (err: any) {
    logger.error('Failed to fetch guide', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch guide' });
  }
});

// ─── POST /guides/select — Choose a Trust Guide ────────────────────────────

router.post('/guides/select', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { guideSlug } = req.body;

    if (!guideSlug || !['nova', 'ember', 'luma'].includes(guideSlug)) {
      return res.status(400).json({ error: 'Invalid guide. Choose: nova, ember, or luma' });
    }

    ensureUserProgression(userId);
    selectSparkGuide(userId, guideSlug);
    const guide = getSparkGuideBySlug(guideSlug);

    res.json({ selected: guideSlug, guide });
  } catch (err: any) {
    logger.error('Failed to select guide', { error: err.message });
    res.status(500).json({ error: 'Failed to select guide' });
  }
});

// ─── GET /lessons/:guideSlug — Lessons for a Guide ─────────────────────────

router.get('/lessons/:guideSlug', (req: Request, res: Response) => {
  try {
    const guide = getSparkGuideBySlug(req.params.guideSlug);
    if (!guide) return res.status(404).json({ error: 'Guide not found' });

    const difficulty = req.query.difficulty as string | undefined;
    const lessons = getSparkLessons(guide.id, difficulty);

    res.json({ guide: guide.slug, lessons });
  } catch (err: any) {
    logger.error('Failed to fetch lessons', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch lessons' });
  }
});

// ─── GET /lesson/:slug — Full Lesson Content ───────────────────────────────

router.get('/lesson/:slug', (req: Request, res: Response) => {
  try {
    const lesson = getSparkLessonBySlug(req.params.slug);
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

    // Parse JSON content fields
    const parsed = {
      ...lesson,
      adventure_content: JSON.parse(lesson.adventure_content || '{}'),
      adventure_interactive: JSON.parse(lesson.adventure_interactive || '{}'),
      reflection_choices: JSON.parse(lesson.reflection_choices || '[]'),
    };

    res.json({ lesson: parsed });
  } catch (err: any) {
    logger.error('Failed to fetch lesson', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch lesson' });
  }
});

// ─── POST /lesson/:id/start — Start a Lesson ──────────────────────────────

router.post('/lesson/:id/start', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const lesson = getSparkLessonById(req.params.id);
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

    ensureUserProgression(userId);
    const progress = startSparkLesson(userId, lesson.id);
    res.json({ progress });
  } catch (err: any) {
    logger.error('Failed to start lesson', { error: err.message });
    res.status(500).json({ error: 'Failed to start lesson' });
  }
});

// ─── POST /lesson/:id/progress — Update Stage Progress ────────────────────

router.post('/lesson/:id/progress', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { stage, reflectionAnswer } = req.body;

    if (!stage || !['hook', 'adventure', 'reflection'].includes(stage)) {
      return res.status(400).json({ error: 'Invalid stage. Use: hook, adventure, or reflection' });
    }

    const progress = updateSparkProgress(userId, req.params.id, stage, reflectionAnswer);
    if (!progress) return res.status(404).json({ error: 'No progress record found. Start the lesson first.' });

    res.json({ progress });
  } catch (err: any) {
    logger.error('Failed to update progress', { error: err.message });
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

// ─── POST /lesson/:id/complete — Complete Lesson & Earn TT ────────────────

router.post('/lesson/:id/complete', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { timeSpentSeconds = 0 } = req.body;

    const result = completeSparkLesson(userId, req.params.id, timeSpentSeconds);
    res.json(result);
  } catch (err: any) {
    logger.error('Failed to complete lesson', { error: err.message });
    res.status(500).json({ error: err.message || 'Failed to complete lesson' });
  }
});

// ─── GET /me — Spark Stats ─────────────────────────────────────────────────

router.get('/me', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    ensureUserProgression(userId);
    const stats = getSparkStats(userId);
    res.json(stats);
  } catch (err: any) {
    logger.error('Failed to fetch spark stats', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch spark stats' });
  }
});

// ─── GET /me/progress — All Lesson Progress ────────────────────────────────

router.get('/me/progress', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const guideSlug = req.query.guide as string | undefined;
    let guideId: string | undefined;

    if (guideSlug) {
      const guide = getSparkGuideBySlug(guideSlug);
      if (guide) guideId = guide.id;
    }

    const progress = getSparkProgress(userId, guideId);
    res.json({ progress });
  } catch (err: any) {
    logger.error('Failed to fetch progress', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// ─── GET /shop — Shop Items ────────────────────────────────────────────────

router.get('/shop', (_req: Request, res: Response) => {
  try {
    const category = _req.query.category as string | undefined;
    const items = getSparkShopItems(category);
    res.json({ items });
  } catch (err: any) {
    logger.error('Failed to fetch shop items', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch shop items' });
  }
});

// ─── POST /shop/purchase — Buy with Trust Tokens ──────────────────────────

router.post('/shop/purchase', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { itemId } = req.body;

    if (!itemId) return res.status(400).json({ error: 'itemId required' });

    const result = purchaseSparkItem(userId, itemId);
    if (!result.success) return res.status(400).json({ error: result.error });

    res.json({ success: true, newBalance: result.newBalance });
  } catch (err: any) {
    logger.error('Failed to purchase item', { error: err.message });
    res.status(500).json({ error: 'Failed to purchase item' });
  }
});

// ─── GET /me/purchases — User's Purchased Items ───────────────────────────

router.get('/me/purchases', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const purchases = getUserPurchases(userId);
    res.json({ purchases });
  } catch (err: any) {
    logger.error('Failed to fetch purchases', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch purchases' });
  }
});

// ─── GET /me/avatar — Avatar Configuration ─────────────────────────────────

router.get('/me/avatar', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const avatar = getSparkAvatar(userId);
    res.json({ avatar });
  } catch (err: any) {
    logger.error('Failed to fetch avatar', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

// ─── POST /me/avatar/equip — Equip Item ───────────────────────────────────

router.post('/me/avatar/equip', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user as JwtPayload;
    const { itemId, slot } = req.body;

    if (!itemId || !slot) return res.status(400).json({ error: 'itemId and slot required' });
    if (!['hat', 'outfit', 'accessory', 'background', 'title'].includes(slot)) {
      return res.status(400).json({ error: 'Invalid slot. Use: hat, outfit, accessory, background, title' });
    }

    const success = equipSparkItem(userId, itemId, slot);
    if (!success) return res.status(400).json({ error: 'Item not owned or invalid' });

    const avatar = getSparkAvatar(userId);
    res.json({ success: true, avatar });
  } catch (err: any) {
    logger.error('Failed to equip item', { error: err.message });
    res.status(500).json({ error: 'Failed to equip item' });
  }
});

export default router;
