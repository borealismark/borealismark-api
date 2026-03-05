import Database from 'better-sqlite3';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../middleware/logger';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'borealismark.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      version TEXT NOT NULL DEFAULT '1.0.0',
      registered_at INTEGER NOT NULL,
      registrant_key_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS audit_certificates (
      certificate_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_version TEXT NOT NULL,
      audit_id TEXT NOT NULL UNIQUE,
      issued_at INTEGER NOT NULL,
      audit_period_start INTEGER NOT NULL,
      audit_period_end INTEGER NOT NULL,
      score_total INTEGER NOT NULL,
      score_json TEXT NOT NULL,
      credit_rating TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      certificate_hash TEXT NOT NULL,
      hcs_topic_id TEXT,
      hcs_transaction_id TEXT,
      hcs_sequence_number INTEGER,
      hcs_consensus_timestamp TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS stakes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      bmt_amount REAL NOT NULL,
      usdc_coverage REAL NOT NULL,
      tier TEXT NOT NULL,
      allocated_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS slash_events (
      id TEXT PRIMARY KEY,
      stake_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      violation_type TEXT NOT NULL,
      amount_slashed REAL NOT NULL,
      claimant_address TEXT NOT NULL,
      executed_at INTEGER NOT NULL,
      hcs_transaction_id TEXT,
      FOREIGN KEY (stake_id) REFERENCES stakes(id)
    );

    -- ── Users ─────────────────────────────────────────────────────────────────
    -- Registered platform users with tier-gated dashboard access
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL DEFAULT 'standard',        -- standard | pro | elite
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER,
      email_verified INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_stripe ON users(stripe_customer_id);

    -- ── API Keys (production-grade) ──────────────────────────────────────────
    -- key_hash: SHA-256 of the raw key — raw key never stored
    -- scopes: comma-separated list e.g. "audit,read,webhook"
    -- last_used_at, usage_count: for dashboards and abuse detection
    -- expires_at: optional TTL in epoch ms (NULL = never expires)
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT 'audit,read',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      usage_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER,
      revoked_reason TEXT
    );

    -- ── Webhooks ─────────────────────────────────────────────────────────────
    -- Each registered URL receives signed HTTP POST payloads for subscribed events.
    -- secret: HMAC-SHA256 signing secret (stored raw for signing; raw returned once on creation)
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      owner_key_id TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL,          -- comma-separated event types
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_delivery_at INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (owner_key_id) REFERENCES api_keys(id)
    );

    -- ── Webhook Deliveries ───────────────────────────────────────────────────
    -- Tracks every outbound delivery attempt for observability and retry logic.
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      http_status INTEGER,
      response_body TEXT,
      delivered_at INTEGER NOT NULL,
      duration_ms INTEGER,
      success INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
    );

    -- ── Indices ──────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_certs_agent ON audit_certificates(agent_id);
    CREATE INDEX IF NOT EXISTS idx_certs_issued ON audit_certificates(issued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stakes_agent ON stakes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_webhooks_owner ON webhooks(owner_key_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_event ON webhook_deliveries(event_type);
  `);

  // Migrate: add new columns to api_keys if upgrading from old schema
  const keyColumns = (db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).map(r => r.name);
  if (!keyColumns.includes('scopes'))        db.exec("ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'audit,read'");
  if (!keyColumns.includes('last_used_at'))  db.exec("ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER");
  if (!keyColumns.includes('usage_count'))   db.exec("ALTER TABLE api_keys ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0");
  if (!keyColumns.includes('expires_at'))    db.exec("ALTER TABLE api_keys ADD COLUMN expires_at INTEGER");
  if (!keyColumns.includes('revoked_at'))    db.exec("ALTER TABLE api_keys ADD COLUMN revoked_at INTEGER");
  if (!keyColumns.includes('revoked_reason')) db.exec("ALTER TABLE api_keys ADD COLUMN revoked_reason TEXT");

  // Ensure the master API key exists with full admin scopes
  const masterKey = process.env.API_MASTER_KEY;
  if (!masterKey) {
    logger.warn('API_MASTER_KEY not set — master key will not be seeded. Set this env var in production.');
    return;
  }
  const masterKeyHash = createHash('sha256').update(masterKey).digest('hex');
  const existing = db.prepare('SELECT id, scopes FROM api_keys WHERE key_hash = ?').get(masterKeyHash) as { id: string; scopes: string } | undefined;
  if (!existing) {
    db.prepare(
      'INSERT INTO api_keys (id, key_hash, name, scopes, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(uuidv4(), masterKeyHash, 'Master Key', 'audit,read,webhook,admin', Date.now());
  } else if (!existing.scopes.includes('admin')) {
    // Upgrade legacy master key to full admin scopes
    db.prepare('UPDATE api_keys SET scopes = ? WHERE id = ?')
      .run('audit,read,webhook,admin', existing.id);
  }
}

// ─── User Queries ─────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  tier: 'standard' | 'pro' | 'elite';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  emailVerified: boolean;
  active: boolean;
}

function rowToUser(row: Record<string, unknown>): UserRecord {
  return {
    id: row.id as string,
    email: row.email as string,
    name: (row.name as string) ?? '',
    tier: (row.tier as 'standard' | 'pro' | 'elite') ?? 'standard',
    stripeCustomerId: row.stripe_customer_id as string | null,
    stripeSubscriptionId: row.stripe_subscription_id as string | null,
    createdAt: row.created_at as number,
    lastLoginAt: row.last_login_at as number | null,
    emailVerified: (row.email_verified as number) === 1,
    active: (row.active as number) === 1,
  };
}

export function createUser(
  id: string,
  email: string,
  passwordHash: string,
  name: string,
): void {
  getDb()
    .prepare(
      'INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, email.toLowerCase().trim(), passwordHash, name.trim(), Date.now());
}

export function getUserByEmail(email: string): (UserRecord & { passwordHash: string }) | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE email = ? AND active = 1')
    .get(email.toLowerCase().trim()) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...rowToUser(row), passwordHash: row.password_hash as string };
}

export function getUserById(id: string): UserRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE id = ? AND active = 1')
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToUser(row);
}

export function updateUserLogin(id: string): void {
  getDb()
    .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .run(Date.now(), id);
}

export function updateUserTier(id: string, tier: 'standard' | 'pro' | 'elite'): void {
  getDb()
    .prepare('UPDATE users SET tier = ? WHERE id = ?')
    .run(tier, id);
}

export function updateUserStripe(
  id: string,
  stripeCustomerId: string,
  stripeSubscriptionId?: string,
): void {
  getDb()
    .prepare('UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?')
    .run(stripeCustomerId, stripeSubscriptionId ?? null, id);
}

export function getUserByStripeCustomerId(customerId: string): UserRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE stripe_customer_id = ? AND active = 1')
    .get(customerId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToUser(row);
}

// ─── Agent Queries ────────────────────────────────────────────────────────────

export function registerAgent(
  id: string,
  name: string,
  description: string,
  version: string,
  registrantKeyId: string,
): void {
  getDb()
    .prepare(
      'INSERT INTO agents (id, name, description, version, registered_at, registrant_key_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, name, description, version, Date.now(), registrantKeyId);
}

export function getAgent(id: string): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

// ─── Certificate Queries ──────────────────────────────────────────────────────

export function saveCertificate(cert: {
  certificateId: string;
  agentId: string;
  agentVersion: string;
  auditId: string;
  issuedAt: number;
  auditPeriodStart: number;
  auditPeriodEnd: number;
  scoreTotal: number;
  scoreJson: string;
  creditRating: string;
  inputHash: string;
  certificateHash: string;
  hcsTopicId?: string;
  hcsTransactionId?: string;
  hcsSequenceNumber?: number;
  hcsConsensusTimestamp?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO audit_certificates
        (certificate_id, agent_id, agent_version, audit_id, issued_at, audit_period_start,
         audit_period_end, score_total, score_json, credit_rating, input_hash, certificate_hash,
         hcs_topic_id, hcs_transaction_id, hcs_sequence_number, hcs_consensus_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cert.certificateId,
      cert.agentId,
      cert.agentVersion,
      cert.auditId,
      cert.issuedAt,
      cert.auditPeriodStart,
      cert.auditPeriodEnd,
      cert.scoreTotal,
      cert.scoreJson,
      cert.creditRating,
      cert.inputHash,
      cert.certificateHash,
      cert.hcsTopicId ?? null,
      cert.hcsTransactionId ?? null,
      cert.hcsSequenceNumber ?? null,
      cert.hcsConsensusTimestamp ?? null,
    );
}

export function getLatestCertificate(agentId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare(
      'SELECT * FROM audit_certificates WHERE agent_id = ? AND revoked = 0 ORDER BY issued_at DESC LIMIT 1',
    )
    .get(agentId) as Record<string, unknown> | undefined;
}

export function getCertificateById(certId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare('SELECT * FROM audit_certificates WHERE certificate_id = ?')
    .get(certId) as Record<string, unknown> | undefined;
}

export function updateCertificateHCS(
  auditId: string,
  hcsTopicId: string,
  hcsTransactionId: string,
  hcsSequenceNumber: number,
  hcsConsensusTimestamp: string,
): void {
  getDb()
    .prepare(
      `UPDATE audit_certificates
       SET hcs_topic_id = ?, hcs_transaction_id = ?, hcs_sequence_number = ?, hcs_consensus_timestamp = ?
       WHERE audit_id = ?`,
    )
    .run(hcsTopicId, hcsTransactionId, hcsSequenceNumber, hcsConsensusTimestamp, auditId);
}

// ─── Staking Queries ──────────────────────────────────────────────────────────

export function allocateStake(
  id: string,
  agentId: string,
  bmtAmount: number,
  usdcCoverage: number,
  tier: string,
): void {
  getDb().prepare('UPDATE stakes SET active = 0 WHERE agent_id = ?').run(agentId);
  getDb()
    .prepare(
      'INSERT INTO stakes (id, agent_id, bmt_amount, usdc_coverage, tier, allocated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, agentId, bmtAmount, usdcCoverage, tier, Date.now());
}

export function getActiveStake(agentId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare('SELECT * FROM stakes WHERE agent_id = ? AND active = 1')
    .get(agentId) as Record<string, unknown> | undefined;
}

export function recordSlash(
  id: string,
  stakeId: string,
  agentId: string,
  violationType: string,
  amountSlashed: number,
  claimantAddress: string,
  hcsTransactionId?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO slash_events (id, stake_id, agent_id, violation_type, amount_slashed, claimant_address, executed_at, hcs_transaction_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, stakeId, agentId, violationType, amountSlashed, claimantAddress, Date.now(), hcsTransactionId ?? null);
  getDb().prepare('UPDATE stakes SET active = 0 WHERE id = ?').run(stakeId);
}

// ─── API Key Queries ──────────────────────────────────────────────────────────

/**
 * Validates a raw API key and — if valid — bumps usage stats.
 * Returns the full key row so route handlers can check scopes.
 */
export function validateApiKey(rawKey: string): {
  id: string;
  name: string;
  scopes: string[];
} | null {
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const now = Date.now();
  const row = getDb()
    .prepare(
      `SELECT id, name, scopes FROM api_keys
       WHERE key_hash = ?
         AND revoked = 0
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(keyHash, now) as { id: string; name: string; scopes: string } | undefined;

  if (!row) return null;

  // Non-blocking usage tracking
  getDb()
    .prepare('UPDATE api_keys SET last_used_at = ?, usage_count = usage_count + 1 WHERE id = ?')
    .run(now, row.id);

  return { id: row.id, name: row.name, scopes: row.scopes.split(',').map(s => s.trim()) };
}

/**
 * Creates a new API key.
 * Returns the raw key (only shown once) and its metadata.
 * If expiresAt is not provided, defaults to 1 year from now.
 */
export function createApiKey(
  name: string,
  scopes: string[],
  expiresAt?: number,
): { id: string; rawKey: string; name: string; scopes: string[]; createdAt: number; expiresAt: number | null } {
  const rawKey = `bmk_${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const id = uuidv4();
  const createdAt = Date.now();
  // Default to 365 days from now if not provided
  const finalExpiresAt = expiresAt ?? (createdAt + 365 * 24 * 60 * 60 * 1000);

  getDb()
    .prepare(
      'INSERT INTO api_keys (id, key_hash, name, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, keyHash, name, scopes.join(','), createdAt, finalExpiresAt);

  return { id, rawKey, name, scopes, createdAt, expiresAt: finalExpiresAt };
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  usageCount: number;
  expiresAt: number | null;
  revoked: boolean;
  revokedAt: number | null;
  revokedReason: string | null;
}

export function listApiKeys(): ApiKeyRecord[] {
  const rows = getDb()
    .prepare(
      'SELECT id, name, scopes, created_at, last_used_at, usage_count, expires_at, revoked, revoked_at, revoked_reason FROM api_keys ORDER BY created_at DESC',
    )
    .all() as Array<{
      id: string; name: string; scopes: string; created_at: number;
      last_used_at: number | null; usage_count: number; expires_at: number | null;
      revoked: number; revoked_at: number | null; revoked_reason: string | null;
    }>;

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    scopes: r.scopes.split(',').map(s => s.trim()),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    usageCount: r.usage_count,
    expiresAt: r.expires_at,
    revoked: r.revoked === 1,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
  }));
}

export function revokeApiKey(id: string, reason?: string): boolean {
  const result = getDb()
    .prepare(
      'UPDATE api_keys SET revoked = 1, revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked = 0',
    )
    .run(Date.now(), reason ?? null, id);
  return result.changes > 0;
}

// ─── Webhook Queries ──────────────────────────────────────────────────────────

export interface WebhookRecord {
  id: string;
  ownerKeyId: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: number;
  lastDeliveryAt: number | null;
  failureCount: number;
}

/**
 * Creates a new webhook registration.
 * Returns the raw secret (for HMAC signing); stored raw for use during dispatch.
 */
export function createWebhook(
  ownerKeyId: string,
  url: string,
  events: string[],
): { id: string; rawSecret: string } {
  const rawSecret = randomBytes(32).toString('hex');
  const id = uuidv4();

  getDb()
    .prepare(
      'INSERT INTO webhooks (id, owner_key_id, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, ownerKeyId, url, rawSecret, events.join(','), Date.now());

  return { id, rawSecret };
}

export function listWebhooks(ownerKeyId: string): WebhookRecord[] {
  const rows = getDb()
    .prepare(
      'SELECT id, owner_key_id, url, events, active, created_at, last_delivery_at, failure_count FROM webhooks WHERE owner_key_id = ? ORDER BY created_at DESC',
    )
    .all(ownerKeyId) as Array<{
      id: string; owner_key_id: string; url: string; events: string; active: number;
      created_at: number; last_delivery_at: number | null; failure_count: number;
    }>;

  return rows.map(r => ({
    id: r.id,
    ownerKeyId: r.owner_key_id,
    url: r.url,
    events: r.events.split(',').map(s => s.trim()),
    active: r.active === 1,
    createdAt: r.created_at,
    lastDeliveryAt: r.last_delivery_at,
    failureCount: r.failure_count,
  }));
}

export function deleteWebhook(id: string, ownerKeyId: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM webhooks WHERE id = ? AND owner_key_id = ?')
    .run(id, ownerKeyId);
  return result.changes > 0;
}

/**
 * Returns all active webhooks subscribed to a given event type.
 * Used by the webhook dispatcher to find delivery targets.
 * Escapes LIKE wildcards in eventType to prevent injection.
 */
export function getWebhooksForEvent(eventType: string): Array<{
  id: string;
  url: string;
  secret: string;
}> {
  // Escape LIKE wildcards to prevent pattern injection
  const escaped = eventType.replace(/%/g, '\\%').replace(/_/g, '\\_');

  const rows = getDb()
    .prepare(
      `SELECT id, url, secret FROM webhooks
       WHERE active = 1
         AND (events LIKE ? ESCAPE '\\' OR events LIKE ? ESCAPE '\\' OR events LIKE ? ESCAPE '\\' OR events = ?)`,
    )
    .all(
      `${escaped},%`,   // starts with
      `%,${escaped},%`, // middle
      `%,${escaped}`,   // ends with
      eventType,        // exact match (only subscriber)
    ) as Array<{ id: string; url: string; secret: string }>;

  return rows.map(r => ({ id: r.id, url: r.url, secret: r.secret }));
}

export function recordWebhookDelivery(
  webhookId: string,
  eventType: string,
  payload: string,
  success: boolean,
  httpStatus?: number,
  responseBody?: string,
  durationMs?: number,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, http_status, response_body, delivered_at, duration_ms, success)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv4(),
    webhookId,
    eventType,
    payload,
    httpStatus ?? null,
    responseBody ?? null,
    Date.now(),
    durationMs ?? null,
    success ? 1 : 0,
  );

  if (!success) {
    db.prepare('UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?').run(webhookId);
    // Auto-disable after 10 consecutive failures to prevent hammering dead endpoints
    const hook = db.prepare('SELECT failure_count FROM webhooks WHERE id = ?').get(webhookId) as { failure_count: number } | undefined;
    if (hook && hook.failure_count >= 10) {
      db.prepare('UPDATE webhooks SET active = 0 WHERE id = ?').run(webhookId);
    }
  } else {
    // Reset failure count and update last delivery on success
    db.prepare('UPDATE webhooks SET failure_count = 0, last_delivery_at = ? WHERE id = ?').run(Date.now(), webhookId);
  }
}

// ─── Global Stats ─────────────────────────────────────────────────────────────

export function getGlobalStats(): {
  totalMarks: number;
  totalAgents: number;
  avgScore: number;
  ratingDistribution: Record<string, number>;
} {
  const db = getDb();
  const totalMarks = (db.prepare('SELECT COUNT(*) as c FROM audit_certificates WHERE revoked = 0').get() as { c: number }).c;
  const totalAgents = (db.prepare('SELECT COUNT(*) as c FROM agents WHERE active = 1').get() as { c: number }).c;
  const avgScoreRow = db.prepare('SELECT AVG(score_total) as avg FROM audit_certificates WHERE revoked = 0').get() as { avg: number | null };
  const avgScore = Math.round(avgScoreRow.avg ?? 0);

  const ratingRows = db
    .prepare(
      'SELECT credit_rating, COUNT(*) as count FROM audit_certificates WHERE revoked = 0 GROUP BY credit_rating',
    )
    .all() as Array<{ credit_rating: string; count: number }>;

  const ratingDistribution: Record<string, number> = {};
  for (const row of ratingRows) {
    ratingDistribution[row.credit_rating] = row.count;
  }

  return { totalMarks, totalAgents, avgScore, ratingDistribution };
}
