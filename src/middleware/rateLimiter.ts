import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

// ─── Shared Error Shape ────────────────────────────────────────────────────────

function rateLimitHandler(_req: Request, res: Response): void {
  res.status(429).json({
    success: false,
    error: 'Rate limit exceeded. Slow down and try again shortly.',
    code: 'RATE_LIMIT_EXCEEDED',
    timestamp: Date.now(),
  });
}

// ─── Global Limiter ───────────────────────────────────────────────────────────
// 200 requests per 15 minutes per IP — generous enough for active integrations,
// tight enough to prevent scraping or DDoS from a single source.

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,   // Return RateLimit-* headers (RFC 6585)
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: (req) => req.path === '/health', // Health checks are exempt
});

// ─── Auth Limiter ────────────────────────────────────────────────────────────
// Login and registration: 10 attempts per 15 minutes per IP prevents brute-force.

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// ─── Password Reset Limiter ──────────────────────────────────────────────────
// 3 reset requests per 15 minutes per IP — prevents abuse/email flooding.

export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// ─── Audit Limiter ────────────────────────────────────────────────────────────
// Running an audit involves Hedera consensus submission — computationally and
// financially non-trivial. 20 per minute per API key is a hard ceiling.

export const auditLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  keyGenerator: (req) => {
    const authReq = req as any;
    return authReq.apiKey?.id ?? req.ip ?? 'unknown';
  },
});

// ─── Key Creation Limiter ─────────────────────────────────────────────────────
// API key creation is a privileged operation. 10 per hour prevents key farming.

export const keyCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  keyGenerator: (req) => {
    const authReq = req as any;
    return authReq.apiKey?.id ?? req.ip ?? 'unknown';
  },
});

// ─── Webhook Registration Limiter ─────────────────────────────────────────────
// Each key can register up to 5 webhooks per hour — enough for legitimate
// integration setup, too few to cause event-flooding abuse.

export const webhookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  keyGenerator: (req) => {
    const authReq = req as any;
    return authReq.apiKey?.id ?? req.ip ?? 'unknown';
  },
});

// ─── Slash Limiter ────────────────────────────────────────────────────────────
// Slashing executes real BMT transfers. Extreme conservatism: 2 per hour per API key.

export const slashLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  keyGenerator: (req) => {
    const authReq = req as any;
    return authReq.apiKey?.id ?? req.ip ?? 'unknown';
  },
});
