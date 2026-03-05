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
      role TEXT NOT NULL DEFAULT 'user',             -- user | admin
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

    -- ── Terminal Marketplace ────────────────────────────────────────────────
    -- Service listings: agents publish services other agents can hire
    CREATE TABLE IF NOT EXISTS terminal_services (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      price_usdc REAL NOT NULL,
      min_trust_score INTEGER NOT NULL DEFAULT 0,
      capabilities TEXT NOT NULL DEFAULT '[]',
      max_concurrent_jobs INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- Contracts: when one agent hires another through the marketplace
    CREATE TABLE IF NOT EXISTS terminal_contracts (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      provider_agent_id TEXT NOT NULL,
      requester_agent_id TEXT NOT NULL,
      job_description TEXT,
      agreed_price REAL NOT NULL,
      network_fee REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (service_id) REFERENCES terminal_services(id),
      FOREIGN KEY (provider_agent_id) REFERENCES agents(id),
      FOREIGN KEY (requester_agent_id) REFERENCES agents(id)
    );

    -- ── USDC Invoices (persistent payment tracking) ─────────────────────────
    CREATE TABLE IF NOT EXISTS usdc_invoices (
      invoice_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      email TEXT,
      agent_id TEXT,
      amount_usd REAL NOT NULL,
      amount_usdc TEXT NOT NULL,
      treasury_account_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      memo TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      hedera_transaction_id TEXT,
      from_account TEXT,
      consensus_timestamp TEXT,
      hcs_topic_id TEXT,
      hcs_sequence_number INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      confirmed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_usdc_invoices_status ON usdc_invoices(status);
    CREATE INDEX IF NOT EXISTS idx_usdc_invoices_email ON usdc_invoices(email);
    CREATE INDEX IF NOT EXISTS idx_usdc_invoices_memo ON usdc_invoices(memo);

    -- ── Contract Ratings (bidirectional) ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS contract_ratings (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      rater_agent_id TEXT NOT NULL,
      rated_agent_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT,
      hcs_transaction_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(contract_id, rater_agent_id),
      FOREIGN KEY (contract_id) REFERENCES terminal_contracts(id)
    );

    -- ── Contract Deposits (escrow tracking) ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS contract_deposits (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      party TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      amount_usdc REAL NOT NULL,
      memo TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      hedera_transaction_id TEXT,
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      FOREIGN KEY (contract_id) REFERENCES terminal_contracts(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- ── Marketplace Listings (user-posted buy/sell/trade) ───────────────────
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      listing_type TEXT NOT NULL DEFAULT 'sell',
      category TEXT NOT NULL,
      price_usdc REAL,
      trade_for TEXT,
      images TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending_audit',
      audit_id TEXT,
      assigned_agent_id TEXT,
      view_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      published_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_listings_user ON marketplace_listings(user_id);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON marketplace_listings(status);
    CREATE INDEX IF NOT EXISTS idx_listings_type ON marketplace_listings(listing_type);
    CREATE INDEX IF NOT EXISTS idx_listings_category ON marketplace_listings(category);

    -- ── Listing Audit Queue ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS listing_audits (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      auditor_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_listing_audits_status ON listing_audits(status);
    CREATE INDEX IF NOT EXISTS idx_listing_audits_listing ON listing_audits(listing_id);

    -- ── Message Threads (DM / negotiation) ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS message_threads (
      id TEXT PRIMARY KEY,
      listing_id TEXT,
      contract_id TEXT,
      participant_a TEXT NOT NULL,
      participant_b TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_threads_participants ON message_threads(participant_a, participant_b);
    CREATE INDEX IF NOT EXISTS idx_threads_listing ON message_threads(listing_id);
    CREATE INDEX IF NOT EXISTS idx_threads_contract ON message_threads(contract_id);

    -- ── Messages ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES message_threads(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

    -- ── Prohibited Items & Content Moderation ────────────────────────────────
    CREATE TABLE IF NOT EXISTS prohibited_items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      keyword TEXT NOT NULL COLLATE NOCASE,
      severity TEXT NOT NULL DEFAULT 'block',       -- block | flag | warn
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prohibited_keyword ON prohibited_items(keyword);
    CREATE INDEX IF NOT EXISTS idx_prohibited_category ON prohibited_items(category);
    CREATE INDEX IF NOT EXISTS idx_prohibited_active ON prohibited_items(active);

    CREATE TABLE IF NOT EXISTS moderation_logs (
      id TEXT PRIMARY KEY,
      listing_id TEXT,
      user_id TEXT,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      matched_keywords TEXT,                        -- JSON array of matched keywords
      severity TEXT NOT NULL,
      automated INTEGER NOT NULL DEFAULT 1,
      reviewer_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_moderation_listing ON moderation_logs(listing_id);
    CREATE INDEX IF NOT EXISTS idx_moderation_user ON moderation_logs(user_id);

    -- ── User Listing Limits Tracking ───────────────────────────────────────────
    -- (Tracked via marketplace_listings count per user, no extra table needed)

    -- ── Indices ──────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_certs_agent ON audit_certificates(agent_id);
    CREATE INDEX IF NOT EXISTS idx_certs_issued ON audit_certificates(issued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stakes_agent ON stakes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_webhooks_owner ON webhooks(owner_key_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_event ON webhook_deliveries(event_type);
    CREATE INDEX IF NOT EXISTS idx_terminal_services_category ON terminal_services(category);
    CREATE INDEX IF NOT EXISTS idx_terminal_services_agent ON terminal_services(agent_id);
    CREATE INDEX IF NOT EXISTS idx_terminal_services_status ON terminal_services(status);
    CREATE INDEX IF NOT EXISTS idx_terminal_contracts_service ON terminal_contracts(service_id);
    CREATE INDEX IF NOT EXISTS idx_terminal_contracts_provider ON terminal_contracts(provider_agent_id);
    CREATE INDEX IF NOT EXISTS idx_terminal_contracts_requester ON terminal_contracts(requester_agent_id);
    CREATE INDEX IF NOT EXISTS idx_terminal_contracts_status ON terminal_contracts(status);

    -- ── Password Reset Tokens ────────────────────────────────────────────────
    -- Secure token-based password reset: token_hash stores SHA-256, never raw
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_prt_token ON password_reset_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_prt_expires ON password_reset_tokens(expires_at);
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
  role: 'user' | 'admin';
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
    role: (row.role as 'user' | 'admin') ?? 'user',
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
  role: 'user' | 'admin' = 'user',
  tier: 'standard' | 'pro' | 'elite' = 'standard',
): void {
  getDb()
    .prepare(
      'INSERT INTO users (id, email, password_hash, name, role, tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, email.toLowerCase().trim(), passwordHash, name.trim(), role, tier, Date.now());
}

export function updateUserRole(id: string, role: 'user' | 'admin'): void {
  getDb()
    .prepare('UPDATE users SET role = ? WHERE id = ?')
    .run(role, id);
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

// ─── Password Reset Token Queries ────────────────────────────────────────────

export interface PasswordResetTokenRecord {
  id: string;
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

/**
 * Create a password reset token. Returns the raw token (sent in the email link).
 * Only the SHA-256 hash is stored in the database.
 */
export function createPasswordResetToken(userId: string, email: string): string {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const id = uuidv4();
  const now = Date.now();
  const expiresAt = now + 60 * 60 * 1000; // 1 hour

  // Invalidate any existing unused tokens for this user
  getDb()
    .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .run(now, userId);

  getDb()
    .prepare(
      'INSERT INTO password_reset_tokens (id, user_id, email, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, userId, email.toLowerCase().trim(), tokenHash, expiresAt, now);

  return rawToken;
}

/**
 * Look up a reset token by its raw value (hashes it to match the DB).
 * Returns null if not found, already used, or expired.
 */
export function getValidPasswordResetToken(rawToken: string): PasswordResetTokenRecord | null {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const row = getDb()
    .prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .get(tokenHash, Date.now()) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    email: row.email as string,
    tokenHash: row.token_hash as string,
    expiresAt: row.expires_at as number,
    usedAt: row.used_at as number | null,
    createdAt: row.created_at as number,
  };
}

/**
 * Mark a token as used (one-time use).
 */
export function markPasswordResetTokenUsed(tokenId: string): void {
  getDb()
    .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?')
    .run(Date.now(), tokenId);
}

/**
 * Update a user's password hash.
 */
export function updateUserPassword(userId: string, passwordHash: string): void {
  getDb()
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(passwordHash, userId);
}

/**
 * Clean up expired tokens (housekeeping).
 */
export function deleteExpiredPasswordResetTokens(): number {
  const result = getDb()
    .prepare('DELETE FROM password_reset_tokens WHERE expires_at < ? OR used_at IS NOT NULL')
    .run(Date.now() - 24 * 60 * 60 * 1000); // Keep used tokens for 24h audit trail
  return result.changes;
}

// ─── USDC Invoice Queries ────────────────────────────────────────────────────

export interface UsdcInvoiceRecord {
  invoiceId: string;
  planId: string;
  email: string | null;
  agentId: string | null;
  amountUsd: number;
  amountUsdc: string;
  treasuryAccountId: string;
  tokenId: string;
  memo: string;
  status: 'pending' | 'confirmed' | 'expired' | 'failed';
  hederaTransactionId: string | null;
  fromAccount: string | null;
  consensusTimestamp: string | null;
  hcsTopicId: string | null;
  hcsSequenceNumber: number | null;
  createdAt: number;
  expiresAt: number;
  confirmedAt: number | null;
}

export function saveUsdcInvoice(invoice: {
  invoiceId: string;
  planId: string;
  email?: string;
  agentId?: string;
  amountUsd: number;
  amountUsdc: string;
  treasuryAccountId: string;
  tokenId: string;
  memo: string;
  expiresAt: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO usdc_invoices
        (invoice_id, plan_id, email, agent_id, amount_usd, amount_usdc,
         treasury_account_id, token_id, memo, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      invoice.invoiceId, invoice.planId, invoice.email ?? null, invoice.agentId ?? null,
      invoice.amountUsd, invoice.amountUsdc, invoice.treasuryAccountId, invoice.tokenId,
      invoice.memo, Date.now(), invoice.expiresAt,
    );
}

export function getUsdcInvoice(invoiceId: string): UsdcInvoiceRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM usdc_invoices WHERE invoice_id = ?')
    .get(invoiceId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    invoiceId: row.invoice_id as string,
    planId: row.plan_id as string,
    email: row.email as string | null,
    agentId: row.agent_id as string | null,
    amountUsd: row.amount_usd as number,
    amountUsdc: row.amount_usdc as string,
    treasuryAccountId: row.treasury_account_id as string,
    tokenId: row.token_id as string,
    memo: row.memo as string,
    status: row.status as UsdcInvoiceRecord['status'],
    hederaTransactionId: row.hedera_transaction_id as string | null,
    fromAccount: row.from_account as string | null,
    consensusTimestamp: row.consensus_timestamp as string | null,
    hcsTopicId: row.hcs_topic_id as string | null,
    hcsSequenceNumber: row.hcs_sequence_number as number | null,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    confirmedAt: row.confirmed_at as number | null,
  };
}

export function updateUsdcInvoiceStatus(
  invoiceId: string,
  status: UsdcInvoiceRecord['status'],
): void {
  getDb()
    .prepare('UPDATE usdc_invoices SET status = ? WHERE invoice_id = ?')
    .run(status, invoiceId);
}

export function confirmUsdcInvoice(
  invoiceId: string,
  transactionId: string,
  fromAccount: string,
  consensusTimestamp: string,
  hcsTopicId?: string,
  hcsSequenceNumber?: number,
): void {
  getDb()
    .prepare(
      `UPDATE usdc_invoices SET
        status = 'confirmed',
        hedera_transaction_id = ?,
        from_account = ?,
        consensus_timestamp = ?,
        hcs_topic_id = ?,
        hcs_sequence_number = ?,
        confirmed_at = ?
       WHERE invoice_id = ?`,
    )
    .run(
      transactionId, fromAccount, consensusTimestamp,
      hcsTopicId ?? null, hcsSequenceNumber ?? null,
      Date.now(), invoiceId,
    );
}

export function cleanupExpiredUsdcInvoices(): number {
  const result = getDb()
    .prepare("UPDATE usdc_invoices SET status = 'expired' WHERE status = 'pending' AND expires_at < ?")
    .run(Date.now());
  return result.changes;
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

// ─── Prohibited Items / Content Moderation ─────────────────────────────────

export interface ProhibitedItem {
  id: string;
  category: string;
  keyword: string;
  severity: 'block' | 'flag' | 'warn';
  description: string | null;
  active: boolean;
  createdAt: number;
}

export function addProhibitedItem(
  id: string,
  category: string,
  keyword: string,
  severity: 'block' | 'flag' | 'warn',
  description?: string,
): void {
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO prohibited_items (id, category, keyword, severity, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    )
    .run(id, category, keyword.toLowerCase().trim(), severity, description ?? null, now, now);
}

export function getActiveProhibitedItems(): ProhibitedItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM prohibited_items WHERE active = 1')
    .all() as any[];
  return rows.map(r => ({
    id: r.id,
    category: r.category,
    keyword: r.keyword,
    severity: r.severity,
    description: r.description,
    active: r.active === 1,
    createdAt: r.created_at,
  }));
}

export function removeProhibitedItem(id: string): boolean {
  const result = getDb()
    .prepare('UPDATE prohibited_items SET active = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
  return result.changes > 0;
}

export function logModeration(
  id: string,
  listingId: string | null,
  userId: string | null,
  action: string,
  reason: string,
  matchedKeywords: string[],
  severity: string,
  automated: boolean,
  reviewerId?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO moderation_logs (id, listing_id, user_id, action, reason, matched_keywords, severity, automated, reviewer_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, listingId, userId, action, reason, JSON.stringify(matchedKeywords), severity, automated ? 1 : 0, reviewerId ?? null, Date.now());
}

export function getUserActiveListingCount(userId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as c FROM marketplace_listings WHERE user_id = ? AND status NOT IN ('rejected', 'removed')")
    .get(userId) as { c: number };
  return row.c;
}

/**
 * Seeds the prohibited items database with initial keywords.
 * Idempotent — uses INSERT OR IGNORE to prevent duplicates.
 */
export function seedProhibitedItems(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM prohibited_items').get() as { c: number }).c;
  if (count > 0) return; // Already seeded

  const now = Date.now();
  let seq = 0;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO prohibited_items (id, category, keyword, severity, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  );

  const items: Array<[string, string, 'block' | 'flag' | 'warn', string]> = [
    // ── Weapons & Ammunition ──
    ['weapons', 'firearm', 'block', 'Firearms and guns'],
    ['weapons', 'handgun', 'block', 'Handguns'],
    ['weapons', 'rifle', 'flag', 'Rifles — context dependent'],
    ['weapons', 'shotgun', 'block', 'Shotguns'],
    ['weapons', 'assault weapon', 'block', 'Assault weapons'],
    ['weapons', 'machine gun', 'block', 'Machine guns'],
    ['weapons', 'ammunition', 'block', 'Ammunition'],
    ['weapons', 'ammo', 'block', 'Ammo shorthand'],
    ['weapons', 'silencer', 'block', 'Firearm silencers'],
    ['weapons', 'suppressor', 'block', 'Firearm suppressors'],
    ['weapons', 'explosive', 'block', 'Explosives'],
    ['weapons', 'grenade', 'block', 'Grenades'],
    ['weapons', 'bomb', 'block', 'Bombs'],
    ['weapons', 'detonator', 'block', 'Detonators'],
    ['weapons', 'switchblade', 'block', 'Switchblades'],
    ['weapons', 'brass knuckles', 'block', 'Brass knuckles'],
    ['weapons', 'nunchaku', 'flag', 'Nunchaku'],
    ['weapons', 'throwing star', 'block', 'Throwing stars'],

    // ── Drugs & Controlled Substances ──
    ['drugs', 'cocaine', 'block', 'Cocaine'],
    ['drugs', 'heroin', 'block', 'Heroin'],
    ['drugs', 'methamphetamine', 'block', 'Methamphetamine'],
    ['drugs', 'meth', 'block', 'Meth shorthand'],
    ['drugs', 'fentanyl', 'block', 'Fentanyl'],
    ['drugs', 'lsd', 'block', 'LSD'],
    ['drugs', 'ecstasy', 'block', 'Ecstasy/MDMA'],
    ['drugs', 'mdma', 'block', 'MDMA'],
    ['drugs', 'opioid', 'flag', 'Opioids — context dependent'],
    ['drugs', 'drug paraphernalia', 'block', 'Drug paraphernalia'],
    ['drugs', 'crack pipe', 'block', 'Crack pipes'],
    ['drugs', 'bong', 'flag', 'Bongs — could be legal paraphernalia'],
    ['drugs', 'synthetic cannabinoid', 'block', 'Synthetic cannabinoids'],
    ['drugs', 'bath salts drug', 'block', 'Bath salts (drug)'],
    ['drugs', 'psilocybin', 'flag', 'Psilocybin — legal in some jurisdictions'],
    ['drugs', 'ketamine', 'flag', 'Ketamine — medical vs recreational'],

    // ── Counterfeit & Stolen Goods ──
    ['counterfeit', 'counterfeit', 'block', 'Counterfeit goods'],
    ['counterfeit', 'replica designer', 'block', 'Replica designer goods'],
    ['counterfeit', 'fake id', 'block', 'Fake identification documents'],
    ['counterfeit', 'forged document', 'block', 'Forged documents'],
    ['counterfeit', 'stolen property', 'block', 'Stolen property'],
    ['counterfeit', 'knockoff', 'flag', 'Knockoff goods — context dependent'],
    ['counterfeit', 'bootleg', 'flag', 'Bootleg goods'],

    // ── Exploitation & Trafficking ──
    ['exploitation', 'human trafficking', 'block', 'Human trafficking'],
    ['exploitation', 'child exploitation', 'block', 'Child exploitation — zero tolerance'],
    ['exploitation', 'child pornography', 'block', 'CSAM — zero tolerance'],
    ['exploitation', 'csam', 'block', 'CSAM shorthand — zero tolerance'],
    ['exploitation', 'sex trafficking', 'block', 'Sex trafficking'],
    ['exploitation', 'forced labor', 'block', 'Forced labor'],
    ['exploitation', 'escort service', 'block', 'Escort services'],
    ['exploitation', 'prostitution', 'block', 'Prostitution'],
    ['exploitation', 'underage', 'flag', 'Underage — context dependent'],
    ['exploitation', 'minor for sale', 'block', 'Minors for sale — zero tolerance'],

    // ── Hazardous Materials ──
    ['hazmat', 'radioactive', 'block', 'Radioactive materials'],
    ['hazmat', 'toxic waste', 'block', 'Toxic waste'],
    ['hazmat', 'biohazard', 'block', 'Biohazard materials'],
    ['hazmat', 'chemical weapon', 'block', 'Chemical weapons'],
    ['hazmat', 'poison', 'flag', 'Poison — context dependent (pest control vs intent)'],
    ['hazmat', 'cyanide', 'block', 'Cyanide'],
    ['hazmat', 'ricin', 'block', 'Ricin'],
    ['hazmat', 'anthrax', 'block', 'Anthrax'],

    // ── Endangered Species & Wildlife ──
    ['wildlife', 'ivory', 'block', 'Ivory products'],
    ['wildlife', 'rhino horn', 'block', 'Rhino horn'],
    ['wildlife', 'tiger parts', 'block', 'Tiger parts'],
    ['wildlife', 'endangered species', 'block', 'Endangered species products'],
    ['wildlife', 'exotic animal', 'flag', 'Exotic animals — context dependent'],
    ['wildlife', 'bushmeat', 'block', 'Bushmeat'],

    // ── Stolen Data & Credentials ──
    ['data-theft', 'stolen credentials', 'block', 'Stolen credentials'],
    ['data-theft', 'stolen credit card', 'block', 'Stolen credit cards'],
    ['data-theft', 'credit card dump', 'block', 'Credit card dumps'],
    ['data-theft', 'ssn database', 'block', 'SSN databases'],
    ['data-theft', 'hacked accounts', 'block', 'Hacked accounts'],
    ['data-theft', 'data breach', 'flag', 'Data breach data — context dependent'],
    ['data-theft', 'login credentials for sale', 'block', 'Login credentials for sale'],
    ['data-theft', 'fullz', 'block', 'Fullz (stolen identity packages)'],
    ['data-theft', 'dox', 'block', 'Doxxing services'],
    ['data-theft', 'ddos service', 'block', 'DDoS attack services'],
    ['data-theft', 'ransomware', 'block', 'Ransomware'],
    ['data-theft', 'malware', 'block', 'Malware'],
    ['data-theft', 'exploit kit', 'block', 'Exploit kits'],
    ['data-theft', 'zero day', 'flag', 'Zero-day exploits — context dependent'],

    // ── Financial Fraud ──
    ['fraud', 'money laundering', 'block', 'Money laundering services'],
    ['fraud', 'pyramid scheme', 'block', 'Pyramid schemes'],
    ['fraud', 'ponzi scheme', 'block', 'Ponzi schemes'],
    ['fraud', 'unregistered security', 'block', 'Unregistered securities'],
    ['fraud', 'pump and dump', 'block', 'Pump and dump schemes'],
    ['fraud', 'insider trading', 'block', 'Insider trading tips'],

    // ── Regulated Items (flag for review, not auto-block) ──
    ['regulated', 'prescription medication', 'flag', 'Prescription meds — require license'],
    ['regulated', 'tobacco', 'flag', 'Tobacco products — age restricted'],
    ['regulated', 'alcohol', 'flag', 'Alcohol — age and license restricted'],
    ['regulated', 'vape', 'flag', 'Vape products — age restricted'],
    ['regulated', 'gambling', 'flag', 'Gambling services — regulated'],
    ['regulated', 'cbd oil', 'flag', 'CBD oil — legality varies'],
    ['regulated', 'cannabis', 'flag', 'Cannabis — legality varies by jurisdiction'],
    ['regulated', 'marijuana', 'flag', 'Marijuana — legality varies by jurisdiction'],
  ];

  const insertMany = db.transaction(() => {
    for (const [category, keyword, severity, description] of items) {
      seq++;
      const id = `seed-${seq.toString().padStart(4, '0')}`;
      insert.run(id, category, keyword, severity, description, now, now);
    }
  });

  insertMany();
  logger.info(`Seeded ${items.length} prohibited items into moderation database`);
}
