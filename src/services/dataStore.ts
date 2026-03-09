/**
 * BorealisMark — DataStore Service
 *
 * Aggregation and metrics layer. Computes periodic rollups from raw events,
 * provides time-series data for dashboards, and manages the hot/warm data lifecycle.
 *
 * Runs scheduled aggregation tasks:
 *   - Hourly: compact hourly event counts, compute moving averages
 *   - Daily:  roll up daily summaries, platform health metrics
 *   - Weekly: compute weekly trends, growth rates
 */

import { logger } from '../middleware/logger';
import {
  getDb,
  upsertAggregate,
  getAggregates,
  getEventStats,
} from '../db/database';

// ─── Time Constants ─────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// ─── Metric Definitions ─────────────────────────────────────────────────────

export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
  label?: string;
}

export interface MetricSummary {
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  trend: 'up' | 'down' | 'flat';
}

// ─── Aggregation Functions ──────────────────────────────────────────────────

/**
 * Compute platform health snapshot — called hourly.
 */
export function computeHourlyAggregates(): void {
  try {
    const db = getDb();
    const now = Date.now();
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;

    // Active users (logged in within the hour)
    const activeUsers = (db.prepare(
      'SELECT COUNT(DISTINCT id) as cnt FROM users WHERE last_login_at > ?'
    ).get(hourStart) as any).cnt;
    upsertAggregate('users.active_hourly', 'hourly', hourStart, activeUsers);

    // Support tickets opened this hour
    const supportTickets = (db.prepare(
      'SELECT COUNT(*) as cnt FROM support_threads WHERE created_at > ?'
    ).get(hourStart) as any).cnt;
    upsertAggregate('support.new_hourly', 'hourly', hourStart, supportTickets);

    // Bot jobs completed this hour
    const jobsCompleted = (db.prepare(
      "SELECT COUNT(*) as cnt FROM bot_jobs WHERE status = 'completed' AND completed_at > ?"
    ).get(hourStart) as any).cnt;
    upsertAggregate('bots.jobs_hourly', 'hourly', hourStart, jobsCompleted);

    logger.info('Hourly aggregates computed', { hourStart: new Date(hourStart).toISOString(), activeUsers, supportTickets, jobsCompleted });
  } catch (err: any) {
    logger.error('Hourly aggregation error', { error: err.message });
  }
}

/**
 * Compute daily summary metrics — called daily.
 */
export function computeDailyAggregates(): void {
  try {
    const db = getDb();
    const now = Date.now();
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;

    // New users today
    const newUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users WHERE created_at > ?').get(dayStart) as any).cnt;
    upsertAggregate('users.new_daily', 'daily', dayStart, newUsers);

    // Total registered users
    const totalUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as any).cnt;
    upsertAggregate('users.total', 'daily', dayStart, totalUsers);

    // Revenue (settled orders today)
    const revenue = (db.prepare(
      "SELECT COALESCE(SUM(total_usdc), 0) as total FROM marketplace_orders WHERE status = 'settled' AND created_at > ?"
    ).get(dayStart) as any).total;
    upsertAggregate('revenue.daily', 'daily', dayStart, revenue);

    // New listings today
    const newListings = (db.prepare('SELECT COUNT(*) as cnt FROM marketplace_listings WHERE created_at > ?').get(dayStart) as any).cnt;
    upsertAggregate('listings.new_daily', 'daily', dayStart, newListings);

    // New bots today
    const newBots = (db.prepare('SELECT COUNT(*) as cnt FROM bots WHERE created_at > ?').get(dayStart) as any).cnt;
    upsertAggregate('bots.new_daily', 'daily', dayStart, newBots);

    // Certificates issued today
    const newCerts = (db.prepare('SELECT COUNT(*) as cnt FROM audit_certificates WHERE issued_at > ?').get(dayStart) as any).cnt;
    upsertAggregate('certs.issued_daily', 'daily', dayStart, newCerts);

    // Support threads resolved today
    const resolved = (db.prepare("SELECT COUNT(*) as cnt FROM support_threads WHERE resolved_at > ?").get(dayStart) as any).cnt;
    upsertAggregate('support.resolved_daily', 'daily', dayStart, resolved);

    // Tier distribution snapshot
    const tiers = db.prepare("SELECT tier, COUNT(*) as cnt FROM users GROUP BY tier").all() as any[];
    for (const t of tiers) {
      upsertAggregate(`users.tier.${t.tier}`, 'daily', dayStart, t.cnt);
    }

    logger.info('Daily aggregates computed', {
      dayStart: new Date(dayStart).toISOString(),
      newUsers, totalUsers, revenue, newListings, newBots, newCerts, resolved,
    });
  } catch (err: any) {
    logger.error('Daily aggregation error', { error: err.message });
  }
}

// ─── Query Functions ────────────────────────────────────────────────────────

/**
 * Get time-series data for a metric over a date range.
 */
export function getTimeSeries(
  metricKey: string,
  period: 'hourly' | 'daily' | 'weekly',
  days: number = 30,
): TimeSeriesPoint[] {
  const since = Date.now() - days * DAY_MS;
  const aggregates = getAggregates(metricKey, period, since);

  return aggregates.map((a: any) => ({
    timestamp: a.period_start,
    value: a.value,
    label: new Date(a.period_start).toISOString().split('T')[0],
  }));
}

/**
 * Get a metric summary with change comparison.
 */
export function getMetricSummary(
  metricKey: string,
  period: 'daily' | 'weekly',
): MetricSummary {
  const periodMs = period === 'daily' ? DAY_MS : WEEK_MS;
  const now = Date.now();
  const currentStart = Math.floor(now / periodMs) * periodMs;
  const previousStart = currentStart - periodMs;

  const currentAgg = getAggregates(metricKey, period, currentStart, currentStart);
  const previousAgg = getAggregates(metricKey, period, previousStart, previousStart);

  const current = currentAgg.length > 0 ? (currentAgg[0] as any).value : 0;
  const previous = previousAgg.length > 0 ? (previousAgg[0] as any).value : 0;
  const change = current - previous;
  const changePercent = previous > 0 ? Math.round((change / previous) * 10000) / 100 : 0;
  const trend = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';

  return { current, previous, change, changePercent, trend };
}

/**
 * Get comprehensive platform metrics for admin dashboard.
 */
export function getPlatformMetrics(): Record<string, any> {
  return {
    users: {
      newToday: getMetricSummary('users.new_daily', 'daily'),
      total: getMetricSummary('users.total', 'daily'),
      registrationTrend: getTimeSeries('users.new_daily', 'daily', 30),
    },
    revenue: {
      today: getMetricSummary('revenue.daily', 'daily'),
      trend: getTimeSeries('revenue.daily', 'daily', 30),
    },
    bots: {
      jobsToday: getMetricSummary('bots.jobs_completed', 'daily'),
      newToday: getMetricSummary('bots.new_daily', 'daily'),
    },
    support: {
      resolvedToday: getMetricSummary('support.resolved_daily', 'daily'),
    },
    events: getEventStats(),
    generatedAt: new Date().toISOString(),
  };
}

// ─── Scheduled Aggregation ──────────────────────────────────────────────────

let hourlyInterval: NodeJS.Timeout | null = null;
let dailyInterval: NodeJS.Timeout | null = null;

export function startAggregationSchedule(): void {
  // Run hourly aggregation
  hourlyInterval = setInterval(computeHourlyAggregates, HOUR_MS);

  // Run daily aggregation at the top of each day
  dailyInterval = setInterval(computeDailyAggregates, DAY_MS);

  // Run initial computation
  computeHourlyAggregates();
  computeDailyAggregates();

  logger.info('DataStore aggregation schedule started');
}

export function stopAggregationSchedule(): void {
  if (hourlyInterval) clearInterval(hourlyInterval);
  if (dailyInterval) clearInterval(dailyInterval);
  logger.info('DataStore aggregation schedule stopped');
}
