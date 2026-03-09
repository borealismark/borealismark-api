/**
 * Image Upload & Serving via Cloudflare R2
 *
 * CORE PRINCIPLE: BorealisMark is the data layer, not the risk layer.
 * Images are served from R2 for reliable listing photos and agent avatars.
 *
 * Env vars required:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *   R2_PUBLIC_URL (e.g., https://images.borealismark.com)
 */
import { Router } from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { requireApiKey, requireScope } from '../middleware/auth';
import { logger } from '../middleware/logger';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Check if R2 is configured
function isR2Enabled(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

// Initialize S3 client for R2 (only if configured)
function getR2Client(): S3Client | null {
  if (!isR2Enabled()) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

// POST /v1/images/upload — Upload image to R2
router.post('/upload', requireApiKey, requireScope('write'), async (req, res) => {
  if (!isR2Enabled()) {
    res.status(503).json({
      success: false,
      error: 'Image hosting not configured. Set R2_* env vars.',
      timestamp: Date.now(),
    });
    return;
  }

  const authReq = req as AuthenticatedRequest;

  // Accept base64 encoded image in body
  const { data, filename, contentType } = req.body;

  if (!data || !filename) {
    res.status(400).json({
      success: false,
      error: 'Missing required fields: data (base64), filename',
      timestamp: Date.now(),
    });
    return;
  }

  // Validate content type
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const mimeType = contentType || 'image/jpeg';
  if (!allowedTypes.includes(mimeType)) {
    res.status(400).json({
      success: false,
      error: `Invalid content type. Allowed: ${allowedTypes.join(', ')}`,
      timestamp: Date.now(),
    });
    return;
  }

  // Validate file size (max 5MB)
  const buffer = Buffer.from(data, 'base64');
  const maxSize = 5 * 1024 * 1024;
  if (buffer.length > maxSize) {
    res.status(400).json({
      success: false,
      error: `File too large. Maximum size: 5MB, got: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
      timestamp: Date.now(),
    });
    return;
  }

  // Generate unique key
  const ext = mimeType.split('/')[1] || 'jpg';
  const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  try {
    const s3 = getR2Client();
    if (!s3) {
      res.status(503).json({
        success: false,
        error: 'Image hosting not available',
        timestamp: Date.now(),
      });
      return;
    }

    // Upload to R2 using S3 client
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      })
    );

    const publicUrl = process.env.R2_PUBLIC_URL
      ? `${process.env.R2_PUBLIC_URL}/${key}`
      : `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET_NAME}/${key}`;

    logger.info('Image uploaded to R2', {
      key,
      size: buffer.length,
      uploadedBy: authReq.apiKey.id,
    });

    res.status(201).json({
      success: true,
      data: {
        key,
        url: publicUrl,
        size: buffer.length,
        contentType: mimeType,
        uploadedAt: Date.now(),
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('R2 upload failed', { error: String(err), key });
    res.status(500).json({
      success: false,
      error: 'Image upload failed',
      timestamp: Date.now(),
    });
  }
});

// GET /v1/images/status — Check R2 configuration
router.get('/status', requireApiKey, (req, res) => {
  res.json({
    success: true,
    data: {
      r2Enabled: isR2Enabled(),
      publicUrl: process.env.R2_PUBLIC_URL || null,
      bucketName: process.env.R2_BUCKET_NAME || null,
    },
    timestamp: Date.now(),
  });
});

export default router;
