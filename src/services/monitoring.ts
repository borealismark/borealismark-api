/**
 * Monitoring & Health Check Service
 *
 * Provides detailed health information for uptime monitoring,
 * alerting, and operational visibility.
 */
import { getDb } from '../db/database';
import { logger } from '../middleware/logger';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  timestamp: number;
  checks: {
    database: { status: string; latencyMs: number; backend: string };
    hedera: { configured: boolean; network: string | null };
    stripe: { configured: boolean; mode: string | null };
    r2: { configured: boolean };
    email: { configured: boolean; domain: string | null };
  };
  stats?: {
    totalAgents: number;
    totalCertificates: number;
    totalUsers: number;
    totalListings: number;
  };
}

const startTime = Date.now();

export function getDetailedHealth(): HealthStatus {
  const checks: HealthStatus['checks'] = {
    database: { status: 'unknown', latencyMs: 0, backend: 'sqlite' },
    hedera: {
      configured: !!(
        (process.env.HEDERA_GAS_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID) &&
        (process.env.HEDERA_GAS_PRIVATE_KEY || process.env.HEDERA_PRIVATE_KEY)
      ),
      network: process.env.HEDERA_NETWORK || null,
    },
    stripe: {
      configured: !!process.env.STRIPE_SECRET_KEY,
      mode: process.env.STRIPE_SECRET_KEY?.startsWith('sk_live')
        ? 'live'
        : process.env.STRIPE_SECRET_KEY?.startsWith('sk_test')
          ? 'test'
          : null,
    },
    r2: {
      configured: !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID),
    },
    email: {
      configured: !!process.env.RESEND_API_KEY,
      domain: process.env.EMAIL_FROM?.match(/@(.+)>/)?.[1] || null,
    },
  };

  // Database health check with latency measurement
  let dbStatus = 'unhealthy';
  let dbLatency = 0;
  let stats: HealthStatus['stats'] | undefined;

  try {
    const dbStart = Date.now();
    const db = getDb();
    db.prepare('SELECT 1').get();
    dbLatency = Date.now() - dbStart;
    dbStatus = dbLatency < 100 ? 'healthy' : 'degraded';

    // Gather stats
    try {
      const agents = db.prepare('SELECT COUNT(*) as count FROM agents').get() as any;
      const certs = db.prepare('SELECT COUNT(*) as count FROM audit_certificates').get() as any;
      const users = db.prepare('SELECT COUNT(*) as count FROM users').get() as any;
      const listings = db.prepare('SELECT COUNT(*) as count FROM marketplace_listings').get() as any;
      stats = {
        totalAgents: agents?.count || 0,
        totalCertificates: certs?.count || 0,
        totalUsers: users?.count || 0,
        totalListings: listings?.count || 0,
      };
    } catch {
      // Stats are optional — some tables may not exist yet
    }
  } catch (err) {
    logger.error('Database health check failed', { error: String(err) });
  }

  checks.database = {
    status: dbStatus,
    latencyMs: dbLatency,
    backend: 'sqlite',
  };

  // Overall status
  const overallStatus =
    dbStatus === 'unhealthy'
      ? 'unhealthy'
      : dbStatus === 'degraded' ||
          !checks.hedera.configured ||
          !checks.stripe.configured
        ? 'degraded'
        : 'healthy';

  return {
    status: overallStatus,
    version: '1.7.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: Date.now(),
    checks,
    stats,
  };
}
