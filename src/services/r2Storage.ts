/**
 * BorealisMark — Cloudflare R2 Storage Service
 *
 * Centralized service for managing file uploads to Cloudflare R2.
 * Supports three upload categories:
 *   - documents: Government ID uploads (max 10MB)
 *   - uploads: General images and assets (max 5MB)
 *   - backups: Database snapshots (max 100MB)
 *
 * Environment Variables:
 *   R2_ACCOUNT_ID: Cloudflare Account ID
 *   R2_ACCESS_KEY_ID: S3-compatible access key
 *   R2_SECRET_ACCESS_KEY: S3-compatible secret key
 *   R2_BUCKET_NAME: R2 bucket name
 *   R2_PUBLIC_URL: Public URL for accessing files (e.g., https://images.borealismark.com)
 */

import { readFile } from 'fs/promises';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '../middleware/logger';

// ─── Type Definitions ──────────────────────────────────────────────────────

export interface UploadOptions {
  data: Buffer;
  key: string;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface UploadResult {
  key: string;
  url: string;
  size: number;
}

export type UploadCategory = 'documents' | 'uploads' | 'backups';

// ─── Configuration ────────────────────────────────────────────────────────

const MAX_FILE_SIZES: Record<UploadCategory, number> = {
  documents: 10 * 1024 * 1024, // 10MB for government IDs
  uploads: 5 * 1024 * 1024,    // 5MB for general images
  backups: 100 * 1024 * 1024,  // 100MB for database snapshots
};

const ALLOWED_CONTENT_TYPES: Record<UploadCategory, string[]> = {
  documents: ['image/jpeg', 'image/png', 'application/pdf'],
  uploads: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  backups: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
};

// ─── Client Management ────────────────────────────────────────────────────

let s3Client: S3Client | null = null;

/**
 * Check if R2 storage is enabled by verifying all required environment variables.
 * @returns True if all R2 configuration is present
 */
export function isR2Enabled(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

/**
 * Get or initialize the S3 client for R2.
 * Returns null if R2 is not configured.
 * @returns S3Client or null
 */
export function getR2Client(): S3Client | null {
  if (!isR2Enabled()) return null;

  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }

  return s3Client;
}

// ─── URL Management ──────────────────────────────────────────────────────

/**
 * Construct the public URL for a file in R2.
 * Uses R2_PUBLIC_URL if configured, falls back to default R2 endpoint.
 * @param key The object key in R2
 * @returns The public URL
 */
export function constructPublicUrl(key: string): string {
  if (process.env.R2_PUBLIC_URL) {
    return `${process.env.R2_PUBLIC_URL}/${key}`;
  }
  return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET_NAME}/${key}`;
}

/**
 * Generate a signed URL for private documents (government IDs).
 * This constructs the public URL. For truly signed URLs with expiry,
 * install @aws-sdk/s3-request-presigner if needed in the future.
 * @param key The object key in R2
 * @returns The public URL (for private docs, restrict via bucket policies)
 */
export function getSignedUrl(key: string): string {
  // Note: For expiring signed URLs, implement with @aws-sdk/s3-request-presigner
  // For now, returns public URL (bucket policy should restrict access to documents/)
  return constructPublicUrl(key);
}

// ─── Upload Functions ────────────────────────────────────────────────────

/**
 * Upload a file to R2 with validation based on upload category.
 * @param category The upload category (documents, uploads, backups)
 * @param options Upload options containing data, key, contentType, and optional metadata
 * @returns Upload result with key, URL, and size
 * @throws Error if R2 is not configured, validation fails, or upload fails
 */
export async function uploadToR2(
  category: UploadCategory,
  options: UploadOptions,
): Promise<UploadResult> {
  const client = getR2Client();
  if (!client) {
    const error = 'R2 is not configured. Set R2_* environment variables.';
    logger.error(error);
    throw new Error(error);
  }

  const { data, key, contentType, metadata } = options;
  const maxSize = MAX_FILE_SIZES[category];
  const allowedTypes = ALLOWED_CONTENT_TYPES[category];

  // Validate file size
  if (data.length > maxSize) {
    const error = `File too large for ${category} category. Maximum: ${maxSize / 1024 / 1024}MB, got: ${(data.length / 1024 / 1024).toFixed(2)}MB`;
    logger.warn('Upload size validation failed', { category, size: data.length, maxSize });
    throw new Error(error);
  }

  // Validate content type
  if (!allowedTypes.includes(contentType)) {
    const error = `Invalid content type for ${category}. Allowed: ${allowedTypes.join(', ')}`;
    logger.warn('Upload content-type validation failed', { category, contentType, allowedTypes });
    throw new Error(error);
  }

  try {
    const putCommand = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: data,
      ContentType: contentType,
      Metadata: metadata,
    });

    await client.send(putCommand);

    const url = constructPublicUrl(key);

    logger.info('File uploaded to R2', {
      category,
      key,
      size: data.length,
      contentType,
      publicUrl: url,
    });

    return { key, url, size: data.length };
  } catch (err) {
    logger.error('R2 upload failed', {
      category,
      key,
      error: String(err),
    });
    throw new Error(`R2 upload failed: ${String(err)}`);
  }
}

/**
 * Delete a file from R2.
 * @param key The object key to delete
 * @throws Error if R2 is not configured or deletion fails
 */
export async function deleteFromR2(key: string): Promise<void> {
  const client = getR2Client();
  if (!client) {
    const error = 'R2 is not configured.';
    logger.error(error);
    throw new Error(error);
  }

  try {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    });

    await client.send(deleteCommand);

    logger.info('File deleted from R2', { key });
  } catch (err) {
    logger.error('R2 deletion failed', { key, error: String(err) });
    throw new Error(`R2 deletion failed: ${String(err)}`);
  }
}

/**
 * Download a file from R2.
 * @param key The object key to download
 * @returns Buffer containing the file data
 * @throws Error if R2 is not configured or download fails
 */
export async function downloadFromR2(key: string): Promise<Buffer> {
  const client = getR2Client();
  if (!client) {
    const error = 'R2 is not configured.';
    logger.error(error);
    throw new Error(error);
  }

  try {
    const getCommand = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    });

    const response = await client.send(getCommand);
    const chunks: Uint8Array[] = [];

    if (response.Body) {
      for await (const chunk of response.Body) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      }
    }

    const buffer = Buffer.concat(chunks);
    logger.info('File downloaded from R2', { key, size: buffer.length });

    return buffer;
  } catch (err) {
    logger.error('R2 download failed', { key, error: String(err) });
    throw new Error(`R2 download failed: ${String(err)}`);
  }
}

// ─── Database Backup Upload ───────────────────────────────────────────────

/**
 * Upload a database backup file to R2.
 * Reads the file from disk and uploads to the 'backups/' prefix with timestamp.
 * @param filePath Absolute path to the backup file
 * @param originalFilename The original filename (for metadata)
 * @returns Upload result with key, URL, and size
 * @throws Error if file read fails, R2 is not configured, or upload fails
 */
export async function uploadDatabaseBackup(
  filePath: string,
  originalFilename: string = 'backup.sql.gz',
): Promise<UploadResult> {
  try {
    // Read file from disk
    const fileData = await readFile(filePath);

    // Generate key with timestamp for uniqueness
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const ext = originalFilename.split('.').pop() || 'gz';
    const key = `backups/${timestamp}-${originalFilename}`;

    // Determine content type
    let contentType = 'application/gzip';
    if (ext === 'sql') contentType = 'text/plain';
    if (ext === 'backup') contentType = 'application/octet-stream';

    const result = await uploadToR2('backups', {
      data: fileData,
      key,
      contentType,
      metadata: {
        'original-filename': originalFilename,
        'backup-timestamp': new Date().toISOString(),
      },
    });

    logger.info('Database backup uploaded to R2', {
      originalFilename,
      backupKey: key,
      size: fileData.length,
    });

    return result;
  } catch (err) {
    logger.error('Database backup upload failed', {
      filePath,
      originalFilename,
      error: String(err),
    });
    throw new Error(`Database backup upload failed: ${String(err)}`);
  }
}

/**
 * Get the health status of the R2 service.
 * @returns Object with R2 enabled status and configuration details
 */
export function getR2Status() {
  return {
    enabled: isR2Enabled(),
    accountId: process.env.R2_ACCOUNT_ID ?? null,
    bucketName: process.env.R2_BUCKET_NAME ?? null,
    publicUrl: process.env.R2_PUBLIC_URL ?? null,
    endpoint: isR2Enabled()
      ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : null,
  };
}
