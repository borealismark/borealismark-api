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
import https from 'https';
import http from 'http';
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
import { uploadToR2, isR2Enabled } from '../services/r2Storage';
import { sendAdminVerificationNotification, sendVerificationResultEmail } from '../services/email';

const router = Router();

// ─── v44: Claude Vision API for Gov ID First-Pass Analysis ──────────────────

/**
 * Use Claude Vision to analyze a government ID image for:
 * - Document type detection (passport, drivers license, national ID)
 * - Readability assessment (is text visible? is photo clear?)
 * - Potential fraud indicators (obvious photoshop, screen photo, etc.)
 * - Extracted fields (name, DOB, ID number — partially redacted in logs)
 *
 * Returns analysis result. Non-blocking — failures don't prevent upload.
 */
async function analyzeDocumentWithVision(
  imageBase64: string,
  documentType: string,
  country: string,
): Promise<{ passed: boolean; confidence: number; analysis: string; flags: string[] }> {
  const defaultResult = { passed: true, confidence: 0, analysis: 'Vision analysis unavailable', flags: [] };

  if (!process.env.ANTHROPIC_API_KEY) {
    return defaultResult;
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Strip data URL prefix if present
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = imageBase64.match(/^data:image\/([\w+]+);/)?.[1] || 'jpeg';

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: `image/${mediaType}` as any,
              data: cleanBase64,
            },
          },
          {
            type: 'text',
            text: `You are a document verification assistant for BorealisMark, a trust certification platform. Analyze this government ID image.

Expected document type: ${documentType}
Expected country: ${country}

Evaluate and respond in JSON format ONLY:
{
  "passed": true/false,
  "confidence": 0-100,
  "documentTypeMatch": true/false,
  "readability": "good" | "fair" | "poor",
  "flags": ["list", "of", "concerns"],
  "summary": "Brief assessment"
}

Check for:
1. Is this actually a government-issued ID? (not a business card, student ID, etc.)
2. Does the document type match what was declared?
3. Is the image readable (not blurry, not too dark, text visible)?
4. Are there obvious signs of tampering (visible editing artifacts, screen photo of a photo, etc.)?
5. Does it appear to be from the declared country?

Do NOT extract or output any PII (names, numbers, dates). Focus on document quality and legitimacy assessment only.
Return ONLY the JSON object, no other text.`,
          },
        ],
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Vision API returned non-JSON response');
      return defaultResult;
    }

    const result = JSON.parse(jsonMatch[0]);

    logger.info('Document vision analysis complete', {
      passed: result.passed,
      confidence: result.confidence,
      readability: result.readability,
      flags: result.flags?.length || 0,
    });

    return {
      passed: result.passed ?? true,
      confidence: result.confidence ?? 0,
      analysis: result.summary || 'Analysis complete',
      flags: result.flags || [],
    };
  } catch (err: any) {
    logger.error('Vision API analysis error', { error: err.message });
    return defaultResult;
  }
}

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
  const platformGuides: Record<string, { name: string; steps: string }> = {
    facebook: {
      name: 'Facebook',
      steps: `1. Go to your Facebook profile and create a new public post.\n` +
        `2. Paste the verification code below as the post content:\n\n   ${code}\n\n` +
        `3. Set the post visibility to "Public" (globe icon).\n` +
        `4. Click "Post", then come back and click "Confirm".`,
    },
    linkedin: {
      name: 'LinkedIn',
      steps: `1. Go to your LinkedIn feed and click "Start a post".\n` +
        `2. Paste the verification code below:\n\n   ${code}\n\n` +
        `3. Set visibility to "Anyone" (public).\n` +
        `4. Click "Post", then come back and click "Confirm".`,
    },
    x: {
      name: 'X (Twitter)',
      steps: `1. Go to X.com and compose a new post (tweet).\n` +
        `2. Paste the verification code below:\n\n   ${code}\n\n` +
        `3. Ensure your account is not set to "Protected" (private).\n` +
        `4. Click "Post", then come back and click "Confirm".`,
    },
    instagram: {
      name: 'Instagram',
      steps: `1. Open Instagram and create a new Story or post.\n` +
        `2. Include the verification code below in the caption or as text on the Story:\n\n   ${code}\n\n` +
        `3. Ensure your account is set to "Public" (not private).\n` +
        `4. Publish, then come back and click "Confirm".`,
    },
    tiktok: {
      name: 'TikTok',
      steps: `1. Open TikTok and create a new video or text post.\n` +
        `2. Include the verification code below in the caption:\n\n   ${code}\n\n` +
        `3. Set the post to "Everyone" (public visibility).\n` +
        `4. Post it, then come back and click "Confirm".`,
    },
  };

  const guide = platformGuides[platform] || {
    name: platform,
    steps: `1. Post the code publicly on your ${platform} profile:\n\n   ${code}\n\n` +
      `2. Ensure the post is publicly visible.\n` +
      `3. Come back and click "Confirm".`,
  };

  return `To verify your ${guide.name} account:\n\n${guide.steps}\n\n` +
    `You can remove the post after verification is confirmed.\n` +
    `This code expires in 48 hours.`;
}

// ─── v44: Automated Social Media Verification Check ──────────────────────────

/**
 * Attempt to verify that a verification code appears on the user's public profile/posts.
 * Uses platform-specific API checks where possible, falls back to URL fetch.
 * Returns { found: boolean, method: string, confidence: 'high' | 'medium' | 'low' }
 */
async function checkSocialPostForCode(
  platform: string,
  profileUrl: string,
  verificationCode: string,
): Promise<{ found: boolean; method: string; confidence: 'high' | 'medium' | 'low' }> {
  try {
    // For X/Twitter, check via public API if available
    if (platform === 'x' && process.env.X_BEARER_TOKEN) {
      return await checkXPost(profileUrl, verificationCode);
    }

    // Generic HTTP fetch — try to find the code on the public profile page
    // This works for platforms that render post content in HTML (LinkedIn, Facebook public)
    return await checkViaHttpFetch(profileUrl, verificationCode);
  } catch (err: any) {
    logger.warn('Social verification check failed, falling back to manual', {
      platform, error: err.message,
    });
    return { found: false, method: 'error', confidence: 'low' };
  }
}

async function checkXPost(profileUrl: string, code: string): Promise<{ found: boolean; method: string; confidence: 'high' | 'medium' | 'low' }> {
  // Extract username from URL
  const match = profileUrl.match(/(?:x|twitter)\.com\/([^\/\?]+)/i);
  if (!match) return { found: false, method: 'x_api_no_username', confidence: 'low' };

  const username = match[1];
  const bearerToken = process.env.X_BEARER_TOKEN;

  try {
    // Search recent tweets from user containing the code
    const searchUrl = `https://api.twitter.com/2/tweets/search/recent?query=from:${username} "${code}"&max_results=10`;

    const response = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${bearerToken}` },
    });

    if (!response.ok) {
      logger.warn('X API request failed', { status: response.status });
      return { found: false, method: 'x_api_error', confidence: 'low' };
    }

    const data = await response.json() as any;
    const tweets = data.data || [];
    const found = tweets.some((tweet: any) => tweet.text?.includes(code));

    return { found, method: 'x_api', confidence: found ? 'high' : 'low' };
  } catch (err: any) {
    logger.error('X API check error', { error: err.message });
    return { found: false, method: 'x_api_error', confidence: 'low' };
  }
}

async function checkViaHttpFetch(profileUrl: string, code: string): Promise<{ found: boolean; method: string; confidence: 'high' | 'medium' | 'low' }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ found: false, method: 'http_timeout', confidence: 'low' });
    }, 10000);

    try {
      const urlObj = new URL(profileUrl);
      const protocol = urlObj.protocol === 'https:' ? https : http;

      const req = protocol.get(profileUrl, {
        headers: {
          'User-Agent': 'BorealisMark-Verification/1.0',
          'Accept': 'text/html',
        },
        timeout: 8000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          clearTimeout(timeout);
          const found = body.includes(code);
          resolve({
            found,
            method: 'http_fetch',
            confidence: found ? 'medium' : 'low',
          });
        });
      });

      req.on('error', () => {
        clearTimeout(timeout);
        resolve({ found: false, method: 'http_error', confidence: 'low' });
      });

      req.on('timeout', () => {
        req.destroy();
        clearTimeout(timeout);
        resolve({ found: false, method: 'http_timeout', confidence: 'low' });
      });
    } catch {
      clearTimeout(timeout);
      resolve({ found: false, method: 'http_exception', confidence: 'low' });
    }
  });
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

    // Check if initiated more than 48 hours ago (v38: shortened from 72h)
    const hoursElapsed = (Date.now() - verification.submittedAt) / (1000 * 60 * 60);
    if (hoursElapsed > 48) {
      updateVerificationStatus(verification.id, 'expired');
      return res.status(400).json({
        success: false,
        error: 'Verification code has expired (48-hour window). Please initiate a new verification.',
      });
    }

    // v44: Automated verification check — try to find the code on the profile
    const checkResult = await checkSocialPostForCode(
      verification.platform || 'unknown',
      verification.profileUrl || '',
      verification.verificationCode || '',
    );

    const autoApproved = checkResult.found && checkResult.confidence !== 'low';
    const reviewNotes = autoApproved
      ? `Auto-verified via ${checkResult.method} (confidence: ${checkResult.confidence}). Code found on public profile.`
      : `User confirmed post. Automated check: ${checkResult.method} (found: ${checkResult.found}, confidence: ${checkResult.confidence}). Pending admin spot-check.`;

    updateVerificationStatus(verification.id, 'verified', {
      trustPoints: TRUST_POINTS.SOCIAL_MEDIA,
      reviewNotes,
    });

    // Update metadata with check results
    try {
      const existingMeta = JSON.parse(verification.metadata || '{}');
      const updatedMeta = {
        ...existingMeta,
        automatedCheck: checkResult,
        autoApproved,
        confirmedAt: Date.now(),
      };
      const { getDb } = require('../db/database');
      getDb().prepare('UPDATE user_verifications SET metadata = ? WHERE id = ?')
        .run(JSON.stringify(updatedMeta), verification.id);
    } catch { /* non-critical */ }

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
    let documentStorageKey: string | null = null;
    let selfieStorageKey: string | null = null;

    // Upload documents to R2 if configured
    if (isR2Enabled()) {
      try {
        // Parse base64 data
        const docBase64 = documentImageBase64.replace(/^data:image\/\w+;base64,/, '');
        const docBuffer = Buffer.from(docBase64, 'base64');
        const docExt = documentImageBase64.match(/^data:image\/(\w+);/)?.[1] || 'jpg';
        const docKey = `gov-id/${userId}/${id}-document.${docExt}`;

        const docResult = await uploadToR2('documents', {
          data: docBuffer,
          key: docKey,
          contentType: `image/${docExt}`,
          metadata: { userId, verificationId: id, type: 'document' },
        });
        documentStorageKey = docResult.key;

        if (selfieImageBase64) {
          const selfieBase64 = selfieImageBase64.replace(/^data:image\/\w+;base64,/, '');
          const selfieBuffer = Buffer.from(selfieBase64, 'base64');
          const selfieExt = selfieImageBase64.match(/^data:image\/(\w+);/)?.[1] || 'jpg';
          const selfieKey = `gov-id/${userId}/${id}-selfie.${selfieExt}`;

          const selfieResult = await uploadToR2('documents', {
            data: selfieBuffer,
            key: selfieKey,
            contentType: `image/${selfieExt}`,
            metadata: { userId, verificationId: id, type: 'selfie' },
          });
          selfieStorageKey = selfieResult.key;
        }

        logger.info('Document images uploaded to R2', {
          userId, verificationId: id, documentKey: documentStorageKey, selfieKey: selfieStorageKey,
        });
      } catch (uploadErr: any) {
        logger.error('R2 upload failed for document verification', { error: uploadErr.message, userId });
        // Continue with metadata-only storage as fallback
      }
    }

    // v44: Run Claude Vision analysis (non-blocking — doesn't prevent upload)
    let visionAnalysis = { passed: true, confidence: 0, analysis: 'Analysis not run', flags: [] as string[] };
    try {
      visionAnalysis = await analyzeDocumentWithVision(documentImageBase64, documentType, country);
    } catch (visionErr: any) {
      logger.error('Vision analysis failed', { error: visionErr.message, userId });
    }

    const docMetadata = {
      documentType,
      country,
      hasSelfie: !!selfieImageBase64,
      submittedAt: Date.now(),
      imageSize: documentImageBase64.length,
      storageRef: documentStorageKey || `doc-${id}`,
      selfieStorageRef: selfieStorageKey || null,
      r2Enabled: isR2Enabled(),
      // v44: AI analysis results
      visionAnalysis: {
        passed: visionAnalysis.passed,
        confidence: visionAnalysis.confidence,
        summary: visionAnalysis.analysis,
        flags: visionAnalysis.flags,
        analyzedAt: Date.now(),
      },
    };

    createVerification({
      id,
      userId,
      verificationType: 'government_id',
      platform: 'government_id',
      trustPoints: TRUST_POINTS.GOVERNMENT_ID,
      metadata: JSON.stringify(docMetadata),
    });

    // Send admin notification about new verification request
    try {
      const user = getUserById(userId);
      if (user) {
        sendAdminVerificationNotification(
          user.email, user.name ?? user.email, userId, documentType, id
        ).catch(err => logger.error('Failed to send admin verification notification', { error: err.message }));
      }
    } catch (notifyErr: any) {
      logger.error('Admin notification error', { error: notifyErr.message });
    }

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

    const hederaPoints = trustScore.hederaTxCount * TRUST_POINTS.HEDERA_TX_BONUS;
    const stripePoints = trustScore.stripeTxCount * TRUST_POINTS.STRIPE_TX_BONUS;
    const transactionLayer = {
      type: 'transaction_history',
      count: trustScore.transactionCount,
      hederaTxCount: trustScore.hederaTxCount,
      stripeTxCount: trustScore.stripeTxCount,
      hederaPoints,
      stripePoints,
      points: Math.min(hederaPoints + stripePoints, TRUST_POINTS.TRANSACTION_MAX),
      maxPoints: TRUST_POINTS.TRANSACTION_MAX,
      description: `Hedera: ${trustScore.hederaTxCount} tx × ${TRUST_POINTS.HEDERA_TX_BONUS} pts | Stripe: ${trustScore.stripeTxCount} tx × ${TRUST_POINTS.STRIPE_TX_BONUS} pt`,
    };

    const accountAgeLayer = {
      type: 'active_engagement',
      activeLoginDays: trustScore.accountAgeDays,
      points: trustScore.accountAgeDays >= 180 ? TRUST_POINTS.ACTIVE_DAYS_180 :
              trustScore.accountAgeDays >= 90 ? TRUST_POINTS.ACTIVE_DAYS_90 :
              trustScore.accountAgeDays >= 30 ? TRUST_POINTS.ACTIVE_DAYS_30 : 0,
      maxPoints: TRUST_POINTS.ACTIVE_DAYS_180,
      description: 'Active login days (must log in on 30/90/180 distinct days to earn points)',
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
  // Iterate forward through levels to find the NEXT achievable level
  for (let i = 0; i < TRUST_LEVELS.length; i++) {
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

    // v38: Send verification result email to user
    try {
      const user = getUserById(verification.userId);
      if (user) {
        const typeLabel = verification.verificationType === 'government_id'
          ? 'Government ID'
          : `${verification.platform || 'Social Media'} Account`;
        sendVerificationResultEmail(
          user.email,
          user.name ?? user.email,
          decision === 'approved',
          typeLabel,
          notes,
          trustPoints,
        ).catch(err => logger.error('Failed to send verification result email', { error: err.message }));
      }
    } catch (emailErr: any) {
      logger.error('Verification result email error', { error: emailErr.message });
    }

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

// ─── GET /admin/stats — Verification Analytics (v38) ──────────────────────────

router.get('/admin/stats', requireAuth, (req: Request, res: Response) => {
  const { role } = (req as any).user;
  if (role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  try {
    const { getDb } = require('../db/database');
    const db = getDb();

    // Total verifications by type and status
    const byTypeAndStatus = db.prepare(`
      SELECT verification_type, status, COUNT(*) as count
      FROM user_verifications
      GROUP BY verification_type, status
    `).all() as Array<{ verification_type: string; status: string; count: number }>;

    // Trust level distribution across users
    const trustLevelDistribution = db.prepare(`
      SELECT trust_level, COUNT(*) as count
      FROM user_trust_scores
      GROUP BY trust_level
      ORDER BY total_score DESC
    `).all() as Array<{ trust_level: string; count: number }>;

    // Average trust score
    const avgScore = db.prepare(`
      SELECT AVG(total_score) as avg_score, MAX(total_score) as max_score, MIN(total_score) as min_score
      FROM user_trust_scores
    `).get() as { avg_score: number; max_score: number; min_score: number } | undefined;

    // Verifications in the last 7 days
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recentActivity = db.prepare(`
      SELECT verification_type, status, COUNT(*) as count
      FROM user_verifications
      WHERE submitted_at > ?
      GROUP BY verification_type, status
    `).all(sevenDaysAgo) as Array<{ verification_type: string; status: string; count: number }>;

    // Pending review queue size
    const pendingCount = db.prepare(`
      SELECT COUNT(*) as count FROM user_verifications WHERE status = 'pending'
    `).get() as { count: number };

    // Completion funnel: how many users have each layer
    const funnel = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM user_trust_scores WHERE email_verified = 1) as email_verified,
        (SELECT COUNT(*) FROM user_trust_scores WHERE social_verified > 0) as has_social,
        (SELECT COUNT(*) FROM user_trust_scores WHERE social_verified >= 3) as max_social,
        (SELECT COUNT(*) FROM user_trust_scores WHERE document_verified = 1) as has_gov_id,
        (SELECT COUNT(*) FROM user_trust_scores WHERE transaction_count > 0) as has_transactions,
        (SELECT COUNT(*) FROM user_trust_scores) as total_users
    `).get() as Record<string, number>;

    res.json({
      success: true,
      data: {
        overview: {
          totalUsers: funnel?.total_users || 0,
          pendingReviews: pendingCount?.count || 0,
          averageScore: Math.round(avgScore?.avg_score || 0),
          maxScore: avgScore?.max_score || 0,
        },
        byTypeAndStatus,
        trustLevelDistribution,
        recentActivity,
        completionFunnel: funnel,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    logger.error('Verification stats error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch verification stats' });
  }
});

// ─── Admin Document Viewing (v44) ───────────────────────────────────────────

// GET /admin/document/:verificationId — Get document image URL for admin review
router.get('/admin/document/:verificationId', requireAuth, async (req: Request, res: Response) => {
  const { role } = (req as any).user;
  if (role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  try {
    const verification = getVerificationById(req.params.verificationId);
    if (!verification) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }
    if (verification.verificationType !== 'government_id') {
      return res.status(400).json({ success: false, error: 'Not a document verification' });
    }

    const metadata = JSON.parse(verification.metadata || '{}');

    if (!metadata.storageRef || !isR2Enabled()) {
      return res.status(404).json({ success: false, error: 'Document not available — R2 storage not configured or document not uploaded' });
    }

    // Import download function
    const { downloadFromR2 } = require('../services/r2Storage');

    // Download document image from R2 and stream as response
    const documentBuffer = await downloadFromR2(metadata.storageRef);
    const ext = metadata.storageRef.split('.').pop() || 'jpg';
    const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="doc-${req.params.verificationId}.${ext}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(documentBuffer);
  } catch (err: any) {
    logger.error('Admin document retrieval error', { error: err.message, verificationId: req.params.verificationId });
    res.status(500).json({ success: false, error: 'Failed to retrieve document' });
  }
});

// GET /admin/document/:verificationId/selfie — Get selfie image for admin review
router.get('/admin/document/:verificationId/selfie', requireAuth, async (req: Request, res: Response) => {
  const { role } = (req as any).user;
  if (role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  try {
    const verification = getVerificationById(req.params.verificationId);
    if (!verification) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }

    const metadata = JSON.parse(verification.metadata || '{}');

    if (!metadata.selfieStorageRef || !isR2Enabled()) {
      return res.status(404).json({ success: false, error: 'Selfie not available' });
    }

    const { downloadFromR2 } = require('../services/r2Storage');
    const selfieBuffer = await downloadFromR2(metadata.selfieStorageRef);
    const ext = metadata.selfieStorageRef.split('.').pop() || 'jpg';
    const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="selfie-${req.params.verificationId}.${ext}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(selfieBuffer);
  } catch (err: any) {
    logger.error('Admin selfie retrieval error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to retrieve selfie' });
  }
});

// ─── Document Cleanup: Delete R2 objects for rejected verifications (v44) ────
async function cleanupRejectedDocuments(): Promise<void> {
  try {
    if (!isR2Enabled()) return;

    const { getDb } = require('../db/database');
    const { deleteFromR2 } = require('../services/r2Storage');
    const db = getDb();

    // Find rejected verifications older than 30 days with R2 storage refs
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const rejected = db.prepare(`
      SELECT id, metadata FROM user_verifications
      WHERE verification_type = 'government_id'
        AND status = 'rejected'
        AND verified_at < ?
    `).all(thirtyDaysAgo) as Array<{ id: string; metadata: string }>;

    let cleaned = 0;
    for (const v of rejected) {
      try {
        const meta = JSON.parse(v.metadata || '{}');
        if (meta.storageRef && meta.r2Enabled) {
          await deleteFromR2(meta.storageRef);
          if (meta.selfieStorageRef) await deleteFromR2(meta.selfieStorageRef);
          // Update metadata to mark as cleaned
          const updatedMeta = { ...meta, r2Cleaned: true, cleanedAt: Date.now() };
          db.prepare('UPDATE user_verifications SET metadata = ? WHERE id = ?')
            .run(JSON.stringify(updatedMeta), v.id);
          cleaned++;
        }
      } catch (cleanErr: any) {
        logger.error('Failed to clean up document', { verificationId: v.id, error: cleanErr.message });
      }
    }

    if (cleaned > 0) {
      logger.info('Cleaned up rejected verification documents from R2', { count: cleaned });
    }
  } catch (err: any) {
    logger.error('Document cleanup error', { error: err.message });
  }
}

// Run cleanup every 24 hours
setInterval(cleanupRejectedDocuments, 24 * 60 * 60 * 1000);
// Run once on startup after 2 minutes
setTimeout(cleanupRejectedDocuments, 120_000);

// ─── Auto-expire stale pending social verifications (v38) ─────────────────────

function sweepExpiredVerifications(): void {
  try {
    const { getDb } = require('../db/database');
    const db = getDb();
    const cutoff48h = Date.now() - (48 * 60 * 60 * 1000);

    const expired = db.prepare(`
      UPDATE user_verifications
      SET status = 'expired', verified_at = ?
      WHERE status = 'pending'
        AND verification_type = 'social_media'
        AND submitted_at < ?
    `).run(Date.now(), cutoff48h);

    if (expired.changes > 0) {
      logger.info('Auto-expired stale social verifications', { count: expired.changes });
    }
  } catch (err: any) {
    logger.error('Verification expiry sweep error', { error: err.message });
  }
}

// Run expiry sweep every 6 hours
setInterval(sweepExpiredVerifications, 6 * 60 * 60 * 1000);
// Run once on startup after a short delay
setTimeout(sweepExpiredVerifications, 30_000);

// ─── v44: Trust Score Leaderboard ─────────────────────────────────────────────

// GET /leaderboard — Public trust score rankings
router.get('/leaderboard', (_req: Request, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(_req.query.limit) || 25));
    const page = Math.max(1, Number(_req.query.page) || 1);
    const offset = (page - 1) * limit;

    const { getDb } = require('../db/database');
    const db = getDb();

    const leaderboard = db.prepare(`
      SELECT
        u.id as user_id,
        u.name,
        u.created_at as member_since,
        uts.total_score,
        uts.trust_level,
        uts.email_verified,
        uts.social_verified,
        uts.document_verified,
        uts.transaction_count,
        uts.hedera_tx_count,
        uts.stripe_tx_count,
        uts.account_age_days,
        sf.store_name,
        sf.slug as store_slug,
        (SELECT COUNT(*) FROM marketplace_listings ml WHERE ml.user_id = u.id AND ml.status = 'published') as active_listings,
        (SELECT COUNT(*) FROM marketplace_orders mo WHERE (mo.buyer_id = u.id OR mo.seller_id = u.id) AND mo.status = 'settled') as settled_orders
      FROM user_trust_scores uts
      JOIN users u ON uts.user_id = u.id
      LEFT JOIN seller_storefronts sf ON u.id = sf.user_id
      WHERE u.active = 1
        AND uts.total_score > 0
      ORDER BY uts.total_score DESC, uts.last_computed_at ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];

    const totalResult = db.prepare(`
      SELECT COUNT(*) as total FROM user_trust_scores uts
      JOIN users u ON uts.user_id = u.id
      WHERE u.active = 1 AND uts.total_score > 0
    `).get() as { total: number };

    // Add rank numbers
    const ranked = leaderboard.map((entry: any, idx: number) => ({
      rank: offset + idx + 1,
      userId: entry.user_id,
      name: entry.name || 'Anonymous',
      memberSince: entry.member_since,
      trustScore: entry.total_score,
      trustLevel: entry.trust_level,
      badges: {
        emailVerified: !!entry.email_verified,
        socialVerified: entry.social_verified,
        documentVerified: !!entry.document_verified,
      },
      stats: {
        transactionCount: entry.transaction_count,
        hederaTxCount: entry.hedera_tx_count,
        activeDays: entry.account_age_days,
        activeListings: entry.active_listings,
        settledOrders: entry.settled_orders,
      },
      storefront: entry.store_name ? {
        name: entry.store_name,
        slug: entry.store_slug,
      } : null,
    }));

    res.json({
      success: true,
      data: {
        leaderboard: ranked,
        pagination: {
          page,
          limit,
          total: totalResult.total,
          totalPages: Math.ceil(totalResult.total / limit),
        },
      },
    });
  } catch (err: any) {
    logger.error('Leaderboard error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

// GET /leaderboard/stats — Trust ecosystem summary stats
router.get('/leaderboard/stats', (_req: Request, res: Response) => {
  try {
    const { getDb } = require('../db/database');
    const db = getDb();

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_users,
        AVG(total_score) as avg_score,
        MAX(total_score) as max_score,
        SUM(CASE WHEN trust_level = 'elite' THEN 1 ELSE 0 END) as elite_count,
        SUM(CASE WHEN trust_level = 'premium' THEN 1 ELSE 0 END) as premium_count,
        SUM(CASE WHEN trust_level = 'trusted' THEN 1 ELSE 0 END) as trusted_count,
        SUM(CASE WHEN trust_level = 'verified' THEN 1 ELSE 0 END) as verified_count,
        SUM(CASE WHEN trust_level = 'basic' THEN 1 ELSE 0 END) as basic_count,
        SUM(CASE WHEN trust_level = 'unverified' THEN 1 ELSE 0 END) as unverified_count,
        SUM(CASE WHEN document_verified = 1 THEN 1 ELSE 0 END) as gov_id_verified,
        SUM(social_verified) as total_social_verifications,
        SUM(transaction_count) as total_transactions
      FROM user_trust_scores
    `).get() as any;

    res.json({
      success: true,
      data: {
        totalUsers: stats.total_users || 0,
        averageScore: Math.round(stats.avg_score || 0),
        maxScore: stats.max_score || 0,
        distribution: {
          elite: stats.elite_count || 0,
          premium: stats.premium_count || 0,
          trusted: stats.trusted_count || 0,
          verified: stats.verified_count || 0,
          basic: stats.basic_count || 0,
          unverified: stats.unverified_count || 0,
        },
        milestones: {
          govIdVerified: stats.gov_id_verified || 0,
          totalSocialVerifications: stats.total_social_verifications || 0,
          totalTransactions: stats.total_transactions || 0,
        },
      },
    });
  } catch (err: any) {
    logger.error('Leaderboard stats error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard stats' });
  }
});

export default router;
