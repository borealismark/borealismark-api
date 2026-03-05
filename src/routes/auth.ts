/**
 * BorealisMark — Authentication Routes
 *
 * JWT-based user authentication for the platform dashboard.
 *
 *   POST /v1/auth/register  — Create account (email + password)
 *   POST /v1/auth/login     — Authenticate → JWT
 *   GET  /v1/auth/me        — Get current user profile (requires JWT)
 *   POST /v1/auth/refresh   — Refresh an expiring token
 */

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import {
  createUser,
  getUserByEmail,
  getUserById,
  updateUserLogin,
  updateUserRole,
} from '../db/database';
import { logger } from '../middleware/logger';
import { authLimiter } from '../middleware/rateLimiter';

const router = Router();

// ─── Config ──────────────────────────────────────────────────────────────────

const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    logger.error('FATAL: JWT_SECRET must be set in production');
    process.exit(1);
  }
  if (!secret || secret === 'borealismark-jwt-dev-secret-change-me') {
    logger.warn('Using default JWT secret — set JWT_SECRET env var for production');
  }
  return secret ?? 'borealismark-jwt-dev-secret-change-me';
})();
const JWT_EXPIRES_IN = '24h';
const JWT_REFRESH_WINDOW = 2 * 60 * 60 * 1000; // last 2 hours — eligible for refresh
const BCRYPT_ROUNDS = 12;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain uppercase, lowercase, and a number',
    ),
  name: z.string().min(1, 'Name is required').max(100).trim(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function signToken(userId: string, email: string, tier: string, role: string = 'user'): string {
  return jwt.sign(
    { sub: userId, email, tier, role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

/**
 * Middleware: extract and verify JWT from Authorization header.
 * Attaches decoded payload to req.user.
 */
export function requireAuth(req: Request, res: Response, next: Function): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      sub: string;
      email: string;
      tier: string;
      iat: number;
      exp: number;
    };
    (req as any).user = decoded;
    next();
  } catch (err: any) {
    const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    res.status(401).json({ success: false, error: message });
  }
}

// ─── POST /register ──────────────────────────────────────────────────────────

router.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email, password, name } = parsed.data;

    // Check if email already exists
    const existing = getUserByEmail(email);
    if (existing) {
      res.status(409).json({
        success: false,
        error: 'An account with this email already exists',
      });
      return;
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = uuid();
    createUser(userId, email, passwordHash, name);

    // Generate JWT
    const token = signToken(userId, email, 'standard');

    logger.info('User registered', { userId, email });

    res.status(201).json({
      success: true,
      data: {
        token,
        user: {
          id: userId,
          email: email.toLowerCase().trim(),
          name: name.trim(),
          tier: 'standard',
          createdAt: Date.now(),
        },
      },
    });
  } catch (err: any) {
    logger.error('Registration error', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// ─── POST /login ─────────────────────────────────────────────────────────────

router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid credentials format' });
      return;
    }

    const { email, password } = parsed.data;
    const user = getUserByEmail(email);

    if (!user) {
      // Timing-safe: still hash even on miss to prevent timing attacks
      await bcrypt.hash(password, BCRYPT_ROUNDS);
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    // Update last login
    updateUserLogin(user.id);

    const token = signToken(user.id, user.email, user.tier, user.role);

    logger.info('User logged in', { userId: user.id, email, role: user.role });

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tier: user.tier,
          role: user.role,
          createdAt: user.createdAt,
          lastLoginAt: Date.now(),
        },
      },
    });
  } catch (err: any) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ─── GET /me ─────────────────────────────────────────────────────────────────

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const { sub: userId } = (req as any).user;
  const user = getUserById(userId);

  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier,
      role: user.role,
      stripeCustomerId: user.stripeCustomerId,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      emailVerified: user.emailVerified,
    },
  });
});

// ─── POST /refresh ───────────────────────────────────────────────────────────

router.post('/refresh', requireAuth, (req: Request, res: Response) => {
  const { sub: userId, exp } = (req as any).user;
  const user = getUserById(userId);

  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  // Only refresh if within the last 2 hours of the token's life
  const now = Math.floor(Date.now() / 1000);
  const remaining = (exp - now) * 1000;
  if (remaining > JWT_REFRESH_WINDOW) {
    res.json({ success: true, data: { message: 'Token still valid, no refresh needed' } });
    return;
  }

  const token = signToken(user.id, user.email, user.tier, user.role);
  res.json({ success: true, data: { token } });
});

// ─── POST /admin/create ─────────────────────────────────────────────────────
// Create admin account — requires API_MASTER_KEY in X-Master-Key header

router.post('/admin/create', async (req: Request, res: Response) => {
  try {
    const masterKey = process.env.API_MASTER_KEY;
    const providedKey = req.headers['x-master-key'] as string;

    if (!masterKey || !providedKey || providedKey !== masterKey) {
      res.status(403).json({ success: false, error: 'Invalid or missing master key' });
      return;
    }

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email, password, name } = parsed.data;
    const tier = (req.body.tier as string) || 'elite';

    // Check if email already exists
    const existing = getUserByEmail(email);
    if (existing) {
      // Promote existing user to admin
      updateUserRole(existing.id, 'admin');
      const token = signToken(existing.id, existing.email, tier, 'admin');
      logger.info('Existing user promoted to admin', { userId: existing.id, email });
      res.json({
        success: true,
        data: {
          token,
          user: { id: existing.id, email: existing.email, name: existing.name, tier, role: 'admin' },
          message: 'Existing user promoted to admin',
        },
      });
      return;
    }

    // Create new admin user
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = uuid();
    createUser(userId, email, passwordHash, name, 'admin', tier as any);

    const token = signToken(userId, email, tier, 'admin');

    logger.info('Admin user created', { userId, email });

    res.status(201).json({
      success: true,
      data: {
        token,
        user: {
          id: userId,
          email: email.toLowerCase().trim(),
          name: name.trim(),
          tier,
          role: 'admin',
          createdAt: Date.now(),
        },
      },
    });
  } catch (err: any) {
    logger.error('Admin creation error', { error: err.message });
    res.status(500).json({ success: false, error: 'Admin creation failed' });
  }
});

export default router;
