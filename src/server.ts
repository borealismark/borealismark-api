import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { getDb, seedProhibitedItems, seedApiTiers } from './db/database';
import { requestLogger, logger } from './middleware/logger';
import { initTurso, isTursoEnabled } from './db/turso';
import { globalLimiter } from './middleware/rateLimiter';
import { requireApiKey } from './middleware/auth';
import authRouter from './routes/auth';
import agentsRouter from './routes/agents';
import trustRouter from './routes/trust';
import networkRouter from './routes/network';
import marksRouter from './routes/marks';
import keysRouter from './routes/keys';
import webhooksRouter from './routes/webhooks';
import paymentsRouter from './routes/payments';
import terminalRouter from './routes/terminal';
import marketplaceRouter from './routes/marketplace';
import ordersRouter from './routes/orders';
import usageRouter from './routes/usage';
import docsRouter from './routes/docs';
import imageProxyRouter from './routes/imageProxy';
import botsRouter from './routes/bots';
import supportRouter from './routes/support';
import analyticsRouter from './routes/analytics';
import adminRouter from './routes/admin';
import adminMailRouter from './routes/adminMail';
import verificationRouter from './routes/verification';
import imagesRouter from './routes/images';
import { cleanupExpiredInvoices } from './hedera/usdc';
import { validateHederaConfig, logHealthCheckResults } from './hedera/healthcheck';
import { validateStripeConfig, getStripeMode } from './stripe/mode';
import { startAggregationSchedule } from './services/dataStore';
import { startAnchoringSchedule } from './services/hederaAnchor';
import { events as eventBus, initAdminNotifications } from './services/eventBus';
import { getDetailedHealth } from './services/monitoring';
import {
  getExpiredUsdcSubscriptions, getAllExpiredSubscriptions, getExpiringSubscriptions,
  updateUserTier, getExpiredSanctions, upsertUserSanction,
  getBotsByOwnerSortedByActivity, suspendBot, countBotsByOwnerId,
} from './db/database';
import { sendSubscriptionExpiryReminder, sendDowngradeNotificationEmail } from './services/email';
import { moderateServerSide, determineAction, actionToSanctionParams, type SanctionAction } from './middleware/messageModeration';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// ─── Environment Variable Validation ──────────────────────────────────────────

function validateEnvironment(): void {
  const required = ['JWT_SECRET', 'API_MASTER_KEY'];
  const databaseVars = ['DATABASE_URL', 'DB_PATH'];
  const hasDatabaseVar = databaseVars.some(v => process.env[v]);

  // Check critical vars
  const missing: string[] = [];
  for (const varName of required) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  // Check database config
  if (!hasDatabaseVar) {
    missing.push('DATABASE_URL or DB_PATH');
  }

  if (missing.length > 0) {
    logger.error('FATAL: Missing critical environment variables', { missing });
    process.exit(1);
  }

  // Production-only requirements
  if (process.env.NODE_ENV === 'production') {
    const prodRequired = ['HEDERA_ACCOUNT_ID', 'HEDERA_PRIVATE_KEY', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY'];
    const prodMissing: string[] = [];
    for (const varName of prodRequired) {
      if (!process.env[varName]) {
        prodMissing.push(varName);
      }
    }
    if (prodMissing.length > 0) {
      logger.error('FATAL: Missing production environment variables', { missing: prodMissing });
      process.exit(1);
    }
  }

  // Warnings for optional but recommended vars
  const recommended = ['HEDERA_NETWORK', 'STRIPE_WEBHOOK_SECRET', 'FRONTEND_URL'];
  const missingOptional = recommended.filter(v => !process.env[v]);
  if (missingOptional.length > 0) {
    logger.warn('Optional environment variables not set', { missing: missingOptional });
  }

  logger.info('Environment validation passed');
}

// Validate environment at startup
validateEnvironment();

// ─── Database initialization ───

if (isTursoEnabled()) {
  try {
    initTurso();
    logger.info('Using Turso (LibSQL) for persistent database');
  } catch (err) {
    logger.error('Failed to initialize Turso', { error: String(err) });
    process.exit(1);
  }
} else {
  logger.info('Using local SQLite (better-sqlite3) — data is ephemeral on Render free tier');
}

// ─── Hedera Configuration Health Check ────────────────────────────────────

const hederaHealth = validateHederaConfig();
logHealthCheckResults(hederaHealth);

// ─── Stripe validation ────────────────────────────────────────────────────────
const stripeHealth = validateStripeConfig();
if (stripeHealth.errors.length > 0) {
  stripeHealth.errors.forEach(e => logger.error(`Stripe: ${e}`));
  if (process.env.NODE_ENV === 'production') process.exit(1);
}
stripeHealth.warnings.forEach(w => logger.warn(`Stripe: ${w}`));

// ─── Security Hardening ───────────────────────────────────────────────────────

// Remove the X-Powered-By header so we don't advertise the framework
app.disable('x-powered-by');

// Trust one proxy hop (Nginx / load balancer) for accurate client IPs
app.set('trust proxy', 1);

// ─── Global Middleware ────────────────────────────────────────────────────────

// Attach request IDs and structured request/response logging
app.use(requestLogger);

// Global rate limiter — all routes except /health
app.use(globalLimiter);

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, Postman, curl)
    if (!origin) return callback(null, true);
    const allowed = [
      'https://borealismark.com', 'https://www.borealismark.com',
      'https://borealisterminal.com', 'https://www.borealisterminal.com',
      'https://borealisprotocol.ai', 'https://www.borealisprotocol.ai',
    ];
    // Allow exact localhost/127.0.0.1 with any port (strict regex to prevent localhost.evil.com)
    const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
    // Allow all Cloudflare Pages preview URLs
    if (allowed.includes(origin)
        || origin.endsWith('.pages.dev')
        || localhostRegex.test(origin)) {
      return callback(null, true);
    }
    callback(null, false);
  },
  exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
}));

// Raw body for Stripe webhook verification (must come before json parser)
app.use('/v1/payments/webhook', express.raw({ type: 'application/json' }));

// 2 MB body limit — enough for a rich audit payload, too small for abuse
app.use(express.json({ limit: '2mb' }));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/v1/auth',     authRouter);
app.use('/v1/agents',   agentsRouter);
app.use('/v1/trust',    trustRouter);
app.use('/v1/network',  networkRouter);
app.use('/v1/marks',    marksRouter);
app.use('/v1/keys',     keysRouter);
app.use('/v1/webhooks', webhooksRouter);
app.use('/v1/payments', paymentsRouter);
app.use('/v1/terminal', terminalRouter);
app.use('/v1/marketplace', marketplaceRouter);
app.use('/v1/marketplace', ordersRouter);
app.use('/v1/usage',    usageRouter);
app.use('/v1/docs',     docsRouter);
app.use('/v1/images',   imageProxyRouter);
app.use('/v1/images',   imagesRouter);
app.use('/v1/bots',     botsRouter);
app.use('/v1/support',  supportRouter);
app.use('/v1/analytics', analyticsRouter);
app.use('/v1/admin',     adminRouter);
app.use('/v1/admin/mail', adminMailRouter);
app.use('/v1/verification', verificationRouter);

// ─── Static Files (Dashboard) ────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Dynamic Sitemap (for SEO) ────────────────────────────────────────────────

app.get('/sitemap.xml', (_req, res) => {
  try {
    const db = getDb();
    const listings = db.prepare(
      "SELECT id, title, updated_at FROM marketplace_listings WHERE status = 'published' ORDER BY updated_at DESC LIMIT 5000"
    ).all() as any[];

    const base = 'https://borealisterminal.com';
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    xml += `  <url><loc>${base}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n`;
    xml += `  <url><loc>${base}/#browse</loc><changefreq>daily</changefreq><priority>0.9</priority></url>\n`;

    for (const l of listings) {
      const lastmod = l.updated_at ? new Date(typeof l.updated_at === 'number' ? l.updated_at : l.updated_at).toISOString().split('T')[0] : '';
      xml += `  <url><loc>${base}/#listing/${l.id}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
    }

    xml += '</urlset>';
    res.header('Content-Type', 'application/xml').send(xml);
  } catch (err: any) {
    res.status(500).send('<!-- sitemap error -->');
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  const health = getDetailedHealth();
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json(health);
});

// Detailed health (requires API key for sensitive info)
app.get('/health/detailed', requireApiKey, (_req, res) => {
  const health = getDetailedHealth();
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json(health);
});

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    available: [
      '/v1/auth', '/v1/agents', '/v1/trust', '/v1/network', '/v1/marks',
      '/v1/keys', '/v1/webhooks', '/v1/payments', '/v1/terminal', '/v1/marketplace',
      '/v1/usage', '/v1/docs', '/v1/bots', '/v1/support', '/v1/analytics', '/v1/admin', '/v1/admin/mail', '/health',
    ],
    timestamp: Date.now(),
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = (req as express.Request & { requestId?: string }).requestId;
  logger.error('Unhandled error', {
    requestId,
    error: err.message,
  });
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    requestId,
    timestamp: Date.now(),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Initialise DB (creates schema + seeds master key)
getDb();

// Seed prohibited items database (idempotent — only runs on fresh DB)
seedProhibitedItems();

// Seed API tiers (idempotent — only runs on fresh DB)
seedApiTiers();

// Clean up expired USDC invoices every 5 minutes
setInterval(() => {
  const cleaned = cleanupExpiredInvoices();
  if (cleaned > 0) {
    logger.info('Cleaned up expired USDC invoices', { count: cleaned });
  }
}, 5 * 60 * 1000);

// ─── Subscription Lifecycle: Reminders, Expiry, Bot Deactivation ─────────────

const BOT_LIMITS_SERVER: Record<string, number> = { standard: 3, pro: 10, elite: 50 };
const PLAN_DISPLAY_NAMES: Record<string, string> = { pro: 'Pro', elite: 'Elite', starter: 'API Starter', business: 'API Business', enterprise: 'API Enterprise' };

/**
 * Deactivate excess bots when a user is downgraded.
 * Keeps the N most active bots (by jobs, AP, rating) and suspends the rest.
 */
function deactivateExcessBots(userId: string, newLimit: number): Array<{ name: string; id: string }> {
  const bots = getBotsByOwnerSortedByActivity(userId); // sorted least active first
  if (bots.length <= newLimit) return [];

  const toSuspend = bots.slice(0, bots.length - newLimit); // least active get suspended
  const suspended: Array<{ name: string; id: string }> = [];

  for (const bot of toSuspend) {
    suspendBot(bot.id);
    suspended.push({ name: bot.name, id: bot.id });
    logger.info('Bot suspended due to tier downgrade', {
      botId: bot.id, botName: bot.name, userId,
      reason: 'subscription_expired',
    });
  }

  return suspended;
}

// Check for expiring subscriptions and send reminders (every 6 hours)
setInterval(async () => {
  try {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const windows = [
      { within: 30 * DAY_MS, label: 30 },
      { within: 7 * DAY_MS, label: 7 },
      { within: 1 * DAY_MS, label: 1 },
    ];

    for (const { within, label } of windows) {
      const expiring = getExpiringSubscriptions(within);
      for (const user of expiring) {
        if (!user.subscriptionExpiresAt) continue;
        const daysLeft = Math.ceil((user.subscriptionExpiresAt - Date.now()) / DAY_MS);
        // Only send at the right window (30, 7, or 1 day)
        if (Math.abs(daysLeft - label) > 1) continue;

        const planName = PLAN_DISPLAY_NAMES[user.subscriptionPlanId ?? 'pro'] ?? 'Pro';
        const botCount = countBotsByOwnerId(user.id);
        const newLimit = BOT_LIMITS_SERVER.standard;

        await sendSubscriptionExpiryReminder(
          user.email, user.name ?? user.email, daysLeft, planName, botCount, newLimit,
        );
        logger.info('Expiry reminder sent', {
          userId: user.id, email: user.email, daysLeft, planName, botCount,
        });
      }
    }
  } catch (err: any) {
    logger.error('Failed to send expiry reminders', { error: err.message });
  }
}, 6 * 60 * 60 * 1000); // every 6 hours

// Check for expired subscriptions (ALL methods) every hour — downgrade + deactivate bots
setInterval(async () => {
  try {
    // Safety net: catches both USDC and any missed Stripe webhook expirations
    const expired = getAllExpiredSubscriptions();
    for (const user of expired) {
      const previousTier = user.tier;
      const previousPlan = PLAN_DISPLAY_NAMES[user.subscriptionPlanId ?? previousTier] ?? previousTier;
      const newLimit = BOT_LIMITS_SERVER.standard;

      // Wrap tier downgrade and bot deactivation in a database transaction to prevent race conditions
      const db = getDb();
      const suspended = db.transaction(() => {
        // 1. Downgrade tier
        updateUserTier(user.id, 'standard');

        // 2. Deactivate excess bots (keep the 3 most active)
        return deactivateExcessBots(user.id, newLimit);
      })();

      // 3. Send downgrade notification email
      await sendDowngradeNotificationEmail(
        user.email, user.name ?? user.email, previousPlan, suspended,
      );

      logger.info('Subscription expired → full downgrade processed', {
        userId: user.id,
        email: user.email,
        previousTier,
        previousPlan,
        botsSuspended: suspended.length,
        botsKept: newLimit,
        expiredAt: user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).toISOString() : 'unknown',
      });
    }
    if (expired.length > 0) {
      logger.info('Expired subscriptions processed', { count: expired.length, totalBotsSuspended: expired.length });
    }
  } catch (err: any) {
    logger.error('Failed to process expired subscriptions', { error: err.message });
  }
}, 60 * 60 * 1000); // hourly

// Periodic AI moderation scan — runs every 30 minutes
setInterval(async () => {
  try {
    logger.info('Running periodic message moderation scan...');

    const db = getDb();
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;

    // 1. Scan recent messages (last 30 min) for violations
    const recentMessages = db.prepare(`
      SELECT m.id, m.sender_id, m.body, m.thread_id, u.name as sender_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.created_at > ?
    `).all(thirtyMinutesAgo) as any[];

    let scanned = 0;
    let violations = 0;

    for (const msg of recentMessages) {
      scanned++;
      const result = moderateServerSide(msg.body);

      if (!result.clean) {
        violations++;
        // Get current violation count
        const currentViolationCount = db.prepare(
          'SELECT violation_count FROM user_sanctions WHERE user_id = ?'
        ).get(msg.sender_id) as { violation_count: number } | undefined;
        const violationCount = (currentViolationCount?.violation_count ?? 0) + 1;

        const action = determineAction(violationCount, result.severity);
        const sanctionParams = actionToSanctionParams(action as SanctionAction);

        // Check if user already has an active sanction to prevent double-sanctioning
        const existingSanction = db.prepare(
          'SELECT status, muted_until, suspended_until FROM user_sanctions WHERE user_id = ? LIMIT 1'
        ).get(msg.sender_id) as any;

        const now = Date.now();
        const hasActiveMute = existingSanction?.status === 'muted' && existingSanction.muted_until && existingSanction.muted_until > now;
        const hasActiveSuspension = existingSanction?.status === 'suspended' && existingSanction.suspended_until && existingSanction.suspended_until > now;

        // Skip if user already has an active sanction
        if (hasActiveMute || hasActiveSuspension) {
          logger.info('Skipping sanction — user already has active sanction', {
            userId: msg.sender_id,
            existingStatus: existingSanction?.status,
          });
          return;
        }

        // Log violation
        db.prepare(`
          INSERT INTO user_violations (id, user_id, type, severity, message_id, thread_id, details, action_taken, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          require('crypto').randomUUID(),
          msg.sender_id,
          result.violationType || 'unknown',
          result.severity,
          msg.id,
          msg.thread_id,
          JSON.stringify(result.matchedPatterns),
          action,
          Date.now(),
        );

        // Apply sanction
        upsertUserSanction(
          msg.sender_id,
          sanctionParams.status,
          sanctionParams.mutedUntil,
          sanctionParams.suspendedUntil,
          violationCount,
        );

        // Optionally censor the message in-place if blocked
        if (result.blocked) {
          db.prepare('UPDATE messages SET body = ? WHERE id = ?')
            .run('[Message removed for policy violation]', msg.id);
        }

        logger.info('Auto-moderation violation detected', {
          userId: msg.sender_id,
          messageId: msg.id,
          type: result.violationType,
          severity: result.severity,
          action,
        });
      }
    }

    // 2. Auto-unblock expired sanctions
    const expiredSanctions = getExpiredSanctions();
    for (const sanction of expiredSanctions) {
      const now = Date.now();

      if (sanction.status === 'muted' && sanction.muted_until && sanction.muted_until < now) {
        upsertUserSanction(sanction.user_id, 'active', null, null, sanction.violation_count);
        logger.info('Auto-unmuted user', { userId: sanction.user_id });
      }

      if (sanction.status === 'suspended' && sanction.suspended_until && sanction.suspended_until < now) {
        upsertUserSanction(sanction.user_id, 'active', null, null, sanction.violation_count);
        logger.info('Auto-unsuspended user', { userId: sanction.user_id });
      }
    }

    logger.info('Moderation scan complete', { scanned, violations, autoClearedCount: expiredSanctions.length });
  } catch (err: any) {
    logger.error('Moderation scan error', { error: err.message });
  }
}, 30 * 60 * 1000); // Every 30 minutes

app.listen(PORT, () => {
  logger.info('BorealisMark Protocol API started', {
    port: PORT,
    env: process.env.NODE_ENV ?? 'development',
    network: process.env.HEDERA_NETWORK ?? 'testnet',
    hcsConfigured: !!process.env.HEDERA_AUDIT_TOPIC_ID,
  });

  // Start data infrastructure
  startAggregationSchedule();
  startAnchoringSchedule();
  initAdminNotifications();

  // Emit system startup event
  eventBus.systemError('startup', 'API started successfully'); // reusing as system event

  if (process.env.NODE_ENV !== 'production') {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║         BorealisMark Protocol API v1.2.0                 ║
║         Blockchain-Anchored AI Trust Infrastructure      ║
╠══════════════════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}                         ║
║  Network:   ${(process.env.HEDERA_NETWORK ?? 'testnet').padEnd(43)}║
║  DB:        ${(process.env.DB_PATH ?? './borealismark.db').padEnd(43)}║
╠══════════════════════════════════════════════════════════╣
║  Routes:                                                 ║
║    POST /v1/auth/register         Create user account    ║
║    POST /v1/auth/login            Authenticate → JWT     ║
║    GET  /v1/auth/me               Current user profile   ║
║    POST /v1/auth/refresh          Refresh JWT token      ║
║    POST /v1/agents/register       Register AI agent      ║
║    POST /v1/agents/audit          Run cryptographic audit║
║    GET  /v1/agents/:id/score      Retrieve score         ║
║    GET  /v1/agents/:id/certificate Full certificate      ║
║    POST /v1/trust/deposit         Create trust deposit   ║
║    POST /v1/trust/penalize        Execute penalty        ║
║    GET  /v1/network/consensus     Network stats          ║
║    GET  /v1/marks/global          Global mark registry   ║
║    POST /v1/keys                  Create API key [admin] ║
║    GET  /v1/keys                  List API keys  [admin] ║
║    DELETE /v1/keys/:id            Revoke API key [admin] ║
║    POST /v1/webhooks              Register webhook       ║
║    GET  /v1/webhooks              List webhooks          ║
║    POST /v1/webhooks/:id/test     Test webhook           ║
║    DELETE /v1/webhooks/:id        Delete webhook         ║
║    GET  /v1/payments/plans        List plans (dual pay)  ║
║    POST /v1/payments/checkout     Stripe OR USDC checkout║
║    POST /v1/payments/portal       Stripe billing portal  ║
║    GET  /v1/payments/subs/:id     List subscriptions     ║
║    GET  /v1/payments/usdc/inv/:id USDC invoice status    ║
║    POST /v1/payments/usdc/ver/:id Verify USDC payment    ║
║    POST /v1/payments/webhook      Stripe webhook         ║
║    POST /v1/terminal/services    List a service         ║
║    GET  /v1/terminal/services    Browse marketplace     ║
║    POST /v1/terminal/contracts   Create contract        ║
║    GET  /v1/terminal/contracts   List contracts         ║
║    PATCH /v1/terminal/contracts  Update status          ║
║    GET  /v1/terminal/stats       Marketplace stats      ║
║    POST /v1/bots                 Register AI bot        ║
║    GET  /v1/bots                 List user's bots       ║
║    GET  /v1/bots/:id             Get bot details        ║
║    PUT  /v1/bots/:id             Update bot             ║
║    DELETE /v1/bots/:id           Deactivate bot         ║
║    GET  /v1/bots/leaderboard     Top bots by AP         ║
║    POST /v1/bots/:id/jobs        Assign job to bot      ║
║    PUT  /v1/bots/:id/jobs/:jobId Update job status      ║
║    POST /v1/bots/:id/rate        Rate bot after job     ║
║    GET  /v1/bots/:id/jobs        Get bot job history    ║
║    POST /v1/bots/:id/review      Admin review bot       ║
║    GET  /v1/bots/stats           Global bot stats       ║
║    POST /v1/support/chat         AI support chat        ║
║    POST /v1/support/email-inbound Email webhook         ║
║    GET  /v1/support/health       Support status         ║
║    GET  /health                   Health check           ║
╚══════════════════════════════════════════════════════════╝
    `);
  }
});

export default app;
