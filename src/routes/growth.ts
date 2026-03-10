/**
 * BorealisMark — v40 Signal Tower: Growth Analytics
 *
 * Platform growth metrics, funnel analysis, and engagement tracking.
 * Admin-only endpoints for monitoring platform health and growth KPIs.
 *
 *   GET /v1/growth/overview     — High-level growth KPIs
 *   GET /v1/growth/funnel       — Registration → verification → transaction funnel
 *   GET /v1/growth/retention    — User retention cohort data
 *   GET /v1/growth/revenue      — Revenue metrics and trends
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth';
import { logger } from '../middleware/logger';
import { getDb } from '../db/database';

const router = Router();

// Admin check middleware
function requireAdmin(req: Request, res: Response, next: Function): void {
  const user = getDb().prepare('SELECT role FROM users WHERE id = ?').get((req as any).userId) as any;
  if (!user || user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }
  next();
}

// ─── GET /v1/growth/overview — Growth KPIs ──────────────────────────────────

router.get('/overview', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week = 7 * day;
    const month = 30 * day;

    // User growth
    const totalUsers = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any)?.c ?? 0;
    const usersLast7d = (db.prepare('SELECT COUNT(*) as c FROM users WHERE created_at > ?').get(now - week) as any)?.c ?? 0;
    const usersLast30d = (db.prepare('SELECT COUNT(*) as c FROM users WHERE created_at > ?').get(now - month) as any)?.c ?? 0;
    const usersLast24h = (db.prepare('SELECT COUNT(*) as c FROM users WHERE created_at > ?').get(now - day) as any)?.c ?? 0;

    // Active users (logged in recently)
    const activeLast7d = (db.prepare('SELECT COUNT(*) as c FROM users WHERE last_login_at > ?').get(now - week) as any)?.c ?? 0;
    const activeLast30d = (db.prepare('SELECT COUNT(*) as c FROM users WHERE last_login_at > ?').get(now - month) as any)?.c ?? 0;

    // Verification metrics
    const verifiedEmail = (db.prepare('SELECT COUNT(*) as c FROM users WHERE email_verified = 1').get() as any)?.c ?? 0;
    const verifiedSocial = (db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM user_verifications WHERE type = 'social_media' AND status = 'approved'").get() as any)?.c ?? 0;
    const verifiedGovId = (db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM user_verifications WHERE type = 'government_id' AND status = 'approved'").get() as any)?.c ?? 0;

    // Marketplace metrics
    const totalListings = (db.prepare("SELECT COUNT(*) as c FROM marketplace_listings WHERE status = 'published'").get() as any)?.c ?? 0;
    const totalOrders = (db.prepare('SELECT COUNT(*) as c FROM marketplace_orders').get() as any)?.c ?? 0;
    const completedOrders = (db.prepare("SELECT COUNT(*) as c FROM marketplace_orders WHERE status = 'settled'").get() as any)?.c ?? 0;
    const ordersLast7d = (db.prepare('SELECT COUNT(*) as c FROM marketplace_orders WHERE created_at > ?').get(now - week) as any)?.c ?? 0;

    // Revenue (from settled orders)
    const totalRevenue = (db.prepare("SELECT COALESCE(SUM(total_usdc), 0) as v FROM marketplace_orders WHERE status = 'settled'").get() as any)?.v ?? 0;
    const revenueLast30d = (db.prepare("SELECT COALESCE(SUM(total_usdc), 0) as v FROM marketplace_orders WHERE status = 'settled' AND created_at > ?").get(now - month) as any)?.v ?? 0;

    // Subscription breakdown
    const tierBreakdown = db.prepare("SELECT tier, COUNT(*) as count FROM users GROUP BY tier ORDER BY count DESC").all();

    // Trust score distribution
    const trustDistribution = db.prepare("SELECT trust_level, COUNT(*) as count FROM user_trust_scores GROUP BY trust_level ORDER BY count DESC").all();

    res.json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          last24h: usersLast24h,
          last7d: usersLast7d,
          last30d: usersLast30d,
          activeLast7d,
          activeLast30d,
          growthRate7d: totalUsers > usersLast7d ? ((usersLast7d / (totalUsers - usersLast7d)) * 100).toFixed(1) : '0.0',
        },
        verification: {
          emailVerified: verifiedEmail,
          emailRate: totalUsers > 0 ? ((verifiedEmail / totalUsers) * 100).toFixed(1) : '0.0',
          socialVerified: verifiedSocial,
          govIdVerified: verifiedGovId,
        },
        marketplace: {
          activeListings: totalListings,
          totalOrders,
          completedOrders,
          ordersLast7d,
          completionRate: totalOrders > 0 ? ((completedOrders / totalOrders) * 100).toFixed(1) : '0.0',
        },
        revenue: {
          totalUsdc: Math.round(totalRevenue * 100) / 100,
          last30dUsdc: Math.round(revenueLast30d * 100) / 100,
        },
        tiers: tierBreakdown,
        trustLevels: trustDistribution,
        generatedAt: now,
      },
    });
  } catch (err: any) {
    logger.error('Growth overview error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get growth data' });
  }
});

// ─── GET /v1/growth/funnel — Conversion funnel ─────────────────────────────

router.get('/funnel', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();

    const totalRegistered = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any)?.c ?? 0;
    const emailVerified = (db.prepare('SELECT COUNT(*) as c FROM users WHERE email_verified = 1').get() as any)?.c ?? 0;
    const socialVerified = (db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM user_verifications WHERE type = 'social_media' AND status = 'approved'").get() as any)?.c ?? 0;
    const govIdVerified = (db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM user_verifications WHERE type = 'government_id' AND status = 'approved'").get() as any)?.c ?? 0;
    const madeFirstListing = (db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM marketplace_listings').get() as any)?.c ?? 0;
    const madeFirstOrder = (db.prepare('SELECT COUNT(DISTINCT buyer_id) as c FROM marketplace_orders').get() as any)?.c ?? 0;
    const completedFirstOrder = (db.prepare("SELECT COUNT(DISTINCT buyer_id) as c FROM marketplace_orders WHERE status = 'settled'").get() as any)?.c ?? 0;
    const paidSubscribers = (db.prepare("SELECT COUNT(*) as c FROM users WHERE tier != 'standard'").get() as any)?.c ?? 0;

    const funnel = [
      { stage: 'Registered', count: totalRegistered, rate: '100.0' },
      { stage: 'Email Verified', count: emailVerified, rate: totalRegistered > 0 ? ((emailVerified / totalRegistered) * 100).toFixed(1) : '0.0' },
      { stage: 'Social Verified', count: socialVerified, rate: totalRegistered > 0 ? ((socialVerified / totalRegistered) * 100).toFixed(1) : '0.0' },
      { stage: 'Gov ID Verified', count: govIdVerified, rate: totalRegistered > 0 ? ((govIdVerified / totalRegistered) * 100).toFixed(1) : '0.0' },
      { stage: 'Listed Item', count: madeFirstListing, rate: totalRegistered > 0 ? ((madeFirstListing / totalRegistered) * 100).toFixed(1) : '0.0' },
      { stage: 'First Purchase', count: madeFirstOrder, rate: totalRegistered > 0 ? ((madeFirstOrder / totalRegistered) * 100).toFixed(1) : '0.0' },
      { stage: 'Completed Transaction', count: completedFirstOrder, rate: totalRegistered > 0 ? ((completedFirstOrder / totalRegistered) * 100).toFixed(1) : '0.0' },
      { stage: 'Paid Subscriber', count: paidSubscribers, rate: totalRegistered > 0 ? ((paidSubscribers / totalRegistered) * 100).toFixed(1) : '0.0' },
    ];

    res.json({ success: true, data: { funnel } });
  } catch (err: any) {
    logger.error('Growth funnel error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get funnel data' });
  }
});

// ─── GET /v1/growth/retention — Cohort retention ────────────────────────────

router.get('/retention', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const weeks = Math.min(12, Math.max(1, Number(req.query.weeks) || 8));
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    const cohorts: Array<{
      cohortWeek: string;
      registered: number;
      retained: number[];
    }> = [];

    for (let i = weeks; i >= 1; i--) {
      const cohortStart = now - i * weekMs;
      const cohortEnd = cohortStart + weekMs;
      const weekLabel = new Date(cohortStart).toISOString().split('T')[0];

      // Users registered in this cohort week
      const registered = (db.prepare(
        'SELECT COUNT(*) as c FROM users WHERE created_at >= ? AND created_at < ?'
      ).get(cohortStart, cohortEnd) as any)?.c ?? 0;

      // For each subsequent week, check how many logged in
      const retained: number[] = [];
      for (let w = 1; w <= Math.min(i, 4); w++) {
        const checkStart = cohortEnd + (w - 1) * weekMs;
        const checkEnd = checkStart + weekMs;
        const active = (db.prepare(
          'SELECT COUNT(*) as c FROM users WHERE created_at >= ? AND created_at < ? AND last_login_at >= ? AND last_login_at < ?'
        ).get(cohortStart, cohortEnd, checkStart, checkEnd) as any)?.c ?? 0;
        retained.push(registered > 0 ? Math.round((active / registered) * 100) : 0);
      }

      cohorts.push({ cohortWeek: weekLabel, registered, retained });
    }

    res.json({ success: true, data: { cohorts, weeksTracked: weeks } });
  } catch (err: any) {
    logger.error('Growth retention error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get retention data' });
  }
});

// ─── GET /v1/growth/revenue — Revenue trends ───────────────────────────────

router.get('/revenue', requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const dailyRevenue: Array<{ date: string; orders: number; volumeUsdc: number; fees: number }> = [];

    for (let d = days; d >= 0; d--) {
      const dayStart = Math.floor((now - d * dayMs) / dayMs) * dayMs;
      const dayEnd = dayStart + dayMs;
      const dateLabel = new Date(dayStart).toISOString().split('T')[0];

      const stats = db.prepare(
        "SELECT COUNT(*) as orders, COALESCE(SUM(total_usdc), 0) as volume FROM marketplace_orders WHERE status = 'settled' AND created_at >= ? AND created_at < ?"
      ).get(dayStart, dayEnd) as any;

      dailyRevenue.push({
        date: dateLabel,
        orders: stats?.orders ?? 0,
        volumeUsdc: Math.round((stats?.volume ?? 0) * 100) / 100,
        fees: Math.round((stats?.volume ?? 0) * 0.05 * 100) / 100, // 5% platform fee
      });
    }

    // Totals
    const totalVol = dailyRevenue.reduce((s, d) => s + d.volumeUsdc, 0);
    const totalOrders = dailyRevenue.reduce((s, d) => s + d.orders, 0);
    const totalFees = dailyRevenue.reduce((s, d) => s + d.fees, 0);

    res.json({
      success: true,
      data: {
        daily: dailyRevenue,
        totals: {
          orders: totalOrders,
          volumeUsdc: Math.round(totalVol * 100) / 100,
          feesUsdc: Math.round(totalFees * 100) / 100,
          avgOrderUsdc: totalOrders > 0 ? Math.round((totalVol / totalOrders) * 100) / 100 : 0,
        },
        period: `${days} days`,
      },
    });
  } catch (err: any) {
    logger.error('Growth revenue error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get revenue data' });
  }
});

export default router;
