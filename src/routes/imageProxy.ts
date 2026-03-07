/**
 * BorealisMark — Image Proxy & Caching Service
 *
 * Proxies and caches images from external sources (eBay, etc.) to:
 *   - Reduce external bandwidth costs
 *   - Improve image delivery performance
 *   - Allow for image transformation/optimization later
 *   - Protect against external URL expiration
 *
 *   GET /v1/images/proxy    — Fetch and cache image from external URL
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { createHash } from 'crypto';
import { logger } from '../middleware/logger';

const router = Router();

// ─── Config ──────────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(process.env.DATA_DIR ?? './data', 'image-cache');
const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
const REQUEST_TIMEOUT = 10000; // 10 seconds
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

// Allowed image content types
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

// ─── Initialization ──────────────────────────────────────────────────────────

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  logger.info('Created image cache directory', { cachePath: CACHE_DIR });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a deterministic filename hash from a URL
 */
function getCacheFilename(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex');
  return hash.substring(0, 32); // Use first 32 chars of hash for reasonable filename length
}

/**
 * Get the full cache file path for a URL
 */
function getCacheFilePath(url: string): string {
  const filename = getCacheFilename(url);
  return path.join(CACHE_DIR, filename);
}

/**
 * Check if a cached file exists and is still fresh
 */
function isCacheFresh(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    const age = Date.now() - stats.mtimeMs;
    return age < CACHE_MAX_AGE;
  } catch {
    return false;
  }
}

/**
 * Fetch image from external URL with timeout and size limits
 */
function fetchImage(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const req = protocol.get(url, { timeout: REQUEST_TIMEOUT }, (res) => {
      // Check for successful response
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      // Validate content type
      const contentType = res.headers['content-type']?.toLowerCase() ?? '';
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        reject(new Error(`Invalid content type: ${contentType}`));
        return;
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;

      res.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_IMAGE_SIZE) {
          req.destroy();
          reject(new Error(`Image exceeds maximum size of ${MAX_IMAGE_SIZE} bytes`));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

// ─── GET /v1/images/proxy ────────────────────────────────────────────────────

router.get('/proxy', async (req: Request, res: Response) => {
  try {
    const { url } = req.query;

    // Validate URL parameter
    if (!url || typeof url !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid "url" query parameter',
      });
      return;
    }

    // Validate URL format
    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch {
      res.status(400).json({
        success: false,
        error: 'Invalid URL format',
      });
      return;
    }

    // Only allow http and https
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      res.status(400).json({
        success: false,
        error: 'Only http and https URLs are allowed',
      });
      return;
    }

    const cacheFilePath = getCacheFilePath(url);

    // Check cache first
    if (isCacheFresh(cacheFilePath)) {
      try {
        const buffer = fs.readFileSync(cacheFilePath);

        // Detect content type from cache (we know it's valid from when we cached it)
        res.setHeader('Content-Type', 'image/*');
        res.setHeader('Cache-Control', `public, max-age=${CACHE_MAX_AGE / 1000}, immutable`);
        res.setHeader('X-Cache', 'HIT');
        res.send(buffer);

        logger.info('Served cached image', {
          url,
          cacheHit: true,
          size: buffer.length,
        });
        return;
      } catch (err: any) {
        logger.warn('Failed to read cached image', {
          url,
          error: err.message,
        });
        // Fall through to re-fetch
      }
    }

    // Fetch from external source
    try {
      const buffer = await fetchImage(url);

      // Cache the image
      try {
        fs.writeFileSync(cacheFilePath, buffer);
        logger.info('Cached new image', {
          url,
          size: buffer.length,
        });
      } catch (err: any) {
        logger.warn('Failed to cache image', {
          url,
          error: err.message,
        });
        // Still serve the image even if caching failed
      }

      // Serve the image
      res.setHeader('Content-Type', 'image/*');
      res.setHeader('Cache-Control', `public, max-age=${CACHE_MAX_AGE / 1000}, immutable`);
      res.setHeader('X-Cache', 'MISS');
      res.send(buffer);

      logger.info('Fetched and served image', {
        url,
        size: buffer.length,
      });
    } catch (err: any) {
      logger.error('Failed to fetch image', {
        url,
        error: err.message,
      });

      res.status(502).json({
        success: false,
        error: 'Failed to fetch image from external source',
        details: err.message,
      });
    }
  } catch (err: any) {
    logger.error('Image proxy error', {
      error: err.message,
      stack: err.stack,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

export default router;
