/**
 * Turso (LibSQL) Database Client
 *
 * CORE PRINCIPLE: BorealisMark is the data layer, not the risk layer.
 * This persistent database ensures audit certificates, trust deposits,
 * and agent records survive deployments.
 *
 * Usage: Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN env vars to use Turso.
 * Falls back to local SQLite if not set.
 */
import { createClient, Client } from '@libsql/client';
import { logger } from '../middleware/logger';

let tursoClient: Client | null = null;

export function initTurso(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) throw new Error('TURSO_DATABASE_URL is required');

  tursoClient = createClient({
    url,
    authToken,
  });

  logger.info('Turso database connected', { url: url.replace(/\/\/.*@/, '//***@') });
  return tursoClient;
}

export function getTursoClient(): Client | null {
  return tursoClient;
}

export function isTursoEnabled(): boolean {
  return !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}
