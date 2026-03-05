import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

// ─── Log Levels ───────────────────────────────────────────────────────────────

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  requestId?: string;
  service: string;
  message: string;
  [key: string]: unknown;
}

// ─── Core Logger ──────────────────────────────────────────────────────────────

const SERVICE = 'BorealisMark-API';

function emit(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    level,
    timestamp: new Date().toISOString(),
    service: SERVICE,
    message,
    ...fields,
  };

  // In production emit compact JSON; in dev emit readable
  if (process.env.NODE_ENV === 'production') {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const { level, timestamp, message, requestId, ...rest } = entry;
    const rid = requestId ? ` [${requestId.slice(0, 8)}]` : '';
    const ts = timestamp.slice(11, 23); // HH:MM:SS.mmm
    const extras = Object.keys(rest).filter(k => k !== 'service').length
      ? ' ' + JSON.stringify(rest)
      : '';
    const COLOR: Record<LogLevel, string> = {
      DEBUG: '\x1b[36m', INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m',
    };
    console.log(`${COLOR[level]}[${level}]\x1b[0m ${ts}${rid} ${message}${extras}`);
  }
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('DEBUG', message, fields),
  info:  (message: string, fields?: Record<string, unknown>) => emit('INFO',  message, fields),
  warn:  (message: string, fields?: Record<string, unknown>) => emit('WARN',  message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('ERROR', message, fields),

  /** Bind a request ID to every subsequent log call in this scope */
  withReqId: (requestId: string) => ({
    debug: (msg: string, f?: Record<string, unknown>) => emit('DEBUG', msg, { requestId, ...f }),
    info:  (msg: string, f?: Record<string, unknown>) => emit('INFO',  msg, { requestId, ...f }),
    warn:  (msg: string, f?: Record<string, unknown>) => emit('WARN',  msg, { requestId, ...f }),
    error: (msg: string, f?: Record<string, unknown>) => emit('ERROR', msg, { requestId, ...f }),
  }),
};

// ─── Request Logging Middleware ───────────────────────────────────────────────

/**
 * Attaches a unique X-Request-Id to every request and logs:
 *   → incoming  (method, path, ip, api-key last 6 chars)
 *   ← outgoing  (status, latency ms)
 *
 * The request ID is forwarded to the client via the X-Request-Id response header
 * so operators can correlate client-side errors with server logs instantly.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = uuidv4();
  const startMs = Date.now();

  // Attach to request so route handlers can reference it
  (req as Request & { requestId: string }).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const rawKey = (req.headers['x-api-key'] as string) ??
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined);

  const keyHint = rawKey ? `****${rawKey.slice(-6)}` : 'unauthenticated';

  emit('INFO', `→ ${req.method} ${req.path}`, {
    requestId,
    ip: req.ip ?? req.socket.remoteAddress,
    key: keyHint,
    contentLength: req.headers['content-length'] ?? 0,
  });

  res.on('finish', () => {
    const ms = Date.now() - startMs;
    const level: LogLevel = res.statusCode >= 500 ? 'ERROR'
      : res.statusCode >= 400 ? 'WARN'
      : 'INFO';

    emit(level, `← ${req.method} ${req.path} ${res.statusCode}`, {
      requestId,
      status: res.statusCode,
      latencyMs: ms,
    });
  });

  next();
}

// ─── Audit Trail Logger ───────────────────────────────────────────────────────

/**
 * Writes a structured audit trail entry for security-sensitive operations.
 * These are the events that prove accountability — who did what and when.
 */
export function auditLog(
  action: string,
  actor: string,
  details: Record<string, unknown>,
  requestId?: string,
): void {
  emit('INFO', `AUDIT: ${action}`, {
    audit: true,
    action,
    actor,
    requestId,
    ...details,
  });
}
