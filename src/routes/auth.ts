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
  createPasswordResetToken,
  getValidPasswordResetToken,
  markPasswordResetTokenUsed,
  updateUserPassword,
  getUserSanction,
  setEmailVerified,
  createEmailVerificationToken,
  getValidEmailVerificationToken,
} from '../db/database';
import { logger } from '../middleware/logger';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimiter';
import { events as eventBus } from '../services/eventBus';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/email';

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

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain uppercase, lowercase, and a number',
    ),
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
 * JWT payload shape decoded from the Bearer token.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  tier: string;
  role: string;
  iat: number;
  exp: number;
}

/**
 * Request with authenticated user attached.
 */
export interface AuthRequest extends Request {
  user?: JwtPayload;
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
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
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

    // Generate JWT (user can log in but will see verification gate)
    const token = signToken(userId, email, 'standard');

    // Send verification email
    const verifyToken = createEmailVerificationToken(userId, email);
    const emailSent = await sendVerificationEmail(email, verifyToken, name);

    logger.info('User registered', { userId, email, verificationEmailSent: emailSent });
    eventBus.userRegistered(userId, email);

    res.status(201).json({
      success: true,
      data: {
        token,
        user: {
          id: userId,
          email: email.toLowerCase().trim(),
          name: name.trim(),
          tier: 'standard',
          emailVerified: false,
          createdAt: Date.now(),
        },
        verificationEmailSent: emailSent,
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

    // ─── Check if user is banned/suspended ────────────────────────────────
    const sanction = getUserSanction(user.id);
    if (sanction) {
      const now = Date.now();

      if (sanction.status === 'banned') {
        logger.warn('Login attempt by banned user', { userId: user.id, email });
        return res.status(403).json({
          success: false,
          error: 'Your account has been permanently suspended for policy violations.',
          banned: true,
        });
      }

      if (sanction.status === 'suspended' && sanction.suspended_until && sanction.suspended_until > now) {
        const date = new Date(sanction.suspended_until).toLocaleString();
        logger.warn('Login attempt by suspended user', { userId: user.id, email, suspendedUntil: sanction.suspended_until });
        return res.status(403).json({
          success: false,
          error: `Your account is suspended until ${date} for policy violations.`,
          suspended: true,
          suspendedUntil: sanction.suspended_until,
        });
      }
    }

    // Update last login
    updateUserLogin(user.id);

    const token = signToken(user.id, user.email, user.tier, user.role);

    logger.info('User logged in', { userId: user.id, email, role: user.role });
    eventBus.userLogin(user.id);

    // Include mute status in response if applicable
    const muted = sanction?.status === 'muted' && sanction.muted_until && sanction.muted_until > Date.now();

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
          emailVerified: user.emailVerified,
          createdAt: user.createdAt,
          lastLoginAt: Date.now(),
        },
        ...(muted && {
          muted: true,
          mutedUntil: sanction?.muted_until,
        }),
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

  // Determine user badge from tier
  const TIER_BADGES: Record<string, string | null> = {
    standard: null, pro: 'pro', elite: 'elite', platinum: 'trusted-seller', sovereign: 'sovereign',
  };

  res.json({
    success: true,
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier,
      role: user.role,
      badge: TIER_BADGES[user.tier] ?? null,
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

// ─── POST /forgot-password ───────────────────────────────────────────────────
// Initiate password reset — sends email with secure reset link.
// Always returns success to prevent email enumeration.

router.post('/forgot-password', passwordResetLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Please provide a valid email address',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email } = parsed.data;
    const user = getUserByEmail(email);

    if (user) {
      // Generate reset token and send email
      const rawToken = createPasswordResetToken(user.id, user.email);
      const sent = await sendPasswordResetEmail(user.email, rawToken, user.name);

      if (!sent) {
        logger.error('Failed to send password reset email', { userId: user.id, email });
      } else {
        logger.info('Password reset requested', { userId: user.id, email });
      }
    } else {
      // Timing-safe: still spend time even if user not found
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
      logger.info('Password reset attempted for unknown email', { email });
    }

    // Always return success to prevent email enumeration
    res.json({
      success: true,
      data: {
        message: 'If an account with that email exists, a password reset link has been sent.',
      },
    });
  } catch (err: any) {
    logger.error('Forgot password error', { error: err.message });
    res.status(500).json({ success: false, error: 'Password reset request failed' });
  }
});

// ─── POST /reset-password ───────────────────────────────────────────────────
// Complete password reset — validates token and sets new password.

router.post('/reset-password', passwordResetLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { token, newPassword } = parsed.data;

    // Look up the token
    const resetRecord = getValidPasswordResetToken(token);
    if (!resetRecord) {
      res.status(400).json({
        success: false,
        error: 'Invalid or expired reset link. Please request a new one.',
      });
      return;
    }

    // Verify user still exists and is active
    const user = getUserById(resetRecord.userId);
    if (!user) {
      res.status(400).json({
        success: false,
        error: 'Account not found',
      });
      return;
    }

    // Hash new password and update
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    updateUserPassword(user.id, passwordHash);

    // Mark token as used (one-time)
    markPasswordResetTokenUsed(resetRecord.id);

    logger.info('Password reset completed', { userId: user.id, email: user.email });

    // Issue a fresh JWT so the user is immediately logged in
    const jwtToken = signToken(user.id, user.email, user.tier, user.role);

    res.json({
      success: true,
      data: {
        message: 'Password has been reset successfully',
        token: jwtToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tier: user.tier,
          role: user.role,
        },
      },
    });
  } catch (err: any) {
    logger.error('Reset password error', { error: err.message });
    res.status(500).json({ success: false, error: 'Password reset failed' });
  }
});

// ─── POST /verify-email ─────────────────────────────────────────────────────
// Validate email verification token and mark user as verified.

router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ success: false, error: 'Verification token is required' });
      return;
    }

    const record = getValidEmailVerificationToken(token);
    if (!record) {
      res.status(400).json({
        success: false,
        error: 'Invalid or expired verification link. Please request a new one.',
      });
      return;
    }

    const user = getUserById(record.userId);
    if (!user) {
      res.status(400).json({ success: false, error: 'Account not found' });
      return;
    }

    // Mark email as verified
    setEmailVerified(user.id, true);

    // Mark token as used (one-time)
    markPasswordResetTokenUsed(record.id);

    logger.info('Email verified', { userId: user.id, email: user.email });

    // Issue a fresh JWT so the frontend can update immediately
    const jwtToken = signToken(user.id, user.email, user.tier, user.role);

    res.json({
      success: true,
      data: {
        message: 'Email verified successfully',
        token: jwtToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tier: user.tier,
          role: user.role,
          emailVerified: true,
        },
      },
    });
  } catch (err: any) {
    logger.error('Email verification error', { error: err.message });
    res.status(500).json({ success: false, error: 'Email verification failed' });
  }
});

// ─── POST /resend-verification ──────────────────────────────────────────────
// Resend verification email — requires JWT auth.

router.post('/resend-verification', requireAuth, async (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const user = getUserById(userId);

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (user.emailVerified) {
      res.json({ success: true, data: { message: 'Email is already verified' } });
      return;
    }

    // Generate new verification token (invalidates any previous ones)
    const verifyToken = createEmailVerificationToken(user.id, user.email);
    const sent = await sendVerificationEmail(user.email, verifyToken, user.name);

    if (!sent) {
      logger.error('Failed to resend verification email', { userId: user.id, email: user.email });
      res.status(500).json({ success: false, error: 'Failed to send verification email' });
      return;
    }

    logger.info('Verification email resent', { userId: user.id, email: user.email });

    res.json({
      success: true,
      data: { message: 'Verification email sent. Please check your inbox.' },
    });
  } catch (err: any) {
    logger.error('Resend verification error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to resend verification email' });
  }
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
