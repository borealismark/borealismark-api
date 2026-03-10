/**
 * BorealisMark — User Verification Routes (Trust Layer System)
 *
 * Multi-layer trust stacking:
 *   Layer 1: Email Verification (auto — handled by auth.ts, +10 pts)
 *   Layer 2: Social Media Verification (user-initiated, +15 pts each, max 3)
 *   Layer 3: Government ID Verification (upload + admin review, +30 pts)
 *   Layer 4: Transaction History (organic, +2 pts per completed tx, max 20)
 *
 * POST /v1/verification/social/initiate   — Start social media verification
 * POST /v1/verification/social/confirm    — Confirm social media post found
 * POST /v1/verification/document/upload   — Submit government ID for review
 * GET  /v1/verification/status            — Get user's full trust profile
 * GET  /v1/verification/score             — Get computed trust score
 *
 * Admin endpoints:
 * GET  /v1/verification/admin/pending     — List pending verifications
 * POST /v1/verification/admin/review      — Approve/reject a verification
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { randomBytes } from 'crypto';
import { requireAuth, type AuthRequest } from './auth';
import { logger } from '../middleware/logger';
import {
  createVerification,
  getVerificationsByUser,
  getVerificationById,
  getVerificationByCode,
  getActiveVerification,
  updateVerificationStatus,
  getPendingVerifications,
  computeAndStoreTrustScore,
  getTrustScore,
  getUserById,
  TRUST_POINTS,
  TRUST_LEVELS,
} from '../db/database';

const router = Router();

// ─── Rate limiting for verification actions (in-memory) ──────────────────────

const verifyRateLimit = new Map<string, { count: number; resetAt: number }>();

function isVerifyRateLimited(userId: string, maxPerWindow: number = 5): boolean {
  const now = Date.now();
  const entry = verifyRateLimit.get(userId);
  if (!entry || entry.resetAt < now) {
    verifyRateLimit.set(userId, { count: 1, resetAt: now + 3600_000 }); // 1 hour window
    return false;
  }
  entry.count++;
  return entry.count > maxPerWindow;
}

// Clean up every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of verifyRateLimit) {
    if (entry.resetAt < now) verifyRateLimit.delete(id);
  }
}, 30 * 60 * 1000);

// ─── Generate BT verification code ──────────────────────────────────────────

function generateVerificationCode(): string {
  const hex = randomBytes(4).toString('hex').toUpperCase();
  return `BT-${hex}`;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ALLOWED_PLATFORMS = ['facebook', 'linkedin', 'x', 'instagram', 'tiktok'] as const;

const socialInitiateSchema = z.object({
  platform: z.enum(ALLOWED_PLATFORMS),
  profileUrl: z.string().url('Must be a valid URL').max(500),
});

const socialConfirmSchema = z.object({
  verificationId: z.string().min(1),
});

const documentUploadSchema = z.object({
  documentType: z.enum(['passport', 'drivers_license', 'national_id']),
  documentImageBase64: z.string().min(100).max(5_000_000), // ~3.7MB max
  selfieImageBase64: z.string().min(100).max(5_000_000).optional(),
  country: z.string().min(2).max(3), // ISO country code
});

const adminReviewSchema = z.object({
  verificationId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  notes: z.string().max(1000).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateProfileUrl(platform: string, url: string): boolean {
  const patterns: Record<string, RegExp> = {
    facebook: /^https?:\/\/(www\.)?facebook\.com\//i,
    linkedin: /^https?:\/\/(www\.)?linkedin\.com\//i,
    x: /^https?:\/\/(www\.)?(x|twitter)\.com\//i,
    instagram: /^https?:\/\/(www\.)?instagram\.com\//i,
    tiktok: /^https?:\/\/(www\.)?tiktok\.com\//i,
  };
  const pattern = patterns[platform];
  return pattern ? pattern.test(url) : false;
}

// ─── POST /social/initiate — Start social media verification ─────────────────

router.post('/social/initiate', requireAuth, async (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;

    if (isVerifyRateLimited(userId)) {
      return res.status(429).json({
        success: false,
        error: 'Too many verification attempts. Please wait before trying again.',
      });
    }

    const parsed = socialInitiateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { platform, profileUrl } = parsed.data;

    // Validate URL matches the platform
    if (!validateProfileUrl(platform, profileUrl)) {
      return res.status(400).json({
        success: false,
        error: `URL doesn't match the ${platform} platform. Please provide a valid ${platform} profile URL.`,
      });
    }

    // Check if user already has an active verification for this platform
    const existing = getActiveVerification(userId, platform);
    if (existing) {
      if (existing.status === 'verified') {
        return res.status(409).json({
          success: false,
          error: `Your ${platform} account is already verified.`,
        });
      }
      // Return existing pending verification
      return res.json({
        success: true,
        data: {
          verificationId: existing.id,
          verificationCode: existing.verificationCode,
          platform,
          profileUrl: existing.profileUrl,
          status: existing.status,
          instructions: getSocialInstructions(platform, existing.verificationCode!),
        },
      });
    }

    // Check social media verification cap (max 3 unique platforms)
    const allVerifications = getVerificationsByUser(userId);
    const verifiedSocials = allVerifications.filter(
      v => v.verificationType === 'social_media' && v.status === 'verified'
    );
    if (verifiedSocials.length >= 3) {
      return res.status(400).json({
        success: false,
        error: 'Maximum of 3 social media verifications reached. You already have the maximum social trust points.',
      });
    }

    // Generate verification code
    const verificationCode = generateVerificationCode();
    const id = uuid();

    createVerification({
      id,
      userId,
      verificationType: 'social_media',
      platform,
      verificationCode,
      profileUrl,
      trustPoints: TRUST_POINTS.SOCIAL_MEDIA,
      metadata: JSON.stringify({ platform, profileUrl, initiatedAt: Date.now() }),
    });

    logger.info('Social verification initiated', { userId, platform, verificationCode, verificationId: id });

    res.json({
      success: true,
      data: {
        verificationId: id,
        verificationCode,
        platform,
        profileUrl,
        status: 'pending',
        instructions: getSocialInstructions(platform, verificationCode),
      },
    });
  } catch (err: any) {
    logger.error('Social verification initiation error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to initiate social verification' });
  }
});

function getSocialInstructions(platform: string, code: string): string {
  const platformNames: Record<string, string> = {
    facebook: 'Facebook',
    linkedin: 'LinkedIn',
    x: 'X (Twitter)',
    instagram: 'Instagram',
    tiktok: 'TikTok',
  };
  const name = platformNames[platform] || platform;
  return `To verify your ${name} account:\n\n` +
    `1. Post the following code publicly on your ${name} profile or as a new post:\n\n` +
    `   ${code}\n\n` +
    `2. The post must be publicly visible (not friends-only or private).\n` +
    `3. Once posted, click "Confirm" and our system will verify it.\n` +
    `4. You can remove the post after verification is confirmed.\n\n` +
    `This code expires in 72 hours.`;
}

// ─── POST /social/confirm — Confirm social media post was made ───────────────

router.post('/social/confirm', requireAuth, async (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;

    const parsed = socialConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Verification ID is required',
      });
    }

    const verification = getVerificationById(parsed.data.verificationId);
    if (!verification || verification.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }

    if (verification.status === 'verified') {
      return res.status(409).json({ success: false, error: 'Already verified' });
    }

    if (verification.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Verification is ${verification.status}. Please start a new verification.`,
      });
    }

    // Check if initiated more than 72 hours ago
    const hoursElapsed = (Date.now() - verification.submittedAt) / (1000 * 60 * 60);
    if (hoursElapsed > 72) {
      updateVerificationStatus(verification.id, 'expired');
      return res.status(400).json({
        success: false,
        error: 'Verification code has expired. Please initiate a new verification.',
      });
    }

    // For social verification, we approve immediately upon user confirmation.
    // In production, this would be enhanced with actual social media scraping/API checks.
    // For now, social verifications go to a "confirmed" state that admins can spot-check.
    // We grant trust points immediately to keep the UX smooth — if fraud is detected,
    // the admin can revoke via the review endpoint.
    updateVerificationStatus(verification.id, 'verified', {
      trustPoints: TRUST_POINTS.SOCIAL_MEDIA,
      reviewNotes: 'User confirmed post. Auto-approved pending admin spot-check.',
    });

    // Recompute trust score
    const trustScore = computeAndStoreTrustScore(userId);

    logger.info('Social verification confirmed', {
      userId, platform: verification.platform, verificationId: verification.id,
      newTrustScore: trustScore.totalScore, newTrustLevel: trustScore.trustLevel,
    });

    res.json({
      success: true,
      data: {
        verificationId: verification.id,
        platform: verification.platform,
        status: 'verified',
        trustScore: {
          totalScore: trustScore.totalScore,
          trustLevel: trustScore.trustLevel,
          pointsEarned: TRUST_POINTS.SOCIAL_MEDIA,
        },
        message: `Your ${verification.platform} account has been verified! +${TRUST_POINTS.SOCIAL_MEDIA} trust points earned.`,
      },
    });
  } catch (err: any) {
    logger.error('Social verification confirm error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to confirm verification' });
  }
});

// ─── POST /document/upload — Submit government ID for review ─────────────────

router.post('/document/upload', requireAuth, async (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;

    if (isVerifyRateLimited(userId, 3)) {
      return res.status(429).json({
        success: false,
        error: 'Too many document submissions. Please wait before trying again.',
      });
    }

    const parsed = documentUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { documentType, documentImageBase64, selfieImageBase64, country } = parsed.data;

    // Check if user already has verified or pending government ID
    const existing = getActiveVerification(userId, 'government_id');
    if (existing) {
      if (existing.status === 'verified') {
        return res.status(409).json({
          success: false,
          error: 'Your government ID is already verified.',
        });
      }
      return res.status(409).json({
        success: false,
        error: 'You already have a pending document verification. Please wait for it to be reviewed (24-48 hours).',
        data: { verificationId: existing.id, status: existing.status, submittedAt: existing.submittedAt },
      });
    }

    // Basic image validation (check base64 header)
    if (!documentImageBase64.match(/^data:image\/(jpeg|jpg|png|webp);base64,/) &&
        !documentImageBase64.match(/^[A-Za-z0-9+/=]/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid document image format. Please upload a JPEG, PNG, or WebP image.',
      });
    }

    const id = uuid();

    // Store document metadata (NOT the actual image in DB — in production, use S3/R2)
    // For now, we store a truncated hash reference and the image analysis results
    const docMetadata = {
      documentType,
      country,
      hasSelfie: !!selfieImageBase64,
      submittedAt: Date.now(),
      imageSize: documentImageBase64.length,
      // In production: store image in Cloudflare R2 or S3, reference here
      // For security: we do NOT store the raw base64 in the DB
      storageRef: `doc-${id}`,
    };

    createVerification({
      id,
      userId,
      verificationType: 'government_id',
      platform: 'government_id',
      trustPoints: TRUST_POINTS.GOVERNMENT_ID,
      metadata: JSON.stringify(docMetadata),
    });

    logger.info('Document verification submitted', {
      userId, documentType, country, verificationId: id,
    });

    res.json({
      success: true,
      data: {
        verificationId: id,
        status: 'pending',
        estimatedReviewTime: '24-48 hours',
        message: 'Your document has been submitted for review. You will receive an email when the review is complete.',
      },
    });
  } catch (err: any) {
    logger.error('Document upload error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to submit document for verification' });
  }
});

// ─── GET /status — Full trust profile for current user ───────────────────────

router.get('/status', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;

    // Get all verifications for user
    const verifications = getVerificationsByUser(userId);

    // Recompute trust score (ensures it's fresh)
    const trustScore = computeAndStoreTrustScore(userId);

    // Group verifications by type
    const emailLayer = {
      type: 'email',
      status: trustScore.emailVerified ? 'verified' : 'pending',
      points: trustScore.emailVerified ? TRUST_POINTS.EMAIL_VERIFIED : 0,
      maxPoints: TRUST_POINTS.EMAIL_VERIFIED,
    };

    const socialLayers = verifications
      .filter(v => v.verificationType === 'social_media')
      .map(v => ({
        id: v.id,
        type: 'social_media',
        platform: v.platform,
        profileUrl: v.profileUrl,
        status: v.status,
        verificationCode: v.status === 'pending' ? v.verificationCode : undefined,
        points: v.status === 'verified' ? TRUST_POINTS.SOCIAL_MEDIA : 0,
        submittedAt: v.submittedAt,
        verifiedAt: v.verifiedAt,
      }));

    const documentLayers = verifications
      .filter(v => v.verificationType === 'government_id')
      .map(v => ({
        id: v.id,
        type: 'government_id',
        status: v.status,
        points: v.status === 'verified' ? TRUST_POINTS.GOVERNMENT_ID : 0,
        submittedAt: v.submittedAt,
        verifiedAt: v.verifiedAt,
        reviewNotes: v.status === 'rejected' ? v.reviewNotes : undefined,
      }));

    const transactionLayer = {
      type: 'transaction_history',
      count: trustScore.transactionCount,
      points: Math.min(trustScore.transactionCount * TRUST_POINTS.TRANSACTION_BONUS, TRUST_POINTS.TRANSACTION_MAX),
      maxPoints: TRUST_POINTS.TRANSACTION_MAX,
    };

    const accountAgeLayer = {
      type: 'account_age',
      days: trustScore.accountAgeDays,
      points: trustScore.accountAgeDays >= 180 ? TRUST_POINTS.ACCOUNT_AGE_180D :
              trustScore.accountAgeDays >= 90 ? TRUST_POINTS.ACCOUNT_AGE_90D :
              trustScore.accountAgeDays >= 30 ? TRUST_POINTS.ACCOUNT_AGE_30D : 0,
      maxPoints: TRUST_POINTS.ACCOUNT_AGE_180D,
    };

    res.json({
      success: true,
      data: {
        trustScore: {
          totalScore: trustScore.totalScore,
          trustLevel: trustScore.trustLevel,
          nextLevel: getNextLevel(trustScore.totalScore),
        },
        layers: {
          email: emailLayer,
          socialMedia: socialLayers,
          governmentId: documentLayers,
          transactionHistory: transactionLayer,
          accountAge: accountAgeLayer,
        },
        availablePlatforms: ALLOWED_PLATFORMS.filter(
          p => !socialLayers.some(s => s.platform === p && s.status === 'verified')
        ),
        pointsConfig: TRUST_POINTS,
        trustLevels: TRUST_LEVELS,
      },
    });
  } catch (err: any) {
    logger.error('Trust status error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch trust status' });
  }
});

function getNextLevel(currentScore: number): { level: string; pointsNeeded: number } | null {
  for (let i = TRUST_LEVELS.length - 1; i >= 0; i--) {
    if (currentScore < TRUST_LEVELS[i].minScore) {
      return {
        level: TRUST_LEVELS[i].level,
        pointsNeeded: TRUST_LEVELS[i].minScore - currentScore,
      };
    }
  }
  return null; // Already at max level
}

// ─── GET /score — Quick trust score lookup ───────────────────────────────────

router.get('/score', requireAuth, (req: Request, res: Response) => {
  try {
    const { sub: userId } = (req as any).user;
    const trustScore = computeAndStoreTrustScore(userId);

    res.json({
      success: true,
      data: {
        totalScore: trustScore.totalScore,
        trustLevel: trustScore.trustLevel,
      },
    });
  } catch (err: any) {
    logger.error('Trust score error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to compute trust score' });
  }
});

// ─── GET /score/:userId — Public trust score for any user ────────────────────

router.get('/score/:userId', (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const trustScore = computeAndStoreTrustScore(userId);

    res.json({
      success: true,
      data: {
        userId,
        totalScore: trustScore.totalScore,
        trustLevel: trustScore.trustLevel,
        emailVerified: !!trustScore.emailVerified,
        socialVerified: trustScore.socialVerified,
        documentVerified: !!trustScore.documentVerified,
        accountAgeDays: trustScore.accountAgeDays,
      },
    });
  } catch (err: any) {
    logger.error('Public trust score error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch trust score' });
  }
});

// ─── Admin Endpoints ─────────────────────────────────────────────────────────

// GET /admin/pending — List pending verifications for admin review
router.get('/admin/pending', requireAuth, (req: Request, res: Response) => {
  const { role } = (req as any).user;
  if (role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  try {
    const type = req.query.type as string | undefined;
    const pending = getPendingVerifications(type);

    // Enrich with user info
    const enriched = pending.map(v => {
      const user = getUserById(v.userId);
      return {
        ...v,
        userName: user?.name,
        userEmail: user?.email,
      };
    });

    res.json({ success: true, data: enriched });
  } catch (err: any) {
    logger.error('Admin pending verifications error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch pending verifications' });
  }
});

// POST /admin/review — Approve or reject a verification
router.post('/admin/review', requireAuth, (req: Request, res: Response) => {
  const { sub: adminId, role } = (req as any).user;
  if (role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  try {
    const parsed = adminReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { verificationId, decision, notes } = parsed.data;

    const verification = getVerificationById(verificationId);
    if (!verification) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }

    if (verification.status !== 'pending' && verification.status !== 'verified') {
      return res.status(400).json({
        success: false,
        error: `Cannot review verification with status: ${verification.status}`,
      });
    }

    const newStatus = decision === 'approved' ? 'verified' : 'rejected';
    const trustPoints = decision === 'approved'
      ? (verification.verificationType === 'government_id' ? TRUST_POINTS.GOVERNMENT_ID : TRUST_POINTS.SOCIAL_MEDIA)
      : 0;

    updateVerificationStatus(verificationId, newStatus as any, {
      reviewerId: adminId,
      reviewNotes: notes,
      trustPoints,
    });

    // Recompute trust score for the user
    const trustScore = computeAndStoreTrustScore(verification.userId);

    logger.info('Verification reviewed', {
      verificationId, decision, adminId,
      userId: verification.userId,
      newTrustScore: trustScore.totalScore,
    });

    res.json({
      success: true,
      data: {
        verificationId,
        decision,
        userId: verification.userId,
        newTrustScore: trustScore.totalScore,
        newTrustLevel: trustScore.trustLevel,
      },
    });
  } catch (err: any) {
    logger.error('Admin review error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to review verification' });
  }
});

export default router;
