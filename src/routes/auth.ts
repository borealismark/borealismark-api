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
} from '../db/database';
import { logger } from '../middleware/logger';

const router = Router();

// ─── Config ──────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET ?? 'borealismark-jwt-dev-secret-change-me';
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

function signToken(userId: string, email: string, tier: string): string {
  return jwt.sign(
    { sub: userId, email, tier },
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

router.post('/register', async (req: Request, res: Response) => {
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
    logger.error('Registration error', { error: err.message });
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// ─── POST /login ─────────────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
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

    const token = signToken(user.id, user.email, user.tier);

    logger.info('User logged in', { userId: user.id, email });

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tier: user.tier,
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

  const token = signToken(user.id, user.email, user.tier);
  res.json({ success: true, data: { token } });
});

export default router;
