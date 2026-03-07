import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { getDb, seedProhibitedItems, seedApiTiers } from './db/database';
import { requestLogger, logger } from './middleware/logger';
import { globalLimiter } from './middleware/rateLimiter';
import authRouter from './routes/auth';
import agentsRouter from './routes/agents';
import stakingRouter from './routes/staking';
import networkRouter from './routes/network';
import marksRouter from './routes/marks';
import keysRouter from './routes/keys';
import webhooksRouter from './routes/webhooks';
import paymentsRouter from './routes/payments';
import terminalRouter from './routes/terminal';
import marketplaceRouter from './routes/marketplace';
import usageRouter from './routes/usage';
import docsRouter from './routes/docs';
import { cleanupExpiredInvoices } from './hedera/usdc';
import { getExpiredUsdcSubscriptions, updateUserTier } from './db/database';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

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
    // Allow all Cloudflare Pages preview URLs
    if (allowed.includes(origin)
        || origin.endsWith('.pages.dev')
        || origin.includes('localhost')) {
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
app.use('/v1/staking',  stakingRouter);
app.use('/v1/network',  networkRouter);
app.use('/v1/marks',    marksRouter);
app.use('/v1/keys',     keysRouter);
app.use('/v1/webhooks', webhooksRouter);
app.use('/v1/payments', paymentsRouter);
app.use('/v1/terminal', terminalRouter);
app.use('/v1/marketplace', marketplaceRouter);
app.use('/v1/usage',    usageRouter);
app.use('/v1/docs',     docsRouter);

// ─── Static Files (Dashboard) ────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'BorealisMark Protocol API',
    version: '1.2.0',
    timestamp: Date.now(),
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    available: [
      '/v1/auth', '/v1/agents', '/v1/staking', '/v1/network', '/v1/marks',
      '/v1/keys', '/v1/webhooks', '/v1/payments', '/v1/terminal', '/v1/marketplace',
      '/v1/usage', '/v1/docs', '/health',
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

// Check for expired USDC subscriptions every hour and downgrade
setInterval(() => {
  try {
    const expired = getExpiredUsdcSubscriptions();
    for (const user of expired) {
      updateUserTier(user.id, 'standard');
      logger.info('USDC subscription expired → downgraded to standard', {
        userId: user.id,
        email: user.email,
        previousTier: user.tier,
        expiredAt: user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).toISOString() : 'unknown',
      });
    }
    if (expired.length > 0) {
      logger.info('Expired USDC subscriptions processed', { count: expired.length });
    }
  } catch (err: any) {
    logger.error('Failed to process expired subscriptions', { error: err.message });
  }
}, 60 * 60 * 1000); // hourly

app.listen(PORT, () => {
  logger.info('BorealisMark Protocol API started', {
    port: PORT,
    env: process.env.NODE_ENV ?? 'development',
    network: process.env.HEDERA_NETWORK ?? 'testnet',
    hcsConfigured: !!process.env.HEDERA_AUDIT_TOPIC_ID,
  });

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
║    POST /v1/staking/allocate      Stake BMT              ║
║    POST /v1/staking/slash         Execute slashing       ║
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
║    GET  /health                   Health check           ║
╚══════════════════════════════════════════════════════════╝
    `);
  }
});

export default app;
