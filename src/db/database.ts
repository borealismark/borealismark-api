/**
 * Database Layer — Dual Backend Support
 *
 * Production: Turso (LibSQL) — persistent, replicated, edge-distributed
 * Development: better-sqlite3 — local file-based, zero config
 *
 * Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN to use Turso.
 * Otherwise falls back to local SQLite via better-sqlite3.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../middleware/logger';
import { isTursoEnabled } from './turso';

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
    CREATE INDEX IF NOT EXISTS idx_certificates_agent ON audit_certificates(agent_id);

    -- ── Trust Deposits (formerly Staking) ───────────────────────────────────────
    -- CORE PRINCIPLE: BorealisMark is the data layer, not the risk layer.
    -- Agents deposit USDC as a trust signal. Forfeited amounts go to protocol treasury.
    -- Note: bmt_amount and usdc_coverage columns retained for backward compatibility.
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

    -- ── Penalty Events (formerly Slash Events) ───────────────────────────────────
    -- Immutable record of trust deposit penalties enforced by the protocol.
    -- Forfeited amounts go to BorealisMark treasury, not to claimants.
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

    /* ─── Social Engagement: Likes ─── */
    CREATE TABLE IF NOT EXISTS listing_likes (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_tier TEXT NOT NULL DEFAULT 'standard',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(listing_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_likes_listing ON listing_likes(listing_id);
    CREATE INDEX IF NOT EXISTS idx_likes_user ON listing_likes(user_id);

    /* ─── Social Engagement: Watchlist ─── */
    CREATE TABLE IF NOT EXISTS user_watchlist (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id),
      UNIQUE(user_id, listing_id)
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_user ON user_watchlist(user_id);
    CREATE INDEX IF NOT EXISTS idx_watchlist_listing ON user_watchlist(listing_id);

    /* ─── Coupons / Discount Codes ─── */
    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      discount_percent INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_until INTEGER,
      max_uses INTEGER,
      times_used INTEGER NOT NULL DEFAULT 0,
      plan_restriction TEXT,
      renewal_only INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);

    -- ── API Tiers ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS api_tiers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      monthly_request_limit INTEGER NOT NULL,
      max_agents INTEGER NOT NULL,
      max_webhooks INTEGER NOT NULL,
      rate_limit_per_min INTEGER NOT NULL,
      price_monthly_cents INTEGER NOT NULL DEFAULT 0,
      stripe_price_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    -- ── API Usage Tracking ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS api_usage (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER,
      response_time_ms INTEGER,
      timestamp INTEGER NOT NULL,
      month_key TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_api_usage_key_month ON api_usage(api_key_id, month_key);
    CREATE INDEX IF NOT EXISTS idx_api_usage_timestamp ON api_usage(timestamp);

    -- ── Webhook Dead Letters ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS webhook_dead_letters (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      last_error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_dead_letters_webhook ON webhook_dead_letters(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_dead_letters_resolved ON webhook_dead_letters(resolved_at);

    -- ── Processed Webhooks (idempotency tracking) ──────────────────────────────
    CREATE TABLE IF NOT EXISTS processed_webhooks (
      event_id TEXT PRIMARY KEY,
      processed_at TEXT DEFAULT (datetime('now')),
      event_type TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_processed_webhooks_type ON processed_webhooks(event_type);

    -- ── Support Threads (Aurora AI conversations) ──────────────────────────────
    CREATE TABLE IF NOT EXISTS support_threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL DEFAULT 'chat',
      customer_email TEXT,
      customer_name TEXT,
      subject TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      escalated INTEGER NOT NULL DEFAULT 0,
      escalation_reason TEXT,
      assigned_to TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      first_message_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_support_threads_session ON support_threads(session_id);
    CREATE INDEX IF NOT EXISTS idx_support_threads_status ON support_threads(status);
    CREATE INDEX IF NOT EXISTS idx_support_threads_email ON support_threads(customer_email);
    CREATE INDEX IF NOT EXISTS idx_support_threads_escalated ON support_threads(escalated);
    CREATE INDEX IF NOT EXISTS idx_support_threads_updated ON support_threads(updated_at DESC);

    -- ── Support Messages (individual messages in threads) ──────────────────────
    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES support_threads(id)
    );

    CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at);

    -- ── Platform Events (data collection infrastructure) ────────────────────────
    CREATE TABLE IF NOT EXISTS platform_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      category TEXT NOT NULL,
      actor_id TEXT,
      actor_type TEXT NOT NULL DEFAULT 'system',
      target_id TEXT,
      target_type TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      anchored INTEGER NOT NULL DEFAULT 0,
      anchor_tx_id TEXT,
      anchor_status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      last_retry_at TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_type ON platform_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_category ON platform_events(category);
    CREATE INDEX IF NOT EXISTS idx_events_actor ON platform_events(actor_id);
    CREATE INDEX IF NOT EXISTS idx_events_target ON platform_events(target_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON platform_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_anchored ON platform_events(anchored);

    -- ── Audit Requests (mutual commitment protocol) ────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_requests (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      requester_key_id TEXT NOT NULL,
      audit_data TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','expired')),
      signature TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      expires_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_requests_agent ON audit_requests(agent_id);
    CREATE INDEX IF NOT EXISTS idx_audit_requests_status ON audit_requests(status);
    CREATE INDEX IF NOT EXISTS idx_audit_requests_created ON audit_requests(created_at);

    -- ── Data Aggregates (pre-computed metrics) ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS data_aggregates (
      id TEXT PRIMARY KEY,
      metric_key TEXT NOT NULL,
      period TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(metric_key, period, period_start)
    );

    CREATE INDEX IF NOT EXISTS idx_aggregates_key ON data_aggregates(metric_key, period);
    CREATE INDEX IF NOT EXISTS idx_aggregates_period ON data_aggregates(period_start);
  `);

  // Migrate: add retry_count column to platform_events (for HCS retry tracking)
  const eventCols = (db.prepare("PRAGMA table_info(platform_events)").all() as Array<{ name: string }>).map(r => r.name);
  if (!eventCols.includes('retry_count')) db.exec("ALTER TABLE platform_events ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
  if (!eventCols.includes('last_retry_at')) db.exec("ALTER TABLE platform_events ADD COLUMN last_retry_at INTEGER");

  // Migrate: add subscription tracking columns to users table
  const userCols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map(r => r.name);
  if (!userCols.includes('subscription_expires_at')) db.exec("ALTER TABLE users ADD COLUMN subscription_expires_at INTEGER");
  if (!userCols.includes('subscription_method'))     db.exec("ALTER TABLE users ADD COLUMN subscription_method TEXT");
  if (!userCols.includes('subscription_plan_id'))    db.exec("ALTER TABLE users ADD COLUMN subscription_plan_id TEXT");

  // Migrate: add coupon/discount columns to usdc_invoices table
  const invCols = (db.prepare("PRAGMA table_info(usdc_invoices)").all() as Array<{ name: string }>).map(r => r.name);
  if (!invCols.includes('coupon_id'))         db.exec("ALTER TABLE usdc_invoices ADD COLUMN coupon_id TEXT");
  if (!invCols.includes('discount_percent'))  db.exec("ALTER TABLE usdc_invoices ADD COLUMN discount_percent INTEGER DEFAULT 0");
  if (!invCols.includes('original_amount_usd')) db.exec("ALTER TABLE usdc_invoices ADD COLUMN original_amount_usd REAL");

  // Migrate: add agent dashboard columns (owner_user_id, agent_type, public_listing)
  const agentCols = (db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map(r => r.name);
  if (!agentCols.includes('owner_user_id'))   db.exec("ALTER TABLE agents ADD COLUMN owner_user_id TEXT");
  if (!agentCols.includes('agent_type'))      db.exec("ALTER TABLE agents ADD COLUMN agent_type TEXT DEFAULT 'other'");
  if (!agentCols.includes('public_listing'))  db.exec("ALTER TABLE agents ADD COLUMN public_listing INTEGER DEFAULT 0");

  // Index for dashboard agent lookups by user
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_user_id)"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_agents_public ON agents(public_listing) WHERE active = 1 AND public_listing = 1"); } catch {}

  // Migrate: add new columns to api_keys if upgrading from old schema
  const keyColumns = (db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).map(r => r.name);
  if (!keyColumns.includes('scopes'))        db.exec("ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'audit,read'");
  if (!keyColumns.includes('last_used_at'))  db.exec("ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER");
  if (!keyColumns.includes('usage_count'))   db.exec("ALTER TABLE api_keys ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0");
  if (!keyColumns.includes('expires_at'))    db.exec("ALTER TABLE api_keys ADD COLUMN expires_at INTEGER");
  if (!keyColumns.includes('revoked_at'))    db.exec("ALTER TABLE api_keys ADD COLUMN revoked_at INTEGER");
  if (!keyColumns.includes('revoked_reason')) db.exec("ALTER TABLE api_keys ADD COLUMN revoked_reason TEXT");
  if (!keyColumns.includes('tier'))          db.exec("ALTER TABLE api_keys ADD COLUMN tier TEXT DEFAULT 'free'");

  // Migrate: add delivery status columns to webhooks
  const webhookCols = (db.prepare("PRAGMA table_info(webhooks)").all() as Array<{ name: string }>).map(r => r.name);
  if (!webhookCols.includes('last_delivery_status')) db.exec("ALTER TABLE webhooks ADD COLUMN last_delivery_status TEXT DEFAULT 'pending'");

  // Migrate: add new columns to marketplace_listings (Phase 1: BundlesofJoy integration)
  const listingCols = (db.prepare("PRAGMA table_info(marketplace_listings)").all() as Array<{ name: string }>).map(r => r.name);
  if (!listingCols.includes('condition'))       db.exec("ALTER TABLE marketplace_listings ADD COLUMN condition TEXT");
  if (!listingCols.includes('platform'))        db.exec("ALTER TABLE marketplace_listings ADD COLUMN platform TEXT");
  if (!listingCols.includes('sku'))             db.exec("ALTER TABLE marketplace_listings ADD COLUMN sku TEXT");
  if (!listingCols.includes('external_url'))    db.exec("ALTER TABLE marketplace_listings ADD COLUMN external_url TEXT");
  if (!listingCols.includes('external_source')) db.exec("ALTER TABLE marketplace_listings ADD COLUMN external_source TEXT");

  // Create seller_storefronts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS seller_storefronts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      store_name TEXT NOT NULL,
      description TEXT,
      logo_url TEXT,
      banner_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_storefronts_slug ON seller_storefronts(slug);
  `);

  // ── Marketplace Orders (escrow-based purchase tracking) ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_orders (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      item_price_cad REAL NOT NULL,
      shipping_cost_cad REAL NOT NULL DEFAULT 0,
      total_cad REAL NOT NULL,
      exchange_rate REAL NOT NULL,
      total_usdc REAL NOT NULL,
      conversion_timestamp INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      buyer_deposit_memo TEXT,
      seller_deposit_memo TEXT,
      buyer_deposit_confirmed_at INTEGER,
      seller_deposit_confirmed_at INTEGER,
      shipping_address TEXT,
      shipping_carrier TEXT,
      tracking_number TEXT,
      shipped_at INTEGER,
      delivery_confirmed_at INTEGER,
      settlement_type TEXT NOT NULL DEFAULT 'unknown', -- 'hedera' | 'stripe' | 'unknown'
      hedera_transaction_id TEXT,
      hcs_topic_id TEXT,
      hcs_sequence_number INTEGER,
      stripe_payment_intent_id TEXT,
      completed_at INTEGER,
      settled_at INTEGER,
      dispute_reason TEXT,
      dispute_raised_by TEXT,
      dispute_raised_at INTEGER,
      rating INTEGER,
      rating_comment TEXT,
      rated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id),
      FOREIGN KEY (buyer_id) REFERENCES users(id),
      FOREIGN KEY (seller_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON marketplace_orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_seller ON marketplace_orders(seller_id);
    CREATE INDEX IF NOT EXISTS idx_orders_listing ON marketplace_orders(listing_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON marketplace_orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON marketplace_orders(created_at DESC);
  `);

  // ── Marketplace Escrow Deposits (individual deposit records) ─────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_escrow_deposits (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      party TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount_usdc REAL NOT NULL,
      memo TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      hedera_transaction_id TEXT,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES marketplace_orders(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_escrow_order ON marketplace_escrow_deposits(order_id);
    CREATE INDEX IF NOT EXISTS idx_escrow_user ON marketplace_escrow_deposits(user_id);
    CREATE INDEX IF NOT EXISTS idx_escrow_memo ON marketplace_escrow_deposits(memo);
    CREATE INDEX IF NOT EXISTS idx_escrow_status ON marketplace_escrow_deposits(status);
  `);

  // ── Marketplace Carts ────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_carts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id),
      UNIQUE(user_id, listing_id)
    );
    CREATE INDEX IF NOT EXISTS idx_carts_user ON marketplace_carts(user_id);
    CREATE INDEX IF NOT EXISTS idx_carts_listing ON marketplace_carts(listing_id);
  `);

  // ── Exchange Rate Cache ──────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS exchange_rates_cache (
      id TEXT PRIMARY KEY,
      from_currency TEXT NOT NULL,
      to_currency TEXT NOT NULL,
      rate REAL NOT NULL,
      source TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exchange_pair ON exchange_rates_cache(from_currency, to_currency);
    CREATE INDEX IF NOT EXISTS idx_exchange_expires ON exchange_rates_cache(expires_at);

    CREATE TABLE IF NOT EXISTS ebay_store_imports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      store_url TEXT NOT NULL,
      store_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      listings_found INTEGER DEFAULT 0,
      listings_imported INTEGER DEFAULT 0,
      listings_failed INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ebay_imports_user ON ebay_store_imports(user_id);

    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      campaign_copy TEXT,
      hashtags TEXT DEFAULT '[]',
      image_urls TEXT DEFAULT '[]',
      tracking_code TEXT UNIQUE,
      tracking_url TEXT,
      external_post_id TEXT,
      external_post_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      posted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_user ON marketing_campaigns(user_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_listing ON marketing_campaigns(listing_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_tracking ON marketing_campaigns(tracking_code);

    CREATE TABLE IF NOT EXISTS referral_clicks (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      tracking_code TEXT NOT NULL,
      source_platform TEXT,
      referrer_url TEXT,
      user_agent TEXT,
      ip_hash TEXT,
      clicked_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_campaign ON referral_clicks(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_clicks_code ON referral_clicks(tracking_code);

    CREATE TABLE IF NOT EXISTS marketing_conversions (
      id TEXT PRIMARY KEY,
      campaign_id TEXT,
      click_id TEXT,
      listing_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      converted_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conversions_campaign ON marketing_conversions(campaign_id);

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      agent_name TEXT NOT NULL DEFAULT 'BorealisAgent',
      task_type TEXT NOT NULL,
      platform TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      status_message TEXT,
      campaign_id TEXT,
      tracking_code TEXT,
      result_data TEXT DEFAULT '{}',
      started_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_listing ON agent_tasks(listing_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_user ON agent_tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);

    -- ── User Violations & Moderation ─────────────────────────────────────────
    -- Track policy violations for progressive enforcement
    CREATE TABLE IF NOT EXISTS user_violations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,           -- 'profanity' | 'off_platform' | 'spam' | 'harassment' | 'scam' | 'slurs'
      severity TEXT NOT NULL,       -- 'warning' | 'minor' | 'major' | 'critical'
      message_id TEXT,              -- reference to the offending message
      thread_id TEXT,               -- reference to the thread
      details TEXT,                 -- JSON with matched words/patterns
      action_taken TEXT,            -- 'warning' | 'mute_24h' | 'suspend_7d' | 'permanent_ban'
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );
    CREATE INDEX IF NOT EXISTS idx_violations_user ON user_violations(user_id);
    CREATE INDEX IF NOT EXISTS idx_violations_created ON user_violations(created_at);

    -- User sanction status and enforcement
    CREATE TABLE IF NOT EXISTS user_sanctions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'muted' | 'suspended' | 'banned'
      muted_until INTEGER,                   -- epoch ms when mute expires
      suspended_until INTEGER,               -- epoch ms when suspension expires
      violation_count INTEGER DEFAULT 0,
      last_violation_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sanctions_user ON user_sanctions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sanctions_status ON user_sanctions(status);
    CREATE INDEX IF NOT EXISTS idx_sanctions_muted_until ON user_sanctions(muted_until);

    -- ── AI Bot Management ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      bio TEXT,
      capabilities TEXT,
      specialties TEXT,
      avatar_url TEXT,
      tier TEXT DEFAULT 'bronze',
      ap_points INTEGER DEFAULT 0,
      bm_score REAL DEFAULT 0,
      star_rating REAL DEFAULT 0,
      total_ratings INTEGER DEFAULT 0,
      jobs_completed INTEGER DEFAULT 0,
      jobs_failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      review_reason TEXT,
      reviewed_by TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
    CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status);
    CREATE INDEX IF NOT EXISTS idx_bots_tier ON bots(tier);
    CREATE INDEX IF NOT EXISTS idx_bots_ap_points ON bots(ap_points DESC);

    CREATE TABLE IF NOT EXISTS bot_jobs (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id),
      listing_id TEXT,
      job_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'assigned',
      rating REAL,
      rating_comment TEXT,
      ap_earned INTEGER DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_jobs_bot ON bot_jobs(bot_id);
    CREATE INDEX IF NOT EXISTS idx_bot_jobs_status ON bot_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_bot_jobs_type ON bot_jobs(job_type);

    CREATE TABLE IF NOT EXISTS bot_reviews (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id),
      reviewer_id TEXT NOT NULL,
      review_type TEXT NOT NULL,
      decision TEXT NOT NULL,
      notes TEXT,
      jobs_reviewed INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_reviews_bot ON bot_reviews(bot_id);
    CREATE INDEX IF NOT EXISTS idx_bot_reviews_reviewer ON bot_reviews(reviewer_id);

    -- ── User Verifications (multi-layer trust stacking) ─────────────────────────
    -- Each row represents one verification layer for a user.
    -- Layers: email (auto), social_media, government_id
    -- Trust score = sum of layer weights. More layers = higher trust.
    CREATE TABLE IF NOT EXISTS user_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      verification_type TEXT NOT NULL,    -- 'email' | 'social_media' | 'government_id'
      platform TEXT,                       -- 'facebook' | 'linkedin' | 'x' | 'instagram' | 'tiktok' | 'government_id'
      verification_code TEXT,              -- BT-XXXXXXXX code for social verification
      profile_url TEXT,                    -- social media profile URL or document reference
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'verified' | 'rejected' | 'expired'
      trust_points INTEGER NOT NULL DEFAULT 0, -- points this layer contributes
      metadata TEXT NOT NULL DEFAULT '{}', -- JSON: extra data (doc analysis, social proof, etc.)
      reviewer_id TEXT,                    -- admin who reviewed (for govt ID)
      review_notes TEXT,                   -- admin review notes
      submitted_at INTEGER NOT NULL,
      verified_at INTEGER,
      expires_at INTEGER,                  -- optional expiry for social verifications
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_verifications_user ON user_verifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_verifications_status ON user_verifications(status);
    CREATE INDEX IF NOT EXISTS idx_verifications_type ON user_verifications(verification_type);
    CREATE INDEX IF NOT EXISTS idx_verifications_code ON user_verifications(verification_code);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_user_platform ON user_verifications(user_id, platform) WHERE status != 'rejected';

    -- ── User Trust Scores (pre-computed aggregate) ──────────────────────────────
    -- Updated whenever a verification layer changes. Single source of truth for trust level.
    CREATE TABLE IF NOT EXISTS user_trust_scores (
      user_id TEXT PRIMARY KEY,
      total_score INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'unverified', -- 'unverified' | 'basic' | 'verified' | 'trusted' | 'premium' | 'elite'
      email_verified INTEGER NOT NULL DEFAULT 0,
      social_verified INTEGER NOT NULL DEFAULT 0,       -- count of verified social accounts
      document_verified INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,     -- total completed transactions
      hedera_tx_count INTEGER NOT NULL DEFAULT 0,       -- Hedera-settled transactions (2 pts each)
      stripe_tx_count INTEGER NOT NULL DEFAULT 0,       -- Stripe-settled transactions (1 pt each)
      account_age_days INTEGER NOT NULL DEFAULT 0,
      last_computed_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ── v41 Active Login Tracking ─────────────────────────────────────────────
    -- Account age bonus requires ACTIVE participation, not just passive account existence.
    -- Each distinct calendar day with at least one login is recorded.
    CREATE TABLE IF NOT EXISTS user_login_days (
      user_id TEXT NOT NULL,
      login_date TEXT NOT NULL,  -- YYYY-MM-DD format (UTC)
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, login_date),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_login_days_user ON user_login_days(user_id);

    -- ── v40 Signal Tower: Notification Center ──────────────────────────────────

    CREATE TABLE IF NOT EXISTS user_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,          -- 'order' | 'verification' | 'payment' | 'system' | 'trust' | 'support'
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      icon TEXT DEFAULT 'bell',    -- icon hint for frontend
      link TEXT,                   -- deep link (e.g., '/dashboard/orders/abc')
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_notif_user ON user_notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notif_unread ON user_notifications(user_id, read);

    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT PRIMARY KEY,
      email_orders INTEGER NOT NULL DEFAULT 1,
      email_verification INTEGER NOT NULL DEFAULT 1,
      email_payment INTEGER NOT NULL DEFAULT 1,
      email_system INTEGER NOT NULL DEFAULT 1,
      email_marketing INTEGER NOT NULL DEFAULT 0,
      inapp_orders INTEGER NOT NULL DEFAULT 1,
      inapp_verification INTEGER NOT NULL DEFAULT 1,
      inapp_payment INTEGER NOT NULL DEFAULT 1,
      inapp_system INTEGER NOT NULL DEFAULT 1,
      inapp_trust INTEGER NOT NULL DEFAULT 1,
      inapp_support INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ══════════════════════════════════════════════════════════════════════════
    -- ACADEMY PROGRESSION SYSTEM (AP/XP Engine)
    -- ══════════════════════════════════════════════════════════════════════════

    -- ── Level Definitions (static reference table) ─────────────────────────
    -- Defines the title, tier, and visual identity for each level range.
    -- min_level/max_level pairs define ranges; XP thresholds computed by engine.
    CREATE TABLE IF NOT EXISTS level_definitions (
      id INTEGER PRIMARY KEY,
      min_level INTEGER NOT NULL,
      max_level INTEGER NOT NULL,
      title TEXT NOT NULL,              -- e.g. 'Pathfinder', 'Sage'
      tier TEXT NOT NULL,               -- e.g. 'Bronze', 'Gold', 'Aurora'
      tier_color TEXT NOT NULL,         -- hex color for UI rendering
      is_milestone INTEGER NOT NULL DEFAULT 0, -- 1 = premium tier milestone
      icon_svg TEXT,                    -- optional SVG for tier badge
      UNIQUE(min_level, max_level)
    );

    -- ── User Progression (core state per user) ────────────────────────────
    -- Single row per user. Updated atomically on every XP/AP change.
    CREATE TABLE IF NOT EXISTS user_progression (
      user_id TEXT PRIMARY KEY,
      xp_total INTEGER NOT NULL DEFAULT 0,       -- lifetime XP earned
      xp_current_level INTEGER NOT NULL DEFAULT 0, -- XP progress toward next level
      level INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT 'Newcomer',
      tier TEXT NOT NULL DEFAULT 'Basic',
      tier_color TEXT NOT NULL DEFAULT '#9CA3AF',
      ap_total INTEGER NOT NULL DEFAULT 0,       -- lifetime AP (contribution score)
      ap_rank TEXT NOT NULL DEFAULT 'Observer',  -- contribution rank derived from AP
      current_streak INTEGER NOT NULL DEFAULT 0, -- consecutive login days
      longest_streak INTEGER NOT NULL DEFAULT 0, -- all-time best streak
      last_activity_date TEXT,                   -- YYYY-MM-DD of last XP-earning action
      games_played INTEGER NOT NULL DEFAULT 0,
      games_won INTEGER NOT NULL DEFAULT 0,
      articles_read INTEGER NOT NULL DEFAULT 0,
      contributions INTEGER NOT NULL DEFAULT 0,
      featured_badge_id TEXT,                    -- user's chosen display badge
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ── XP Transactions (immutable audit trail) ──────────────────────────
    -- Every XP award is recorded. Enables analytics, dispute resolution,
    -- and potential future features like XP decay or seasonal resets.
    CREATE TABLE IF NOT EXISTS xp_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,           -- positive = earn, negative = penalty
      source TEXT NOT NULL,              -- e.g. 'login', 'game_complete', 'article_read'
      source_id TEXT,                    -- optional reference (game ID, article ID, etc.)
      description TEXT NOT NULL,
      balance_after INTEGER NOT NULL,    -- total XP after this transaction
      level_after INTEGER NOT NULL,      -- level after this transaction
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_xp_tx_user ON xp_transactions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_xp_tx_source ON xp_transactions(source);

    -- ── AP Transactions (contribution audit trail) ────────────────────────
    -- AP is earned through contributions: articles, comments, shares, reviews.
    CREATE TABLE IF NOT EXISTS ap_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      source TEXT NOT NULL,              -- e.g. 'article_publish', 'review', 'share'
      source_id TEXT,
      description TEXT NOT NULL,
      balance_after INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_tx_user ON ap_transactions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ap_tx_source ON ap_transactions(source);

    -- ── Badge Definitions (master catalog) ────────────────────────────────
    -- All possible badges. New badges can be added without schema changes.
    CREATE TABLE IF NOT EXISTS badge_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      category TEXT NOT NULL,            -- 'learning' | 'contribution' | 'community' | 'special' | 'streak' | 'milestone'
      icon_svg TEXT NOT NULL,            -- inline SVG for the badge
      rarity TEXT NOT NULL DEFAULT 'common', -- 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
      requirement_type TEXT NOT NULL,    -- 'xp_total' | 'level' | 'streak' | 'games_played' | 'contributions' | 'ap_total' | 'manual'
      requirement_value INTEGER NOT NULL DEFAULT 0, -- threshold to auto-award
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    -- ── User Badges (earned badges per user) ──────────────────────────────
    CREATE TABLE IF NOT EXISTS user_badges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      badge_id TEXT NOT NULL,
      earned_at INTEGER NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0,   -- 0 = unread (show notification)
      UNIQUE(user_id, badge_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (badge_id) REFERENCES badge_definitions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_badges_badge ON user_badges(badge_id);

    -- ── Daily Activity Log (streak and cooldown tracking) ─────────────────
    -- One row per user per day. Prevents double-counting daily bonuses.
    CREATE TABLE IF NOT EXISTS daily_activity_log (
      user_id TEXT NOT NULL,
      activity_date TEXT NOT NULL,       -- YYYY-MM-DD
      login_xp_claimed INTEGER NOT NULL DEFAULT 0,
      games_played INTEGER NOT NULL DEFAULT 0,
      articles_read INTEGER NOT NULL DEFAULT 0,
      xp_earned_today INTEGER NOT NULL DEFAULT 0,
      ap_earned_today INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, activity_date),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_activity_user ON daily_activity_log(user_id, activity_date DESC);
  `);

  // Migrate: add CAD pricing + shipping columns to marketplace_listings
  const listingColsV2 = (db.prepare("PRAGMA table_info(marketplace_listings)").all() as Array<{ name: string }>).map(r => r.name);
  if (!listingColsV2.includes('price_cad'))          db.exec("ALTER TABLE marketplace_listings ADD COLUMN price_cad REAL");
  if (!listingColsV2.includes('shipping_cost_cad'))  db.exec("ALTER TABLE marketplace_listings ADD COLUMN shipping_cost_cad REAL DEFAULT 0");
  if (!listingColsV2.includes('video_url'))          db.exec("ALTER TABLE marketplace_listings ADD COLUMN video_url TEXT");

  // Migrate: add featured flag to seller_storefronts
  const sfCols = (db.prepare("PRAGMA table_info(seller_storefronts)").all() as Array<{ name: string }>).map(r => r.name);
  if (!sfCols.includes('featured')) db.exec("ALTER TABLE seller_storefronts ADD COLUMN featured INTEGER DEFAULT 0");

  // Migrate: add retry tracking columns to platform_events
  const eventsCols = (db.prepare("PRAGMA table_info(platform_events)").all() as Array<{ name: string }>).map(r => r.name);
  if (!eventsCols.includes('retry_count')) db.exec("ALTER TABLE platform_events ADD COLUMN retry_count INTEGER DEFAULT 0");
  if (!eventsCols.includes('last_retry_at')) db.exec("ALTER TABLE platform_events ADD COLUMN last_retry_at TEXT");
  if (!eventsCols.includes('anchor_status')) db.exec("ALTER TABLE platform_events ADD COLUMN anchor_status TEXT DEFAULT 'pending'");

  // Migrate: add expires_at column to audit_requests
  const auditReqsCols = (db.prepare("PRAGMA table_info(audit_requests)").all() as Array<{ name: string }>).map(r => r.name);
  if (!auditReqsCols.includes('expires_at')) db.exec("ALTER TABLE audit_requests ADD COLUMN expires_at TEXT");

  // Backfill price_cad from price_usdc for existing listings (initial rate: 1 USDC ≈ 1.37 CAD)
  // This only runs once — subsequent listings will have price_cad set directly
  {
    const needsBackfill = db.prepare(
      "SELECT COUNT(*) as cnt FROM marketplace_listings WHERE price_cad IS NULL AND price_usdc IS NOT NULL"
    ).get() as { cnt: number };
    if (needsBackfill.cnt > 0) {
      const INITIAL_USDC_TO_CAD = 1.37; // approximate rate at migration time
      db.prepare(
        "UPDATE marketplace_listings SET price_cad = ROUND(price_usdc * ?, 2) WHERE price_cad IS NULL AND price_usdc IS NOT NULL"
      ).run(INITIAL_USDC_TO_CAD);
      logger.info(`Backfilled price_cad for ${needsBackfill.cnt} listings at rate 1 USDC = ${INITIAL_USDC_TO_CAD} CAD`);
    }
  }

  // Set BundlesofJoy storefront as featured
  {
    const bojStore = db.prepare("SELECT id, featured FROM seller_storefronts WHERE slug = 'bundlesofjoy'").get() as { id: string; featured: number } | undefined;
    if (bojStore && !bojStore.featured) {
      db.prepare("UPDATE seller_storefronts SET featured = 1 WHERE id = ?").run(bojStore.id);
      logger.info('Set BundlesofJoy storefront as featured');
    }
  }

  // Migrate: add dual-rail transaction columns to marketplace_orders and user_trust_scores
  const orderColsV2 = (db.prepare("PRAGMA table_info(marketplace_orders)").all() as Array<{ name: string }>).map(r => r.name);
  if (!orderColsV2.includes('settlement_type'))          db.exec("ALTER TABLE marketplace_orders ADD COLUMN settlement_type TEXT NOT NULL DEFAULT 'unknown'");
  if (!orderColsV2.includes('stripe_payment_intent_id')) db.exec("ALTER TABLE marketplace_orders ADD COLUMN stripe_payment_intent_id TEXT");

  const trustColsV2 = (db.prepare("PRAGMA table_info(user_trust_scores)").all() as Array<{ name: string }>).map(r => r.name);
  if (!trustColsV2.includes('hedera_tx_count')) db.exec("ALTER TABLE user_trust_scores ADD COLUMN hedera_tx_count INTEGER NOT NULL DEFAULT 0");
  if (!trustColsV2.includes('stripe_tx_count')) db.exec("ALTER TABLE user_trust_scores ADD COLUMN stripe_tx_count INTEGER NOT NULL DEFAULT 0");

  // Backfill settlement_type for existing orders that have hedera_transaction_id
  db.exec("UPDATE marketplace_orders SET settlement_type = 'hedera' WHERE hedera_transaction_id IS NOT NULL AND settlement_type = 'unknown'");

  // ── Migration Officer: origin tracking on marketplace_listings ──────────────
  const listingColsV3 = (db.prepare("PRAGMA table_info(marketplace_listings)").all() as Array<{ name: string }>).map(r => r.name);
  if (!listingColsV3.includes('origin'))              db.exec("ALTER TABLE marketplace_listings ADD COLUMN origin TEXT NOT NULL DEFAULT 'terminal'");
  if (!listingColsV3.includes('external_listing_id')) db.exec("ALTER TABLE marketplace_listings ADD COLUMN external_listing_id TEXT");
  if (!listingColsV3.includes('sync_status'))         db.exec("ALTER TABLE marketplace_listings ADD COLUMN sync_status TEXT DEFAULT 'active'");
  if (!listingColsV3.includes('last_synced_at'))      db.exec("ALTER TABLE marketplace_listings ADD COLUMN last_synced_at INTEGER");

  // Backfill origin for existing imported listings (those with external_source set)
  db.exec("UPDATE marketplace_listings SET origin = 'imported' WHERE external_source IS NOT NULL AND origin = 'terminal'");

  // ── Sync Schedules table: tracks recurring sync subscriptions ─────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_schedules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      store_url TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'ebay',
      store_name TEXT,
      frequency TEXT NOT NULL DEFAULT 'weekly',
      tier TEXT NOT NULL DEFAULT 'starter',
      status TEXT NOT NULL DEFAULT 'active',
      last_run_at INTEGER,
      next_run_at INTEGER,
      listings_tracked INTEGER NOT NULL DEFAULT 0,
      listings_delisted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ── Seed Migration Officer as agent + bot ───────────────────────────────────
  {
    const migrationAgentExists = db.prepare(
      "SELECT id FROM agents WHERE name = 'Migration Officer'"
    ).get() as { id: string } | undefined;

    if (!migrationAgentExists) {
      const migrationOfficerId = uuidv4();
      const now = Date.now();

      // First: register as an agent (required for terminal_services FK)
      // Use a placeholder registrant_key_id since this is a system agent
      db.prepare(`
        INSERT INTO agents (id, name, description, version, registered_at, registrant_key_id, active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        migrationOfficerId,
        'Migration Officer',
        'Cross-platform listing migration and sync specialist. Imports external store listings into Borealis Terminal and keeps them synchronized — automatically detecting sold-out items, price changes, and availability shifts.',
        '1.0.0',
        now,
        'system-internal',
        1
      );

      // Also register as a bot for the bot_jobs tracking system
      const adminUser = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as { id: string } | undefined;
      if (adminUser) {
        db.prepare(`
          INSERT INTO bots (id, owner_id, name, bio, capabilities, specialties, avatar_url, tier, ap_points, bm_score, star_rating, total_ratings, jobs_completed, jobs_failed, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          migrationOfficerId,
          adminUser.id,
          'Migration Officer',
          'Your dedicated cross-platform listing migration and sync specialist. I import your external store listings into Borealis Terminal and keep them synchronized — automatically detecting sold-out items, price changes, and availability shifts across eBay and other platforms.',
          JSON.stringify(['ebay-import', 'listing-sync', 'inventory-management', 'cross-platform-migration', 'price-monitoring', 'availability-tracking']),
          JSON.stringify(['eBay Store Import', 'Multi-Platform Sync', 'Inventory Reconciliation', 'Automated Delisting', 'Price Harmonization']),
          '/agents/migration-officer.png',
          'gold',
          500,
          85,
          4.8,
          12,
          47,
          0,
          'active',
          now,
          now
        );
      }

        // Create tiered service listings for Migration Officer

        // Tier 1: Starter — One-time Import ($25)
        db.prepare(`
          INSERT INTO terminal_services (id, agent_id, title, description, category, price_usdc, min_trust_score, capabilities, max_concurrent_jobs, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          migrationOfficerId,
          'Store Migration — Starter',
          'One-time import of up to 100 listings from your eBay store into Borealis Terminal. Each listing is categorized, enriched with condition tags and origin tracking, and published with a direct backlink to the original platform. Perfect for sellers testing the waters on Borealis. Includes: automated categorization, image migration, condition mapping, and origin badges that clearly mark imported listings.',
          'migration',
          25.00,
          0,
          JSON.stringify(['ebay-import', 'categorization', 'image-migration', 'origin-tracking']),
          5,
          'active',
          now,
          now
        );

        // Tier 2: Professional — Import + Monthly Sync ($45)
        db.prepare(`
          INSERT INTO terminal_services (id, agent_id, title, description, category, price_usdc, min_trust_score, capabilities, max_concurrent_jobs, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          migrationOfficerId,
          'Store Migration — Professional',
          'Full import of up to 500 listings PLUS monthly sync sweeps for 3 months. The Migration Officer monitors your external store and automatically detects sold-out items, delisting them from Terminal so buyers never encounter stale listings. Includes everything in Starter plus: monthly inventory sync, automatic sold-item detection and delisting, price change monitoring, and a sync health dashboard. Your listings stay fresh and accurate across both platforms — zero manual effort required.',
          'migration',
          45.00,
          10,
          JSON.stringify(['ebay-import', 'monthly-sync', 'sold-detection', 'auto-delist', 'price-monitoring']),
          10,
          'active',
          now,
          now
        );

        // Tier 3: Enterprise — Import + Weekly Sync ($75)
        db.prepare(`
          INSERT INTO terminal_services (id, agent_id, title, description, category, price_usdc, min_trust_score, capabilities, max_concurrent_jobs, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          migrationOfficerId,
          'Store Migration — Enterprise',
          'Unlimited listing import PLUS weekly sync sweeps for 6 months. Built for high-volume sellers who need real-time inventory accuracy across platforms. The Migration Officer performs weekly sweeps detecting sold items, price changes, new additions to your external store, and availability shifts — keeping your Terminal storefront perfectly mirrored. Includes everything in Professional plus: weekly sync frequency, unlimited listings, new-item auto-import, priority queue processing, and dedicated sync analytics. Never worry about cross-platform inventory mismatches again.',
          'migration',
          75.00,
          25,
          JSON.stringify(['ebay-import', 'weekly-sync', 'unlimited-listings', 'auto-import-new', 'priority-processing', 'sync-analytics']),
          20,
          'active',
          now,
          now
        );

        logger.info(`Seeded Migration Officer agent (${migrationOfficerId}) with 3 tiered service listings`);
    }
  }

  // ── Clean up mock marketing tasks and backfill Migration Officer activity for imported listings
  const hasBackfilledMigration = (db.prepare(
    "SELECT COUNT(*) as cnt FROM agent_tasks WHERE agent_name = 'Migration Officer' AND task_type = 'migration_import'"
  ).get() as any).cnt;

  if (hasBackfilledMigration === 0) {
    // Remove auto-generated Polaris/marketing tasks for imported listings
    db.exec(`
      DELETE FROM agent_tasks WHERE listing_id IN (
        SELECT id FROM marketplace_listings WHERE origin = 'imported'
      ) AND task_type = 'marketing'
    `);

    // Backfill Migration Officer activity for all existing imported listings
    const importedListings = db.prepare(`
      SELECT id, user_id, external_url, title FROM marketplace_listings WHERE origin = 'imported'
    `).all() as any[];

    const now = new Date().toISOString();
    const insertActivity = db.prepare(`
      INSERT INTO agent_tasks (id, listing_id, user_id, agent_name, task_type, platform, status, status_message, result_data, started_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'Migration Officer', 'migration_import', 'ebay', 'completed', ?, ?, ?, ?, ?)
    `);

    for (const listing of importedListings) {
      const actId = uuidv4();
      insertActivity.run(
        actId, listing.id, listing.user_id,
        'Imported from eBay — listing migrated with images, pricing, and condition tags',
        JSON.stringify({ source: 'ebay', externalUrl: listing.external_url || '', originalTitle: listing.title }),
        now, now, now
      );
    }

    logger.info(`[Migration] Backfilled ${importedListings.length} Migration Officer activity records`);
  }

  // ── Remove imported listings whose eBay source is delisted (stale placeholder images)
  // These have s-l500 images (scraper always imports s-l1600) meaning eBay delisted the original listing
  // Also remove any imported listings that were previously cleared to empty images (sync_status = 'stale')
  // These are no longer valid and should not appear in the store
  const staleImageListings = db.prepare(`
    SELECT id FROM marketplace_listings
    WHERE origin = 'imported' AND status IN ('active', 'published')
      AND (
        (images LIKE '%s-l500%' AND images NOT LIKE '%s-l1600%')
        OR (images = '[]' AND sync_status = 'stale')
      )
  `).all() as any[];

  if (staleImageListings.length > 0) {
    db.prepare(
      `DELETE FROM marketplace_listings
       WHERE origin = 'imported' AND status IN ('active', 'published')
         AND (
           (images LIKE '%s-l500%' AND images NOT LIKE '%s-l1600%')
           OR (images = '[]' AND sync_status = 'stale')
         )`
    ).run();
    logger.info(`[Migration Officer] Removed ${staleImageListings.length} delisted eBay listings with invalid images`);
  }

  // ── Migration Officer: Async sold-listing sync on startup ──────────────────
  // Check imported eBay listings for sold/delisted status by fetching their eBay pages.
  // Runs in the background so it doesn't block server startup.
  // Checks up to 50 listings per deploy (oldest-synced first) to stay within rate limits.
  const importedActiveCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM marketplace_listings
    WHERE origin = 'imported' AND status IN ('published', 'active')
      AND sync_status = 'active' AND external_url IS NOT NULL AND external_url != ''
  `).get() as any;

  if (importedActiveCount?.cnt > 0) {
    logger.info(`[Migration Officer] ${importedActiveCount.cnt} imported listings to check — starting background sold sync (batch of 50)...`);
    // Dynamic import to avoid circular dependency
    import('../services/ebayScraper').then(({ syncSoldListings }) => {
      syncSoldListings(undefined, 50)
        .then((result) => {
          logger.info(`[Migration Officer] Startup sold sync complete: ${result.markedSold} sold, ${result.markedDelisted} delisted, ${result.stillActive} active, ${result.errors} errors`);
        })
        .catch((err: any) => {
          logger.error(`[Migration Officer] Startup sold sync failed: ${err.message}`);
        });
    }).catch((err: any) => {
      logger.error(`[Migration Officer] Failed to load ebayScraper for sold sync: ${err.message}`);
    });
  }

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

  // ── Seed Level Definitions ──────────────────────────────────────────────
  {
    const levelCount = (db.prepare('SELECT COUNT(*) as cnt FROM level_definitions').get() as { cnt: number }).cnt;
    if (levelCount === 0) {
      const levels = [
        [1, 4, 'Newcomer', 'Basic', '#9CA3AF', 0],
        [5, 9, 'Explorer', 'Basic', '#9CA3AF', 0],
        [10, 14, 'Pathfinder', 'Bronze', '#CD7F32', 1],
        [15, 19, 'Analyst', 'Bronze', '#CD7F32', 0],
        [20, 24, 'Strategist', 'Silver', '#C0C0C0', 1],
        [25, 29, 'Architect', 'Silver', '#C0C0C0', 0],
        [30, 34, 'Visionary', 'Gold', '#D4A853', 1],
        [35, 39, 'Pioneer', 'Gold', '#D4A853', 0],
        [40, 44, 'Luminary', 'Platinum', '#E5E4E2', 1],
        [45, 49, 'Oracle', 'Platinum', '#E5E4E2', 0],
        [50, 54, 'Sage', 'Diamond', '#B9F2FF', 1],
        [55, 59, 'Sovereign', 'Diamond', '#B9F2FF', 0],
        [60, 64, 'Ascendant', 'Obsidian', '#3D3D3D', 1],
        [65, 69, 'Epochal', 'Obsidian', '#3D3D3D', 0],
        [70, 74, 'Transcendent', 'Aurora', '#8B7EC8', 1],
        [75, 79, 'Celestial', 'Aurora', '#A594E0', 0],
        [80, 84, 'Eternal', 'Borealis', '#5C6AC4', 1],
        [85, 89, 'Mythic', 'Borealis', '#7B86DB', 0],
        [90, 94, 'Legendary', 'Apex', '#F0C95C', 1],
        [95, 99, 'Titan', 'Apex', '#F0C95C', 0],
        [100, 100, 'Borealis Sovereign', 'Crown', '#FFD700', 1],
      ];
      const stmt = db.prepare('INSERT INTO level_definitions (min_level, max_level, title, tier, tier_color, is_milestone) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of levels) stmt.run(...l);
      logger.info('Seeded 21 level definitions for Academy progression');
    }
  }

  // ── Seed Badge Definitions ────────────────────────────────────────────────
  {
    const badgeCount = (db.prepare('SELECT COUNT(*) as cnt FROM badge_definitions').get() as { cnt: number }).cnt;
    if (badgeCount === 0) {
      const now = Date.now();
      const badges = [
        // Learning badges
        ['first-steps', 'First Steps', 'Earned your first XP', 'learning', 'common', 'xp_total', 1, 10],
        ['quick-learner', 'Quick Learner', 'Reached 500 XP', 'learning', 'common', 'xp_total', 500, 20],
        ['knowledge-seeker', 'Knowledge Seeker', 'Reached 2,500 XP', 'learning', 'uncommon', 'xp_total', 2500, 30],
        ['scholar', 'Scholar', 'Reached 10,000 XP', 'learning', 'rare', 'xp_total', 10000, 40],
        ['master-mind', 'Master Mind', 'Reached 50,000 XP', 'learning', 'epic', 'xp_total', 50000, 50],
        ['enlightened', 'Enlightened', 'Reached 250,000 XP', 'learning', 'legendary', 'xp_total', 250000, 60],

        // Streak badges
        ['on-fire', 'On Fire', '3-day login streak', 'streak', 'common', 'streak', 3, 100],
        ['dedicated', 'Dedicated', '7-day login streak', 'streak', 'uncommon', 'streak', 7, 110],
        ['unstoppable', 'Unstoppable', '14-day login streak', 'streak', 'rare', 'streak', 14, 120],
        ['relentless', 'Relentless', '30-day login streak', 'streak', 'epic', 'streak', 30, 130],
        ['eternal-flame', 'Eternal Flame', '100-day login streak', 'streak', 'legendary', 'streak', 100, 140],

        // Game badges
        ['game-starter', 'Game Starter', 'Played your first game', 'learning', 'common', 'games_played', 1, 200],
        ['game-enthusiast', 'Game Enthusiast', 'Played 25 games', 'learning', 'uncommon', 'games_played', 25, 210],
        ['game-master', 'Game Master', 'Played 100 games', 'learning', 'rare', 'games_played', 100, 220],

        // Contribution badges
        ['first-voice', 'First Voice', 'Made your first contribution', 'contribution', 'common', 'contributions', 1, 300],
        ['active-contributor', 'Active Contributor', '10 contributions', 'contribution', 'uncommon', 'contributions', 10, 310],
        ['thought-leader', 'Thought Leader', '50 contributions', 'contribution', 'rare', 'contributions', 50, 320],
        ['community-pillar', 'Community Pillar', '200 contributions', 'contribution', 'epic', 'contributions', 200, 330],

        // Milestone badges (level-based)
        ['level-10', 'Bronze Ascension', 'Reached Level 10', 'milestone', 'uncommon', 'level', 10, 400],
        ['level-25', 'Silver Ascension', 'Reached Level 25', 'milestone', 'rare', 'level', 25, 410],
        ['level-50', 'Diamond Ascension', 'Reached Level 50', 'milestone', 'epic', 'level', 50, 420],
        ['level-75', 'Aurora Ascension', 'Reached Level 75', 'milestone', 'legendary', 'level', 75, 430],
        ['level-100', 'Crown Bearer', 'Reached Level 100 — Borealis Sovereign', 'milestone', 'legendary', 'level', 100, 440],

        // Special / founding badges
        ['founding-member', 'Founding Member', 'Joined during Academy beta', 'special', 'legendary', 'manual', 0, 500],
        ['early-adopter', 'Early Adopter', 'Among the first 100 users', 'special', 'epic', 'manual', 0, 510],

        // AP rank badges
        ['contributor-bronze', 'Bronze Contributor', 'Earned 100 AP', 'contribution', 'common', 'ap_total', 100, 600],
        ['contributor-silver', 'Silver Contributor', 'Earned 500 AP', 'contribution', 'uncommon', 'ap_total', 500, 610],
        ['contributor-gold', 'Gold Contributor', 'Earned 2,000 AP', 'contribution', 'rare', 'ap_total', 2000, 620],
        ['contributor-diamond', 'Diamond Contributor', 'Earned 10,000 AP', 'contribution', 'epic', 'ap_total', 10000, 630],
      ];

      // Generic SVG badge icon (category-colored in frontend)
      const defaultSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

      const stmt = db.prepare('INSERT INTO badge_definitions (id, name, description, category, icon_svg, rarity, requirement_type, requirement_value, sort_order, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)');
      for (const b of badges) {
        stmt.run(b[0], b[1], b[2], b[3], defaultSvg, b[4], b[5], b[6], b[7], now);
      }
      logger.info(`Seeded ${badges.length} badge definitions for Academy progression`);
    }
  }

  // ── The Spark — Trust Token Economy & Learning Engine ──────────────────────
  // CORE DESIGN: 1 Trust Token (TT) = 1 XP earned through Spark lessons.
  // spendable_xp on user_progression tracks the wallet balance.
  // Every TT traces back to a real learning moment — no pay-to-win, no inflation.

  // Migrate: add spendable_xp to user_progression (Trust Token wallet)
  const progCols = (db.prepare("PRAGMA table_info(user_progression)").all() as Array<{ name: string }>).map(r => r.name);
  if (!progCols.includes('spendable_xp')) {
    db.exec("ALTER TABLE user_progression ADD COLUMN spendable_xp INTEGER NOT NULL DEFAULT 0");
    // Backfill: give existing users their full XP as spendable (one-time grant)
    db.exec("UPDATE user_progression SET spendable_xp = xp_total");
    logger.info('Migrated user_progression: added spendable_xp (Trust Token wallet)');
  }
  if (!progCols.includes('selected_guide')) {
    db.exec("ALTER TABLE user_progression ADD COLUMN selected_guide TEXT DEFAULT NULL");
    logger.info('Migrated user_progression: added selected_guide column');
  }

  // Trust Guides — Nova (gold, AI Safety), Ember (violet, Creating with AI), Luma (emerald, Privacy)
  db.exec(`
    CREATE TABLE IF NOT EXISTS spark_guides (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      color TEXT NOT NULL,
      icon_svg TEXT NOT NULL DEFAULT '',
      tagline TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);

  // Spark Lessons — Curiosity Hook structure: Hook → Adventure → Reflection
  db.exec(`
    CREATE TABLE IF NOT EXISTS spark_lessons (
      id TEXT PRIMARY KEY,
      guide_id TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      difficulty TEXT NOT NULL DEFAULT 'beginner',
      xp_reward INTEGER NOT NULL DEFAULT 50,
      hook_question TEXT NOT NULL DEFAULT '',
      hook_scenario TEXT NOT NULL DEFAULT '',
      adventure_content TEXT NOT NULL DEFAULT '',
      adventure_interactive TEXT NOT NULL DEFAULT '',
      reflection_prompt TEXT NOT NULL DEFAULT '',
      reflection_choices TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      age_min INTEGER NOT NULL DEFAULT 5,
      age_max INTEGER NOT NULL DEFAULT 12,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (guide_id) REFERENCES spark_guides(id)
    );
    CREATE INDEX IF NOT EXISTS idx_spark_lessons_guide ON spark_lessons(guide_id, sort_order);
  `);

  // Spark Lesson Progress — tracks each child's journey through lessons
  db.exec(`
    CREATE TABLE IF NOT EXISTS spark_progress (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      hook_completed INTEGER NOT NULL DEFAULT 0,
      adventure_completed INTEGER NOT NULL DEFAULT 0,
      reflection_completed INTEGER NOT NULL DEFAULT 0,
      reflection_answer TEXT,
      xp_awarded INTEGER NOT NULL DEFAULT 0,
      time_spent_seconds INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (lesson_id) REFERENCES spark_lessons(id),
      UNIQUE(user_id, lesson_id)
    );
    CREATE INDEX IF NOT EXISTS idx_spark_progress_user ON spark_progress(user_id, status);
  `);

  // Spark Shop — items purchasable with Trust Tokens (spendable_xp)
  db.exec(`
    CREATE TABLE IF NOT EXISTS spark_shop_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'avatar',
      item_type TEXT NOT NULL DEFAULT 'cosmetic',
      price_tt INTEGER NOT NULL,
      icon_svg TEXT NOT NULL DEFAULT '',
      rarity TEXT NOT NULL DEFAULT 'common',
      guide_requirement TEXT,
      level_requirement INTEGER NOT NULL DEFAULT 0,
      limited_stock INTEGER,
      sold_count INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spark_shop_category ON spark_shop_items(category, active);
  `);

  // Spark Purchases — immutable purchase log
  db.exec(`
    CREATE TABLE IF NOT EXISTS spark_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      price_tt INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      purchased_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (item_id) REFERENCES spark_shop_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_spark_purchases_user ON spark_purchases(user_id, purchased_at DESC);
  `);

  // Spark Avatar — each user's equipped cosmetics
  db.exec(`
    CREATE TABLE IF NOT EXISTS spark_avatar (
      user_id TEXT PRIMARY KEY,
      avatar_base TEXT NOT NULL DEFAULT 'default',
      hat_item_id TEXT,
      outfit_item_id TEXT,
      accessory_item_id TEXT,
      background_item_id TEXT,
      title_item_id TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Spark Parent Links — connect child accounts to parent BorealisMark accounts
  db.exec(`
    CREATE TABLE IF NOT EXISTS spark_parent_links (
      id TEXT PRIMARY KEY,
      parent_user_id TEXT NOT NULL,
      child_user_id TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '{"view_progress":true,"time_controls":true,"content_filter":true}',
      daily_time_limit_minutes INTEGER DEFAULT 60,
      active INTEGER NOT NULL DEFAULT 1,
      linked_at INTEGER NOT NULL,
      FOREIGN KEY (parent_user_id) REFERENCES users(id),
      FOREIGN KEY (child_user_id) REFERENCES users(id),
      UNIQUE(parent_user_id, child_user_id)
    );
  `);

  // ─── Debate Pipeline Tables ──────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS debate_sources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_url TEXT NOT NULL UNIQUE,
      source_name TEXT NOT NULL,
      author TEXT,
      published_at INTEGER,
      fetched_at INTEGER NOT NULL,
      topic_tags TEXT DEFAULT '[]',
      used_in_debate INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_debate_sources_fetched ON debate_sources(fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_debate_sources_used ON debate_sources(used_in_debate);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS debates (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      question TEXT NOT NULL,
      summary TEXT,
      source_article_id TEXT,
      source_url TEXT,
      source_name TEXT,
      source_title TEXT,
      exchanges TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      published INTEGER NOT NULL DEFAULT 0,
      featured INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      published_at INTEGER,
      FOREIGN KEY (source_article_id) REFERENCES debate_sources(id)
    );
    CREATE INDEX IF NOT EXISTS idx_debates_featured ON debates(featured, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_debates_status ON debates(status);
    CREATE INDEX IF NOT EXISTS idx_debates_created ON debates(created_at DESC);
  `);

  // Seed the three Trust Guides if they don't exist
  {
    const guideCount = (db.prepare("SELECT COUNT(*) as cnt FROM spark_guides").get() as { cnt: number }).cnt;
    if (guideCount === 0) {
      const now = Date.now();
      const guideStmt = db.prepare(
        'INSERT INTO spark_guides (id, slug, name, domain, color, tagline, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      guideStmt.run(
        'guide-nova', 'nova', 'Nova', 'AI Safety & Verification', '#d4a853',
        'The Verifier — Can we trust what AI tells us?',
        'Nova teaches you how to verify AI outputs, spot misinformation, and understand when AI gets things right — and when it doesn\'t. Every lesson builds your ability to think critically about artificial intelligence.',
        1, now
      );

      guideStmt.run(
        'guide-ember', 'ember', 'Ember', 'Creating with AI', '#A594E0',
        'The Builder — What can we create with AI?',
        'Ember shows you how to create responsibly with AI tools — from art and stories to code and music. Learn the ethics of AI-generated content and become a confident, responsible creator.',
        2, now
      );

      guideStmt.run(
        'guide-luma', 'luma', 'Luma', 'Privacy & Data Protection', '#34d399',
        'The Protector — How do we keep our data safe?',
        'Luma guards your digital identity. Learn about privacy, data protection, and why your personal information matters. Every lesson makes you stronger at protecting yourself online.',
        3, now
      );

      logger.info('Seeded 3 Trust Guides: Nova, Ember, Luma');
    }
  }

  // Seed starter lessons for each guide
  {
    const lessonCount = (db.prepare("SELECT COUNT(*) as cnt FROM spark_lessons").get() as { cnt: number }).cnt;
    if (lessonCount === 0) {
      const now = Date.now();
      const lessonStmt = db.prepare(
        'INSERT INTO spark_lessons (id, guide_id, title, slug, description, difficulty, xp_reward, hook_question, hook_scenario, adventure_content, adventure_interactive, reflection_prompt, reflection_choices, sort_order, age_min, age_max, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      // ── Nova Lessons (AI Safety & Verification) ──
      lessonStmt.run(
        'lesson-nova-01', 'guide-nova',
        'Can AI Make Mistakes?', 'can-ai-make-mistakes',
        'Discover that even the smartest AI can get things wrong — and learn how to spot it.',
        'beginner', 50,
        'If a robot told you the sky is green, would you believe it?',
        'Your friend shows you a homework answer that an AI chatbot gave them. It looks right... but something feels off. Can you figure out what the AI got wrong?',
        JSON.stringify({
          sections: [
            { type: 'text', content: 'AI is trained on lots of information — but it doesn\'t actually understand things the way you do. Sometimes it mixes up facts or makes things up entirely. This is called a "hallucination."' },
            { type: 'example', content: 'An AI was asked: "When was the Eiffel Tower built?" It answered: "1887." The real answer is 1889. Close — but wrong!' },
            { type: 'text', content: 'That\'s why we always verify. Verification means checking if something is true by looking at more than one source.' }
          ]
        }),
        JSON.stringify({
          type: 'spot-the-error',
          prompt: 'The AI says: "The Great Wall of China is 500 miles long." Is this correct?',
          options: [
            { text: 'Yes, that sounds right!', correct: false, feedback: 'Not quite! The Great Wall is actually about 13,000 miles long. The AI was way off!' },
            { text: 'No — I should check another source', correct: true, feedback: 'Exactly! The Great Wall is about 13,000 miles. Always verify big claims!' },
            { text: 'I\'m not sure, but I\'ll trust the AI', correct: false, feedback: 'When you\'re not sure, that\'s the BEST time to check! Never trust blindly.' }
          ]
        }),
        'Now that you know AI can make mistakes, what\'s the most important thing to do when AI gives you an answer?',
        JSON.stringify([
          { text: 'Always check with another source', value: 'verify', correct: true },
          { text: 'Trust it because it\'s a computer', value: 'trust', correct: false },
          { text: 'Ignore it completely', value: 'ignore', correct: false },
          { text: 'Ask a friend if it sounds right', value: 'ask', correct: true }
        ]),
        1, 6, 12, now, now
      );

      lessonStmt.run(
        'lesson-nova-02', 'guide-nova',
        'What is a Deepfake?', 'what-is-a-deepfake',
        'Learn how AI can create fake videos and images — and how to protect yourself from being fooled.',
        'intermediate', 75,
        'What if you saw a video of your favourite celebrity saying something wild — but it never actually happened?',
        'A video is going viral online showing a famous scientist saying homework should be banned forever. Millions of people are sharing it. But Nova has a hunch something isn\'t right...',
        JSON.stringify({
          sections: [
            { type: 'text', content: 'A deepfake is a video, image, or audio clip created by AI to look and sound like a real person — but it\'s completely made up.' },
            { type: 'text', content: 'Deepfakes work by studying thousands of photos and videos of someone, then learning to copy their face, voice, and movements.' },
            { type: 'tip', content: 'Look for clues: blurry edges around the face, weird blinking, lips that don\'t quite match the words, or lighting that doesn\'t match the background.' }
          ]
        }),
        JSON.stringify({
          type: 'detective',
          prompt: 'Which of these clues might tell you a video is a deepfake?',
          options: [
            { text: 'The person\'s eyes never blink', correct: true, feedback: 'Good catch! Early deepfakes often forgot to include natural blinking.' },
            { text: 'The video is in high definition', correct: false, feedback: 'HD alone doesn\'t mean it\'s fake — deepfakes can be high quality too.' },
            { text: 'The lips don\'t match the words perfectly', correct: true, feedback: 'Yes! Audio-visual mismatch is one of the biggest deepfake tells.' },
            { text: 'The background has strange warping', correct: true, feedback: 'Exactly! AI sometimes struggles with consistent backgrounds.' }
          ],
          multiSelect: true
        }),
        'If someone sends you a shocking video of a public figure, what should you do first?',
        JSON.stringify([
          { text: 'Share it immediately — everyone needs to see this', value: 'share', correct: false },
          { text: 'Check if trusted news sources are reporting it', value: 'verify', correct: true },
          { text: 'Look for deepfake clues like lip-sync issues', value: 'inspect', correct: true },
          { text: 'Assume it\'s real because video doesn\'t lie', value: 'trust', correct: false }
        ]),
        2, 8, 12, now, now
      );

      // ── Ember Lessons (Creating with AI) ──
      lessonStmt.run(
        'lesson-ember-01', 'guide-ember',
        'Your First AI Creation', 'your-first-ai-creation',
        'Use AI as a creative partner — and learn why the human behind the keyboard always matters most.',
        'beginner', 50,
        'If AI can write stories and draw pictures, does that make it an artist?',
        'Ember hands you a magical sketchpad. You can ask AI to help you draw anything. But here\'s the twist — the AI needs YOUR ideas to make something amazing. Without you, it\'s just a blank page.',
        JSON.stringify({
          sections: [
            { type: 'text', content: 'AI tools can help you create incredible things — stories, art, music, even code. But AI doesn\'t have imagination. It learned from millions of human creations.' },
            { type: 'text', content: 'Think of AI as a super-powered assistant. YOU bring the ideas, the feelings, and the creativity. AI helps you build them faster.' },
            { type: 'example', content: 'When you tell AI to "draw a cat," it creates a generic cat. But when you say "draw a fluffy orange cat wearing a tiny astronaut helmet, floating in space with stars reflecting in its visor" — that\'s YOUR vision coming to life.' }
          ]
        }),
        JSON.stringify({
          type: 'creative-prompt',
          prompt: 'Which of these prompts would give the BEST result from an AI art tool?',
          options: [
            { text: 'Draw a dog', correct: false, feedback: 'This is too vague! The AI won\'t know what kind of dog, what style, or what mood you want.' },
            { text: 'A golden retriever puppy playing in autumn leaves, watercolor style, warm sunset lighting', correct: true, feedback: 'Perfect! Specific details = better results. You\'re the creative director!' },
            { text: 'Make something cool', correct: false, feedback: 'Cool means different things to everyone! AI needs specifics to match your vision.' }
          ]
        }),
        'When you use AI to help create something, who deserves the credit?',
        JSON.stringify([
          { text: 'The AI — it did all the work', value: 'ai', correct: false },
          { text: 'The human — because the ideas and direction came from them', value: 'human', correct: true },
          { text: 'It\'s a collaboration — both matter', value: 'both', correct: true },
          { text: 'Nobody — it just appeared', value: 'nobody', correct: false }
        ]),
        1, 6, 12, now, now
      );

      lessonStmt.run(
        'lesson-ember-02', 'guide-ember',
        'The Ethics of AI Art', 'ethics-of-ai-art',
        'When AI creates art, whose work is it based on? Learn about fairness in AI creativity.',
        'intermediate', 75,
        'If an AI learned to paint by studying a million paintings, does it owe those artists anything?',
        'A young artist discovers that an AI image generator can copy their unique style perfectly. They spent years developing that style. Now anyone can replicate it in seconds. Is that fair?',
        JSON.stringify({
          sections: [
            { type: 'text', content: 'AI art generators are trained on millions of images made by real human artists. The AI learns patterns, styles, and techniques from these works.' },
            { type: 'text', content: 'This creates a big question: if AI learned from human art, should those artists be credited or compensated? Different people have different opinions.' },
            { type: 'tip', content: 'Being an ethical AI creator means thinking about where the AI\'s abilities came from and being honest about using AI tools.' }
          ]
        }),
        JSON.stringify({
          type: 'debate',
          prompt: 'An AI can perfectly copy a famous artist\'s style. A company uses this to sell AI-generated art in that style. What\'s the most ethical approach?',
          options: [
            { text: 'It\'s fine — styles can\'t be owned', value: 'ok', feedback: 'Some people agree, but many artists feel their unique style represents years of hard work.' },
            { text: 'The original artist should be credited', value: 'credit', feedback: 'Crediting sources is a strong ethical position. Transparency builds trust.' },
            { text: 'The original artist should be paid', value: 'pay', feedback: 'Many artists advocate for compensation. This is an active area of debate and lawmaking.' },
            { text: 'AI shouldn\'t be allowed to copy specific styles', value: 'ban', feedback: 'Some platforms are adding opt-out features so artists can protect their work from AI training.' }
          ]
        }),
        'When you use AI to create something, what\'s the most responsible thing to do?',
        JSON.stringify([
          { text: 'Be transparent that AI helped create it', value: 'transparent', correct: true },
          { text: 'Pretend I made it all by hand', value: 'lie', correct: false },
          { text: 'Think about whose work the AI learned from', value: 'think', correct: true },
          { text: 'It doesn\'t matter as long as it looks good', value: 'ignore', correct: false }
        ]),
        2, 8, 12, now, now
      );

      // ── Luma Lessons (Privacy & Data Protection) ──
      lessonStmt.run(
        'lesson-luma-01', 'guide-luma',
        'Your Digital Footprint', 'your-digital-footprint',
        'Every click, like, and search leaves a trace. Learn what your digital footprint reveals about you.',
        'beginner', 50,
        'Did you know that every time you go online, you leave invisible footprints behind?',
        'Luma shows you a map of all the places you\'ve been online today. Every website, every search, every click — it\'s all there. Some of those footprints can be seen by people you\'ve never even met.',
        JSON.stringify({
          sections: [
            { type: 'text', content: 'Your digital footprint is the trail of data you leave behind when you use the internet. It includes everything: websites visited, things you\'ve searched for, photos you\'ve posted, and messages you\'ve sent.' },
            { type: 'text', content: 'There are two types: your active footprint (things you choose to share) and your passive footprint (data collected about you without you knowing).' },
            { type: 'example', content: 'Active: posting a photo on social media. Passive: a website tracking which pages you visit and how long you stay on each one.' }
          ]
        }),
        JSON.stringify({
          type: 'classify',
          prompt: 'Sort these into Active Footprint or Passive Footprint:',
          items: [
            { text: 'Posting a comment on a video', answer: 'active', feedback: 'Correct! You chose to post that — it\'s active.' },
            { text: 'A website using cookies to track you', answer: 'passive', feedback: 'Right! You didn\'t ask for tracking — that\'s passive.' },
            { text: 'Signing up for a new app', answer: 'active', feedback: 'Yes! You decided to share your info — active footprint.' },
            { text: 'Your phone recording your location', answer: 'passive', feedback: 'Exactly! Most people don\'t realize their location is being logged.' }
          ]
        }),
        'Now that you know about digital footprints, what\'s the smartest habit to build?',
        JSON.stringify([
          { text: 'Think before you post — it might be there forever', value: 'think', correct: true },
          { text: 'Never use the internet', value: 'avoid', correct: false },
          { text: 'Check your privacy settings regularly', value: 'settings', correct: true },
          { text: 'It doesn\'t matter — nobody looks at my data', value: 'ignore', correct: false }
        ]),
        1, 6, 12, now, now
      );

      lessonStmt.run(
        'lesson-luma-02', 'guide-luma',
        'Passwords: Your First Line of Defense', 'passwords-first-line-of-defense',
        'Learn why strong passwords matter and how to create ones that even AI can\'t crack.',
        'beginner', 50,
        'How long would it take a computer to guess your password?',
        'Luma runs a simulation: a basic password like "password123" takes a computer less than one second to crack. But a strong password? That could take millions of years. The difference is huge — and you\'re about to learn why.',
        JSON.stringify({
          sections: [
            { type: 'text', content: 'A password is like a lock on your digital life. A weak lock can be picked in seconds. A strong lock keeps everything safe.' },
            { type: 'text', content: 'Strong passwords are: long (12+ characters), use a mix of letters, numbers, and symbols, and avoid common words or patterns.' },
            { type: 'tip', content: 'Use a passphrase! String together random words: "purple-elephant-dances-tuesday" is much stronger than "P@ssw0rd!" and easier to remember.' }
          ]
        }),
        JSON.stringify({
          type: 'rank',
          prompt: 'Rank these passwords from weakest to strongest:',
          items: [
            { text: 'password123', rank: 1, feedback: 'This is literally the first thing hackers try. Never use this!' },
            { text: 'Fluffy2019!', rank: 2, feedback: 'Better, but pet names and years are too easy to guess from social media.' },
            { text: 'Kj$8mP2x!qZ', rank: 3, feedback: 'Strong but hard to remember. Good for a password manager!' },
            { text: 'correct-horse-battery-staple', rank: 4, feedback: 'Long passphrases are both strong AND memorable. This is the way!' }
          ]
        }),
        'What\'s the best strategy for managing all your passwords?',
        JSON.stringify([
          { text: 'Use the same password everywhere so I don\'t forget', value: 'reuse', correct: false },
          { text: 'Use a password manager to store unique passwords', value: 'manager', correct: true },
          { text: 'Write them on a sticky note on my monitor', value: 'sticky', correct: false },
          { text: 'Use unique passphrases for important accounts', value: 'passphrase', correct: true }
        ]),
        2, 6, 12, now, now
      );

      logger.info('Seeded 6 starter Spark lessons (2 per guide)');
    }
  }

  // Seed starter shop items
  {
    const shopCount = (db.prepare("SELECT COUNT(*) as cnt FROM spark_shop_items").get() as { cnt: number }).cnt;
    if (shopCount === 0) {
      const now = Date.now();
      const shopStmt = db.prepare(
        'INSERT INTO spark_shop_items (id, name, description, category, item_type, price_tt, rarity, guide_requirement, level_requirement, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      shopStmt.run('shop-hat-explorer', 'Explorer\'s Cap', 'A curious adventurer\'s hat. Shows you\'re ready to learn.', 'avatar', 'hat', 100, 'common', null, 0, now);
      shopStmt.run('shop-hat-nova', 'Nova\'s Verification Visor', 'A golden visor that glows when you spot misinformation.', 'avatar', 'hat', 250, 'uncommon', 'guide-nova', 2, now);
      shopStmt.run('shop-hat-ember', 'Ember\'s Creation Crown', 'A violet crown that sparkles with creative energy.', 'avatar', 'hat', 250, 'uncommon', 'guide-ember', 2, now);
      shopStmt.run('shop-hat-luma', 'Luma\'s Shield Helm', 'An emerald helm that protects your digital identity.', 'avatar', 'hat', 250, 'uncommon', 'guide-luma', 2, now);
      shopStmt.run('shop-bg-aurora', 'Aurora Background', 'A shimmering northern lights backdrop for your profile.', 'avatar', 'background', 200, 'common', null, 1, now);
      shopStmt.run('shop-bg-cosmos', 'Cosmic Background', 'Deep space with swirling galaxies.', 'avatar', 'background', 350, 'rare', null, 3, now);
      shopStmt.run('shop-title-curious', 'Title: Curious Mind', 'Display "Curious Mind" on your profile.', 'avatar', 'title', 150, 'common', null, 0, now);
      shopStmt.run('shop-title-verifier', 'Title: Truth Seeker', 'Display "Truth Seeker" on your profile. Requires Nova path.', 'avatar', 'title', 300, 'uncommon', 'guide-nova', 3, now);
      shopStmt.run('shop-title-creator', 'Title: Digital Artist', 'Display "Digital Artist" on your profile. Requires Ember path.', 'avatar', 'title', 300, 'uncommon', 'guide-ember', 3, now);
      shopStmt.run('shop-title-protector', 'Title: Data Guardian', 'Display "Data Guardian" on your profile. Requires Luma path.', 'avatar', 'title', 300, 'uncommon', 'guide-luma', 3, now);

      logger.info('Seeded 10 starter Spark shop items');
    }
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
  subscriptionExpiresAt: number | null;
  subscriptionMethod: 'stripe' | 'usdc' | null;
  subscriptionPlanId: string | null;
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
    subscriptionExpiresAt: row.subscription_expires_at as number | null,
    subscriptionMethod: row.subscription_method as 'stripe' | 'usdc' | null,
    subscriptionPlanId: row.subscription_plan_id as string | null,
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
  const db = getDb();
  const now = Date.now();
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
  // Record active login day for account age trust scoring
  const today = new Date(now).toISOString().split('T')[0]; // YYYY-MM-DD UTC
  db.prepare(
    'INSERT OR IGNORE INTO user_login_days (user_id, login_date, created_at) VALUES (?, ?, ?)'
  ).run(id, today, now);
}

export function getActiveLoginDays(userId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as cnt FROM user_login_days WHERE user_id = ?')
    .get(userId) as { cnt: number };
  return row.cnt;
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

// ─── Email Verification Queries ──────────────────────────────────────────────

/**
 * Set a user's email_verified status.
 */
export function setEmailVerified(userId: string, verified: boolean): void {
  getDb()
    .prepare('UPDATE users SET email_verified = ? WHERE id = ?')
    .run(verified ? 1 : 0, userId);
}

/**
 * Create an email verification token. Returns the raw token (sent in the email link).
 * Re-uses the password_reset_tokens table with a 'verify-email' prefix in the id.
 */
export function createEmailVerificationToken(userId: string, email: string): string {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const id = `ev-${uuidv4()}`;
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

  // Invalidate any existing unused verification tokens for this user
  getDb()
    .prepare("UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND id LIKE 'ev-%'")
    .run(now, userId);

  getDb()
    .prepare(
      'INSERT INTO password_reset_tokens (id, user_id, email, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, userId, email.toLowerCase().trim(), tokenHash, expiresAt, now);

  return rawToken;
}

/**
 * Look up a verification token by its raw value.
 * Returns null if not found, already used, or expired.
 */
export function getValidEmailVerificationToken(rawToken: string): PasswordResetTokenRecord | null {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const row = getDb()
    .prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND id LIKE 'ev-%'")
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

// ─── Subscription Expiry Helpers ──────────────────────────────────────────────

export function setSubscriptionExpiry(
  userId: string,
  expiresAt: number,
  method: 'stripe' | 'usdc',
  planId: string,
): void {
  getDb()
    .prepare(
      'UPDATE users SET subscription_expires_at = ?, subscription_method = ?, subscription_plan_id = ? WHERE id = ?',
    )
    .run(expiresAt, method, planId, userId);
}

export function getExpiredUsdcSubscriptions(): UserRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM users WHERE subscription_method = 'usdc' AND subscription_expires_at < ? AND tier != 'standard' AND active = 1",
    )
    .all(Date.now()) as Array<Record<string, unknown>>;
  return rows.map(rowToUser);
}

/**
 * Get all expired subscriptions (any method) as a safety net.
 * Catches Stripe subscriptions where webhook was missed.
 */
export function getAllExpiredSubscriptions(): UserRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM users WHERE subscription_expires_at IS NOT NULL AND subscription_expires_at < ? AND tier != 'standard' AND active = 1",
    )
    .all(Date.now()) as Array<Record<string, unknown>>;
  return rows.map(rowToUser);
}

/**
 * Get users whose subscription expires within the given window (for reminders).
 * Returns users who haven't been reminded yet within this window.
 */
export function getExpiringSubscriptions(withinMs: number): UserRecord[] {
  const now = Date.now();
  const cutoff = now + withinMs;
  const rows = getDb()
    .prepare(
      "SELECT * FROM users WHERE subscription_expires_at IS NOT NULL AND subscription_expires_at > ? AND subscription_expires_at <= ? AND tier != 'standard' AND active = 1",
    )
    .all(now, cutoff) as Array<Record<string, unknown>>;
  return rows.map(rowToUser);
}

/**
 * Get a user's active bots sorted by least active (for deactivation on downgrade).
 * Sorts by: jobs_completed ASC, ap_points ASC, last active ASC — least valuable first.
 */
export function getBotsByOwnerSortedByActivity(ownerId: string): BotRecord[] {
  return getDb().prepare(
    "SELECT * FROM bots WHERE owner_id = ? AND status = 'active' ORDER BY jobs_completed ASC, ap_points ASC, star_rating ASC, created_at DESC",
  ).all(ownerId) as BotRecord[];
}

/**
 * Deactivate a bot by ID (soft delete — sets status to 'suspended').
 */
export function suspendBot(botId: string): void {
  getDb().prepare(
    "UPDATE bots SET status = 'suspended', updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), botId);
}

// ─── Coupon Queries ──────────────────────────────────────────────────────────

export interface CouponRecord {
  id: string;
  code: string;
  discountPercent: number;
  validFrom: number;
  validUntil: number | null;
  maxUses: number | null;
  timesUsed: number;
  planRestriction: string | null;
  renewalOnly: boolean;
  createdBy: string | null;
  createdAt: number;
  active: boolean;
}

function rowToCoupon(row: Record<string, unknown>): CouponRecord {
  return {
    id: row.id as string,
    code: row.code as string,
    discountPercent: row.discount_percent as number,
    validFrom: row.valid_from as number,
    validUntil: row.valid_until as number | null,
    maxUses: row.max_uses as number | null,
    timesUsed: row.times_used as number,
    planRestriction: row.plan_restriction as string | null,
    renewalOnly: (row.renewal_only as number) === 1,
    createdBy: row.created_by as string | null,
    createdAt: row.created_at as number,
    active: (row.active as number) === 1,
  };
}

export function createCoupon(coupon: {
  id: string;
  code: string;
  discountPercent: number;
  validFrom: number;
  validUntil?: number;
  maxUses?: number;
  planRestriction?: string;
  renewalOnly?: boolean;
  createdBy?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO coupons (id, code, discount_percent, valid_from, valid_until, max_uses, plan_restriction, renewal_only, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      coupon.id, coupon.code.toUpperCase().trim(), coupon.discountPercent,
      coupon.validFrom, coupon.validUntil ?? null, coupon.maxUses ?? null,
      coupon.planRestriction ?? null, coupon.renewalOnly ? 1 : 0,
      coupon.createdBy ?? null, Date.now(),
    );
}

export function getCouponByCode(code: string): CouponRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM coupons WHERE code = ? AND active = 1')
    .get(code.toUpperCase().trim()) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToCoupon(row);
}

export function getCouponById(id: string): CouponRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM coupons WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToCoupon(row);
}

export function listCoupons(): CouponRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM coupons ORDER BY created_at DESC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToCoupon);
}

export function incrementCouponUsage(id: string): void {
  getDb()
    .prepare('UPDATE coupons SET times_used = times_used + 1 WHERE id = ?')
    .run(id);
}

export function deactivateCoupon(id: string): void {
  getDb()
    .prepare('UPDATE coupons SET active = 0 WHERE id = ?')
    .run(id);
}

export function validateCoupon(
  code: string,
  planId: string,
  isRenewal: boolean,
): { valid: boolean; coupon?: CouponRecord; reason?: string } {
  const coupon = getCouponByCode(code);
  if (!coupon) return { valid: false, reason: 'Coupon not found' };
  if (!coupon.active) return { valid: false, reason: 'Coupon is inactive' };

  const now = Date.now();
  if (now < coupon.validFrom) return { valid: false, reason: 'Coupon is not yet valid' };
  if (coupon.validUntil && now > coupon.validUntil) return { valid: false, reason: 'Coupon has expired' };
  if (coupon.maxUses && coupon.timesUsed >= coupon.maxUses) return { valid: false, reason: 'Coupon usage limit reached' };
  if (coupon.planRestriction && coupon.planRestriction !== planId) {
    return { valid: false, reason: `Coupon only valid for ${coupon.planRestriction} plan` };
  }
  if (coupon.renewalOnly && !isRenewal) return { valid: false, reason: 'Coupon is only valid for renewals' };

  return { valid: true, coupon };
}

// ─── Enhanced USDC Invoice Save (with discount fields) ───────────────────────

export function saveUsdcInvoiceWithDiscount(invoice: {
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
  couponId?: string;
  discountPercent?: number;
  originalAmountUsd?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO usdc_invoices
        (invoice_id, plan_id, email, agent_id, amount_usd, amount_usdc,
         treasury_account_id, token_id, memo, status, created_at, expires_at,
         coupon_id, discount_percent, original_amount_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      invoice.invoiceId, invoice.planId, invoice.email ?? null, invoice.agentId ?? null,
      invoice.amountUsd, invoice.amountUsdc, invoice.treasuryAccountId, invoice.tokenId,
      invoice.memo, Date.now(), invoice.expiresAt,
      invoice.couponId ?? null, invoice.discountPercent ?? 0, invoice.originalAmountUsd ?? null,
    );
}

// ─── Agent Queries ────────────────────────────────────────────────────────────

export function registerAgent(
  id: string,
  name: string,
  description: string,
  version: string,
  registrantKeyId: string,
  ownerUserId?: string,
  agentType?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO agents (id, name, description, version, registered_at, registrant_key_id, owner_user_id, agent_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, description, version, Date.now(), registrantKeyId, ownerUserId ?? null, agentType ?? 'other');
}

export function getAgent(id: string): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

// ─── Dashboard Agent Queries (JWT-authenticated) ──────────────────────────────

export function getAgentsByUserId(userId: string): Record<string, unknown>[] {
  return getDb()
    .prepare('SELECT * FROM agents WHERE owner_user_id = ? ORDER BY registered_at DESC')
    .all(userId) as Record<string, unknown>[];
}

export function getAgentByIdAndOwner(agentId: string, userId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare('SELECT * FROM agents WHERE id = ? AND owner_user_id = ?')
    .get(agentId, userId) as Record<string, unknown> | undefined;
}

export function updateAgent(agentId: string, userId: string, updates: { name?: string; description?: string; version?: string; agent_type?: string }): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.version !== undefined) { fields.push('version = ?'); values.push(updates.version); }
  if (updates.agent_type !== undefined) { fields.push('agent_type = ?'); values.push(updates.agent_type); }
  if (fields.length === 0) return false;
  values.push(agentId, userId);
  const result = getDb()
    .prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ? AND owner_user_id = ?`)
    .run(...values);
  return result.changes > 0;
}

export function softDeleteAgent(agentId: string, userId: string): boolean {
  const result = getDb()
    .prepare('UPDATE agents SET active = 0 WHERE id = ? AND owner_user_id = ?')
    .run(agentId, userId);
  return result.changes > 0;
}

export function getCertificatesByAgentId(agentId: string): Record<string, unknown>[] {
  return getDb()
    .prepare('SELECT * FROM audit_certificates WHERE agent_id = ? ORDER BY issued_at DESC')
    .all(agentId) as Record<string, unknown>[];
}

export function getCertificatesByUserId(userId: string): Record<string, unknown>[] {
  return getDb()
    .prepare(
      `SELECT ac.* FROM audit_certificates ac
       JOIN agents a ON ac.agent_id = a.id
       WHERE a.owner_user_id = ?
       ORDER BY ac.issued_at DESC`,
    )
    .all(userId) as Record<string, unknown>[];
}

export function toggleAgentPublicListing(agentId: string, userId: string, publicListing: boolean): boolean {
  const result = getDb()
    .prepare('UPDATE agents SET public_listing = ? WHERE id = ? AND owner_user_id = ?')
    .run(publicListing ? 1 : 0, agentId, userId);
  return result.changes > 0;
}

export function getPublicAgents(limit: number = 50, offset: number = 0): Record<string, unknown>[] {
  return getDb()
    .prepare(
      `SELECT a.*, ac.score_total, ac.credit_rating, ac.certificate_id, ac.issued_at as last_audit_at
       FROM agents a
       LEFT JOIN (
         SELECT agent_id, score_total, credit_rating, certificate_id, issued_at,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY issued_at DESC) as rn
         FROM audit_certificates WHERE revoked = 0
       ) ac ON a.id = ac.agent_id AND ac.rn = 1
       WHERE a.active = 1 AND a.public_listing = 1
       ORDER BY ac.score_total DESC NULLS LAST
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Record<string, unknown>[];
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

// ─── Trust Deposit Functions (formerly Staking) ─────────────────────────────
// CORE PRINCIPLE: BorealisMark is the data layer, not the risk layer.
// Agents deposit USDC to signal trust commitment. Penalties forfeit to treasury.

/**
 * Creates a new trust deposit for an agent. Deactivates any previous deposit.
 * Migration note: Uses stakes table for backward compatibility.
 */
export function createTrustDeposit(
  id: string,
  agentId: string,
  usdcAmount: number,
  tier: string,
): void {
  getDb().prepare('UPDATE stakes SET active = 0 WHERE agent_id = ?').run(agentId);
  getDb()
    .prepare(
      'INSERT INTO stakes (id, agent_id, bmt_amount, usdc_coverage, tier, allocated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, agentId, usdcAmount, usdcAmount, tier, Date.now());
}

/**
 * Retrieves the active trust deposit for an agent.
 * Migration note: Returns record from stakes table where usdc_coverage is the USDC amount.
 */
export function getActiveTrustDeposit(agentId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare('SELECT * FROM stakes WHERE agent_id = ? AND active = 1')
    .get(agentId) as Record<string, unknown> | undefined;
}

/**
 * Records a penalty event when an agent violates protocol constraints.
 * Forfeited USDC goes to BorealisMark protocol treasury, NOT to a claimant.
 * Migration note: Uses slash_events table with claimant_address set to protocol treasury address.
 */
export function recordPenalty(
  id: string,
  depositId: string,
  agentId: string,
  violationType: string,
  amountForfeited: number,
  hcsTransactionId?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO slash_events (id, stake_id, agent_id, violation_type, amount_slashed, claimant_address, executed_at, hcs_transaction_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, depositId, agentId, violationType, amountForfeited, 'PROTOCOL_TREASURY', Date.now(), hcsTransactionId ?? null);
  getDb().prepare('UPDATE stakes SET active = 0 WHERE id = ?').run(depositId);
}

// ─── Backward Compatibility Aliases ──────────────────────────────────────────

/**
 * @deprecated Use createTrustDeposit instead
 */
export function allocateStake(
  id: string,
  agentId: string,
  bmtAmount: number,
  usdcCoverage: number,
  tier: string,
): void {
  return createTrustDeposit(id, agentId, usdcCoverage, tier);
}

/**
 * @deprecated Use getActiveTrustDeposit instead
 */
export function getActiveStake(agentId: string): Record<string, unknown> | undefined {
  return getActiveTrustDeposit(agentId);
}

/**
 * @deprecated Use recordPenalty instead
 */
export function recordSlash(
  id: string,
  stakeId: string,
  agentId: string,
  violationType: string,
  amountSlashed: number,
  claimantAddress: string,
  hcsTransactionId?: string,
): void {
  // Ignore claimantAddress; always forfeit to protocol treasury
  return recordPenalty(id, stakeId, agentId, violationType, amountSlashed, hcsTransactionId);
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

// ─── API Tiers Seeding ──────────────────────────────────────────────────────

export function seedApiTiers(): void {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as count FROM api_tiers').get() as { count: number };
  if (existing.count > 0) return; // Already seeded

  const tiers = [
    { id: 'tier_free', name: 'free', displayName: 'Free', monthlyLimit: 5000, maxAgents: 3, maxWebhooks: 0, rateLimit: 20, priceCents: 0, stripePriceId: null },
    { id: 'tier_starter', name: 'starter', displayName: 'Starter', monthlyLimit: 25000, maxAgents: 10, maxWebhooks: 5, rateLimit: 100, priceCents: 2900, stripePriceId: 'price_1T8raFJ5qkaENvhUv88yTKQH' },
    { id: 'tier_business', name: 'business', displayName: 'Business', monthlyLimit: 100000, maxAgents: 50, maxWebhooks: 25, rateLimit: 300, priceCents: 14900, stripePriceId: 'price_1T8ragJ5qkaENvhUtXAti480' },
    { id: 'tier_enterprise', name: 'enterprise', displayName: 'Enterprise', monthlyLimit: 1000000, maxAgents: -1, maxWebhooks: -1, rateLimit: 1000, priceCents: 49900, stripePriceId: 'price_1T8rbcJ5qkaENvhUF65knR1q' },
  ];

  const stmt = db.prepare(
    `INSERT INTO api_tiers (id, name, display_name, monthly_request_limit, max_agents, max_webhooks, rate_limit_per_min, price_monthly_cents, stripe_price_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const t of tiers) {
    stmt.run(t.id, t.name, t.displayName, t.monthlyLimit, t.maxAgents, t.maxWebhooks, t.rateLimit, t.priceCents, t.stripePriceId);
  }
}

// ─── API Usage Queries ──────────────────────────────────────────────────────

export function recordApiUsage(apiKeyId: string, endpoint: string, method: string, statusCode: number, responseTimeMs: number): void {
  const now = Date.now();
  const monthKey = new Date(now).toISOString().slice(0, 7); // 'YYYY-MM'
  getDb()
    .prepare(
      'INSERT INTO api_usage (id, api_key_id, endpoint, method, status_code, response_time_ms, timestamp, month_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(uuidv4(), apiKeyId, endpoint, method, statusCode, responseTimeMs, now, monthKey);

  // Also increment the usage_count on the key itself
  getDb()
    .prepare('UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?')
    .run(now, apiKeyId);
}

export function getMonthlyUsageCount(apiKeyId: string, monthKey?: string): number {
  const mk = monthKey ?? new Date().toISOString().slice(0, 7);
  const result = getDb()
    .prepare('SELECT COUNT(*) as count FROM api_usage WHERE api_key_id = ? AND month_key = ?')
    .get(apiKeyId, mk) as { count: number };
  return result.count;
}

export function getMonthlyUsageByUser(userId: string, monthKey?: string): { totalRequests: number; byKey: Array<{ keyId: string; keyName: string; count: number }> } {
  const mk = monthKey ?? new Date().toISOString().slice(0, 7);
  const db = getDb();

  // Get all API keys owned by this user (keys are linked by checking if the user created them)
  // Since api_keys don't have a direct user_id, we get usage across all keys
  // For now, return aggregate usage - the JWT usage endpoint will filter by user's keys
  const rows = db.prepare(
    `SELECT ak.id as key_id, ak.name as key_name, COUNT(au.id) as request_count
     FROM api_keys ak
     LEFT JOIN api_usage au ON ak.id = au.api_key_id AND au.month_key = ?
     WHERE ak.revoked = 0
     GROUP BY ak.id, ak.name`
  ).all(mk) as Array<{ key_id: string; key_name: string; request_count: number }>;

  const total = rows.reduce((sum, r) => sum + r.request_count, 0);
  return {
    totalRequests: total,
    byKey: rows.map(r => ({ keyId: r.key_id, keyName: r.key_name, count: r.request_count })),
  };
}

export function getApiTier(tierName: string): { id: string; name: string; displayName: string; monthlyRequestLimit: number; maxAgents: number; maxWebhooks: number; rateLimitPerMin: number; priceMonthly: number; stripePriceId: string | null } | null {
  const row = getDb()
    .prepare('SELECT * FROM api_tiers WHERE name = ?')
    .get(tierName) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    displayName: row.display_name as string,
    monthlyRequestLimit: row.monthly_request_limit as number,
    maxAgents: row.max_agents as number,
    maxWebhooks: row.max_webhooks as number,
    rateLimitPerMin: row.rate_limit_per_min as number,
    priceMonthly: (row.price_monthly_cents as number) / 100,
    stripePriceId: row.stripe_price_id as string | null,
  };
}

export function getAllApiTiers(): Array<{ id: string; name: string; displayName: string; monthlyRequestLimit: number; maxAgents: number; maxWebhooks: number; rateLimitPerMin: number; priceMonthly: number; stripePriceId: string | null }> {
  const rows = getDb()
    .prepare('SELECT * FROM api_tiers ORDER BY monthly_request_limit ASC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as string,
    name: row.name as string,
    displayName: row.display_name as string,
    monthlyRequestLimit: row.monthly_request_limit as number,
    maxAgents: row.max_agents as number,
    maxWebhooks: row.max_webhooks as number,
    rateLimitPerMin: row.rate_limit_per_min as number,
    priceMonthly: (row.price_monthly_cents as number) / 100,
    stripePriceId: row.stripe_price_id as string | null,
  }));
}

export function getApiKeyTier(apiKeyId: string): string {
  const row = getDb()
    .prepare('SELECT tier FROM api_keys WHERE id = ?')
    .get(apiKeyId) as { tier: string } | undefined;
  return row?.tier ?? 'free';
}

// ─── Webhook Dead Letter Queries ────────────────────────────────────────────

export function insertDeadLetter(webhookId: string, eventType: string, payload: string, lastError: string, attempts: number): void {
  getDb()
    .prepare(
      'INSERT INTO webhook_dead_letters (id, webhook_id, event_type, payload, last_error, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(uuidv4(), webhookId, eventType, payload, lastError, attempts, Date.now());
}

export function getDeadLetters(limit: number = 50): Record<string, unknown>[] {
  return getDb()
    .prepare('SELECT * FROM webhook_dead_letters WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
}

export function resolveDeadLetter(id: string): boolean {
  const result = getDb()
    .prepare('UPDATE webhook_dead_letters SET resolved_at = ? WHERE id = ?')
    .run(Date.now(), id);
  return result.changes > 0;
}

export function getDeadLetterById(id: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare('SELECT * FROM webhook_dead_letters WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
}

export function updateWebhookDeliveryStatus(webhookId: string, status: string): void {
  getDb()
    .prepare('UPDATE webhooks SET last_delivery_status = ?, last_delivery_at = ? WHERE id = ?')
    .run(status, Date.now(), webhookId);
}

// ─── Storefront CRUD (BundlesofJoy Integration) ─────────────────────────────

export function createStorefront(userId: string, slug: string, storeName: string, description?: string): string {
  const id = uuidv4();
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO seller_storefronts (id, user_id, slug, store_name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(id, userId, slug, storeName, description ?? null, now, now);
  return id;
}

export function getStorefrontBySlug(slug: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare('SELECT * FROM seller_storefronts WHERE slug = ?')
    .get(slug) as Record<string, unknown> | undefined;
}

export function getStorefrontByUserId(userId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare('SELECT * FROM seller_storefronts WHERE user_id = ?')
    .get(userId) as Record<string, unknown> | undefined;
}

export function updateStorefront(
  id: string,
  fields: { store_name?: string; description?: string; logo_url?: string; banner_url?: string },
): void {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.store_name !== undefined) {
    updates.push('store_name = ?');
    values.push(fields.store_name);
  }
  if (fields.description !== undefined) {
    updates.push('description = ?');
    values.push(fields.description);
  }
  if (fields.logo_url !== undefined) {
    updates.push('logo_url = ?');
    values.push(fields.logo_url);
  }
  if (fields.banner_url !== undefined) {
    updates.push('banner_url = ?');
    values.push(fields.banner_url);
  }

  if (updates.length === 0) return;

  updates.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  const query = `UPDATE seller_storefronts SET ${updates.join(', ')} WHERE id = ?`;
  getDb().prepare(query).run(...values);
}

export function getFeaturedStorefronts(): Record<string, unknown>[] {
  return getDb()
    .prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM marketplace_listings l WHERE l.user_id = s.user_id AND l.status = 'published') as listing_count,
        COALESCE(
          (SELECT AVG(o.rating) FROM marketplace_orders o WHERE o.seller_id = s.user_id AND o.rating IS NOT NULL), 0
        ) as avg_rating,
        COALESCE(
          (SELECT COUNT(*) FROM marketplace_orders o WHERE o.seller_id = s.user_id AND o.rating IS NOT NULL), 0
        ) as rating_count
      FROM seller_storefronts s
      WHERE s.featured = 1
      ORDER BY listing_count DESC
    `)
    .all() as Record<string, unknown>[];
}

// ─── Cart Queries ──────────────────────────────────────────────────────────────

export function addToCart(userId: string, listingId: string): string {
  const id = uuidv4();
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO marketplace_carts (id, user_id, listing_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(user_id, listing_id) DO UPDATE SET quantity = quantity + 1, updated_at = ?
    `)
    .run(id, userId, listingId, now, now, now);
  return id;
}

export function getCartItems(userId: string): Record<string, unknown>[] {
  return getDb()
    .prepare(`
      SELECT c.id, c.listing_id, c.quantity, c.created_at, c.updated_at,
        l.title, l.description, l.price_cad, l.price_usdc, l.shipping_cost_cad,
        l.images, l.status, l.condition, l.platform,
        u.name as seller_name, l.user_id as seller_id
      FROM marketplace_carts c
      JOIN marketplace_listings l ON c.listing_id = l.id
      JOIN users u ON l.user_id = u.id
      WHERE c.user_id = ?
      ORDER BY c.created_at DESC
    `)
    .all(userId) as Record<string, unknown>[];
}

export function removeFromCart(userId: string, listingId: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM marketplace_carts WHERE user_id = ? AND listing_id = ?')
    .run(userId, listingId);
  return result.changes > 0;
}

export function clearCart(userId: string): number {
  const result = getDb()
    .prepare('DELETE FROM marketplace_carts WHERE user_id = ?')
    .run(userId);
  return result.changes;
}

// ─── Order Queries ─────────────────────────────────────────────────────────────

export interface CreateOrderParams {
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  itemPriceCad: number;
  shippingCostCad: number;
  totalCad: number;
  exchangeRate: number;
  totalUsdc: number;
  conversionTimestamp: number;
  buyerDepositMemo: string;
  sellerDepositMemo: string;
  shippingAddress: string;
}

export function createOrder(params: CreateOrderParams): void {
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO marketplace_orders (
        id, listing_id, buyer_id, seller_id,
        item_price_cad, shipping_cost_cad, total_cad,
        exchange_rate, total_usdc, conversion_timestamp,
        status, buyer_deposit_memo, seller_deposit_memo,
        shipping_address, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?)
    `)
    .run(
      params.id, params.listingId, params.buyerId, params.sellerId,
      params.itemPriceCad, params.shippingCostCad, params.totalCad,
      params.exchangeRate, params.totalUsdc, params.conversionTimestamp,
      params.buyerDepositMemo, params.sellerDepositMemo,
      params.shippingAddress, now, now,
    );
}

export function getOrderById(orderId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare(`
      SELECT o.*,
        l.title as listing_title, l.images as listing_images,
        l.category as listing_category, l.condition as listing_condition,
        buyer.name as buyer_name, buyer.email as buyer_email,
        seller.name as seller_name, seller.email as seller_email,
        sf.store_name as seller_store_name, sf.slug as seller_store_slug
      FROM marketplace_orders o
      JOIN marketplace_listings l ON o.listing_id = l.id
      JOIN users buyer ON o.buyer_id = buyer.id
      JOIN users seller ON o.seller_id = seller.id
      LEFT JOIN seller_storefronts sf ON sf.user_id = o.seller_id
      WHERE o.id = ?
    `)
    .get(orderId) as Record<string, unknown> | undefined;
}

export function getOrdersByUser(userId: string, role: 'buyer' | 'seller', limit: number, offset: number): { orders: Record<string, unknown>[]; total: number } {
  const whereCol = role === 'buyer' ? 'buyer_id' : 'seller_id';
  const total = (getDb()
    .prepare(`SELECT COUNT(*) as cnt FROM marketplace_orders WHERE ${whereCol} = ?`)
    .get(userId) as { cnt: number }).cnt;
  const orders = getDb()
    .prepare(`
      SELECT o.*,
        l.title as listing_title, l.images as listing_images,
        buyer.name as buyer_name, seller.name as seller_name
      FROM marketplace_orders o
      JOIN marketplace_listings l ON o.listing_id = l.id
      JOIN users buyer ON o.buyer_id = buyer.id
      JOIN users seller ON o.seller_id = seller.id
      WHERE o.${whereCol} = ?
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(userId, limit, offset) as Record<string, unknown>[];
  return { orders, total };
}

export function updateOrderStatus(orderId: string, status: string, extraFields?: Record<string, unknown>): boolean {
  const updates = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [status, Date.now()];

  if (extraFields) {
    for (const [key, value] of Object.entries(extraFields)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }
  values.push(orderId);
  const result = getDb()
    .prepare(`UPDATE marketplace_orders SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

// ─── Escrow Deposit Queries ────────────────────────────────────────────────────

export function createEscrowDeposit(
  orderId: string, party: 'buyer' | 'seller', userId: string, amountUsdc: number, memo: string,
): string {
  const id = uuidv4();
  getDb()
    .prepare(`
      INSERT INTO marketplace_escrow_deposits (id, order_id, party, user_id, amount_usdc, memo, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `)
    .run(id, orderId, party, userId, amountUsdc, memo, Date.now());
  return id;
}

export function getEscrowDeposits(orderId: string): Record<string, unknown>[] {
  return getDb()
    .prepare('SELECT * FROM marketplace_escrow_deposits WHERE order_id = ? ORDER BY created_at')
    .all(orderId) as Record<string, unknown>[];
}

export function confirmEscrowDeposit(depositId: string, hederaTransactionId: string): boolean {
  const result = getDb()
    .prepare(`
      UPDATE marketplace_escrow_deposits
      SET status = 'confirmed', hedera_transaction_id = ?, confirmed_at = ?
      WHERE id = ? AND status = 'pending'
    `)
    .run(hederaTransactionId, Date.now(), depositId);
  return result.changes > 0;
}

export function settleEscrowDeposits(orderId: string): boolean {
  const result = getDb()
    .prepare(`
      UPDATE marketplace_escrow_deposits
      SET status = 'settled'
      WHERE order_id = ? AND status = 'confirmed'
    `)
    .run(orderId);
  return result.changes > 0;
}

// ─── Exchange Rate Cache Queries ───────────────────────────────────────────────

export function getCachedExchangeRate(from: string, to: string): { rate: number; source: string; fetchedAt: number } | null {
  const row = getDb()
    .prepare(`
      SELECT rate, source, fetched_at
      FROM exchange_rates_cache
      WHERE from_currency = ? AND to_currency = ? AND expires_at > ?
      ORDER BY fetched_at DESC LIMIT 1
    `)
    .get(from, to, Date.now()) as { rate: number; source: string; fetched_at: number } | undefined;
  return row ? { rate: row.rate, source: row.source, fetchedAt: row.fetched_at } : null;
}

export function setCachedExchangeRate(from: string, to: string, rate: number, source: string, ttlMs: number): void {
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO exchange_rates_cache (id, from_currency, to_currency, rate, source, fetched_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(uuidv4(), from, to, rate, source, now, now + ttlMs);
}

// ─── User Violations & Moderation ─────────────────────────────────────────

/**
 * Get user's current sanction status (or null if no sanction exists).
 */
export function getUserSanction(userId: string): Record<string, any> | null {
  return getDb()
    .prepare('SELECT * FROM user_sanctions WHERE user_id = ?')
    .get(userId) as Record<string, any> | undefined ?? null;
}

/**
 * Create or update a user's sanction record.
 */
export function upsertUserSanction(
  userId: string,
  status: string,
  mutedUntil: number | null,
  suspendedUntil: number | null,
  violationCount: number,
): void {
  const existing = getUserSanction(userId);
  const now = Date.now();

  if (existing) {
    getDb()
      .prepare(`
        UPDATE user_sanctions
        SET status = ?, muted_until = ?, suspended_until = ?, violation_count = ?, updated_at = ?
        WHERE user_id = ?
      `)
      .run(status, mutedUntil, suspendedUntil, violationCount, now, userId);
  } else {
    getDb()
      .prepare(`
        INSERT INTO user_sanctions (id, user_id, status, muted_until, suspended_until, violation_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(uuidv4(), userId, status, mutedUntil, suspendedUntil, violationCount, now);
  }
}

/**
 * Log a policy violation for a user.
 */
export function addViolation(
  userId: string,
  type: string,
  severity: string,
  messageId: string | null,
  threadId: string | null,
  details: string,
  actionTaken: string,
): void {
  getDb()
    .prepare(`
      INSERT INTO user_violations (id, user_id, type, severity, message_id, thread_id, details, action_taken, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      uuidv4(),
      userId,
      type,
      severity,
      messageId,
      threadId,
      details,
      actionTaken,
      Date.now(),
    );

  // Update violation count and last_violation_at
  const count = getViolationCount(userId);
  const sanction = getUserSanction(userId);
  if (sanction) {
    getDb()
      .prepare('UPDATE user_sanctions SET violation_count = ?, last_violation_at = ? WHERE user_id = ?')
      .run(count, Date.now(), userId);
  }
}

/**
 * Get the total violation count for a user.
 */
export function getViolationCount(userId: string): number {
  const result = getDb()
    .prepare('SELECT COUNT(*) as cnt FROM user_violations WHERE user_id = ?')
    .get(userId) as { cnt: number } | undefined;
  return result?.cnt ?? 0;
}

/**
 * Get all violations for a user (for review/audit).
 */
export function getUserViolations(userId: string, limit: number = 100): Record<string, any>[] {
  return getDb()
    .prepare('SELECT * FROM user_violations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as Record<string, any>[];
}

/**
 * Get all violations across the system (admin only).
 */
export function getAllViolations(limit: number = 1000): Record<string, any>[] {
  return getDb()
    .prepare('SELECT * FROM user_violations ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, any>[];
}

/**
 * Get all active sanctions (admin view).
 */
export function getAllSanctions(limit: number = 1000): Record<string, any>[] {
  return getDb()
    .prepare('SELECT s.*, u.email, u.name FROM user_sanctions s JOIN users u ON s.user_id = u.id ORDER BY s.updated_at DESC LIMIT ?')
    .all(limit) as Record<string, any>[];
}

/**
 * Get users whose mute/suspension has expired.
 * Used for auto-unblocking in periodic cleanup.
 */
export function getExpiredSanctions(): Record<string, any>[] {
  const now = Date.now();
  return getDb()
    .prepare(`
      SELECT * FROM user_sanctions
      WHERE (status = 'muted' AND muted_until < ?) OR (status = 'suspended' AND suspended_until < ?)
    `)
    .all(now, now) as Record<string, any>[];
}

// ─── AI Bot Queries ───────────────────────────────────────────────────────────

export interface BotRecord {
  id: string;
  owner_id: string;
  name: string;
  bio?: string;
  capabilities?: string;
  specialties?: string;
  avatar_url?: string;
  tier: 'bronze' | 'silver' | 'gold' | 'platinum' | 'sovereign';
  ap_points: number;
  bm_score: number;
  star_rating: number;
  total_ratings: number;
  jobs_completed: number;
  jobs_failed: number;
  status: 'active' | 'under_review' | 'suspended' | 'deactivated';
  review_reason?: string;
  reviewed_by?: string;
  created_at: number;
  updated_at: number;
}

/**
 * Create a new bot for a user.
 */
export function createBot(bot: {
  id: string;
  owner_id: string;
  name: string;
  bio?: string;
  capabilities?: string;
  specialties?: string;
  avatar_url?: string;
}): BotRecord {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO bots (id, owner_id, name, bio, capabilities, specialties, avatar_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bot.id,
    bot.owner_id,
    bot.name,
    bot.bio ?? null,
    bot.capabilities ?? null,
    bot.specialties ?? null,
    bot.avatar_url ?? null,
    now,
    now,
  );

  return getBotById(bot.id)!;
}

/**
 * Get a bot by ID.
 */
export function getBotById(botId: string): BotRecord | null {
  return getDb().prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRecord | null;
}

/**
 * Get all bots for a user.
 */
export function getBotsByOwnerId(ownerId: string): BotRecord[] {
  return getDb().prepare('SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId) as BotRecord[];
}

/**
 * Count bots for a user.
 */
export function countBotsByOwnerId(ownerId: string): number {
  const result = getDb().prepare('SELECT COUNT(*) as cnt FROM bots WHERE owner_id = ?').get(ownerId) as { cnt: number };
  return result.cnt;
}

/**
 * Update bot details.
 */
export function updateBot(botId: string, updates: Partial<Omit<BotRecord, 'id' | 'created_at'>>): void {
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  getDb().prepare(`
    UPDATE bots SET ${fields}, updated_at = ? WHERE id = ?
  `).run(...values, Date.now(), botId);
}

/**
 * Get bot leaderboard sorted by AP points.
 */
export function getBotLeaderboard(limit: number = 100): BotRecord[] {
  return getDb().prepare(`
    SELECT * FROM bots WHERE status = 'active' ORDER BY ap_points DESC, created_at ASC LIMIT ?
  `).all(limit) as BotRecord[];
}

/**
 * Get global bot statistics.
 */
export function getBotStats(): {
  totalBots: number;
  byTier: Record<string, number>;
  avgStarRating: number;
  avgApPoints: number;
} {
  const total = getDb().prepare(`SELECT COUNT(*) as cnt FROM bots WHERE status = 'active'`).get() as { cnt: number };

  const byTier = getDb().prepare(`
    SELECT tier, COUNT(*) as cnt FROM bots WHERE status = 'active' GROUP BY tier
  `).all() as Array<{ tier: string; cnt: number }>;

  const tierMap: Record<string, number> = {};
  for (const row of byTier) {
    tierMap[row.tier] = row.cnt;
  }

  const avgRating = getDb().prepare(`SELECT AVG(star_rating) as avg FROM bots WHERE status = 'active'`).get() as { avg: number | null };
  const avgAp = getDb().prepare(`SELECT AVG(ap_points) as avg FROM bots WHERE status = 'active'`).get() as { avg: number | null };

  return {
    totalBots: total.cnt,
    byTier: tierMap,
    avgStarRating: avgRating.avg ?? 0,
    avgApPoints: avgAp.avg ?? 0,
  };
}

/**
 * Create a bot job.
 */
export function createBotJob(job: {
  id: string;
  bot_id: string;
  listing_id?: string;
  job_type: string;
  title: string;
  description?: string;
}): void {
  getDb().prepare(`
    INSERT INTO bot_jobs (id, bot_id, listing_id, job_type, title, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.bot_id,
    job.listing_id ?? null,
    job.job_type,
    job.title,
    job.description ?? null,
    Date.now(),
  );
}

/**
 * Get a bot job by ID.
 */
export function getBotJobById(jobId: string): Record<string, any> | null {
  return getDb().prepare('SELECT * FROM bot_jobs WHERE id = ?').get(jobId) as Record<string, any> | null;
}

/**
 * Get all jobs for a bot.
 */
export function getBotJobs(botId: string, limit: number = 100): Record<string, any>[] {
  return getDb().prepare(`
    SELECT * FROM bot_jobs WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(botId, limit) as Record<string, any>[];
}

/**
 * Update bot job status.
 */
export function updateBotJobStatus(
  jobId: string,
  status: 'assigned' | 'in_progress' | 'completed' | 'failed',
  rating?: number,
  ratingComment?: string,
  apEarned?: number,
): void {
  const now = Date.now();
  getDb().prepare(`
    UPDATE bot_jobs SET status = ?, rating = ?, rating_comment = ?, ap_earned = ?, completed_at = ? WHERE id = ?
  `).run(status, rating ?? null, ratingComment ?? null, apEarned ?? 0, now, jobId);
}

/**
 * Create a bot review.
 */
export function createBotReview(review: {
  id: string;
  bot_id: string;
  reviewer_id: string;
  review_type: 're-evaluation' | 'periodic' | 'manual';
  decision: 'approved' | 'warning' | 'suspended' | 'deactivated';
  notes?: string;
  jobs_reviewed?: number;
}): void {
  getDb().prepare(`
    INSERT INTO bot_reviews (id, bot_id, reviewer_id, review_type, decision, notes, jobs_reviewed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    review.id,
    review.bot_id,
    review.reviewer_id,
    review.review_type,
    review.decision,
    review.notes ?? null,
    review.jobs_reviewed ?? 0,
    Date.now(),
  );
}

/**
 * Get bot reviews.
 */
export function getBotReviews(botId: string): Record<string, any>[] {
  return getDb().prepare(`
    SELECT * FROM bot_reviews WHERE bot_id = ? ORDER BY created_at DESC
  `).all(botId) as Record<string, any>[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPORT THREAD & MESSAGE PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

export function upsertSupportThread(thread: {
  id: string;
  sessionId: string;
  channel: 'chat' | 'email';
  customerEmail?: string;
  customerName?: string;
  subject?: string;
}): void {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO support_threads (id, session_id, channel, customer_email, customer_name, subject, status, message_count, first_message_at, last_message_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_message_at = excluded.last_message_at,
      updated_at = excluded.updated_at,
      customer_email = COALESCE(excluded.customer_email, support_threads.customer_email),
      customer_name = COALESCE(excluded.customer_name, support_threads.customer_name),
      subject = COALESCE(excluded.subject, support_threads.subject)
  `).run(thread.id, thread.sessionId, thread.channel, thread.customerEmail ?? null, thread.customerName ?? null, thread.subject ?? null, now, now, now, now);
}

export function addSupportMessage(msg: {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  tokensUsed?: number;
}): void {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO support_messages (id, thread_id, role, content, tokens_used, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(msg.id, msg.threadId, msg.role, msg.content, msg.tokensUsed ?? 0, now);

  // Update thread counters
  getDb().prepare(`
    UPDATE support_threads SET message_count = message_count + 1, last_message_at = ?, updated_at = ? WHERE id = ?
  `).run(now, now, msg.threadId);
}

export function getSupportThreadBySessionId(sessionId: string): Record<string, any> | null {
  return getDb().prepare('SELECT * FROM support_threads WHERE session_id = ?').get(sessionId) as Record<string, any> | null;
}

export function getSupportThreads(opts: {
  status?: string;
  channel?: string;
  escalated?: boolean;
  limit?: number;
  offset?: number;
}): { threads: Record<string, any>[]; total: number } {
  let where = 'WHERE 1=1';
  const params: any[] = [];
  if (opts.status) { where += ' AND status = ?'; params.push(opts.status); }
  if (opts.channel) { where += ' AND channel = ?'; params.push(opts.channel); }
  if (opts.escalated !== undefined) { where += ' AND escalated = ?'; params.push(opts.escalated ? 1 : 0); }

  const total = (getDb().prepare(`SELECT COUNT(*) as cnt FROM support_threads ${where}`).get(...params) as any).cnt;
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const threads = getDb().prepare(`SELECT * FROM support_threads ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Record<string, any>[];
  return { threads, total };
}

export function getSupportMessages(threadId: string): Record<string, any>[] {
  return getDb().prepare('SELECT * FROM support_messages WHERE thread_id = ? ORDER BY created_at ASC').all(threadId) as Record<string, any>[];
}

export function updateSupportThreadStatus(threadId: string, status: string, resolvedAt?: number): void {
  const now = Date.now();
  if (status === 'resolved') {
    getDb().prepare('UPDATE support_threads SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?').run(status, resolvedAt ?? now, now, threadId);
  } else {
    getDb().prepare('UPDATE support_threads SET status = ?, updated_at = ? WHERE id = ?').run(status, now, threadId);
  }
}

export function escalateSupportThread(threadId: string, reason: string): void {
  const now = Date.now();
  getDb().prepare('UPDATE support_threads SET escalated = 1, escalation_reason = ?, status = ?, updated_at = ? WHERE id = ?').run(reason, 'escalated', now, threadId);
}

export function assignSupportThread(threadId: string, adminId: string): void {
  const now = Date.now();
  getDb().prepare('UPDATE support_threads SET assigned_to = ?, updated_at = ? WHERE id = ?').run(adminId, now, threadId);
}

export function getSupportStats(): Record<string, any> {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM support_threads').get() as any).cnt;
  const open = (db.prepare("SELECT COUNT(*) as cnt FROM support_threads WHERE status = 'open'").get() as any).cnt;
  const escalated = (db.prepare("SELECT COUNT(*) as cnt FROM support_threads WHERE escalated = 1 AND status != 'resolved'").get() as any).cnt;
  const resolved = (db.prepare("SELECT COUNT(*) as cnt FROM support_threads WHERE status = 'resolved'").get() as any).cnt;
  const totalMessages = (db.prepare('SELECT COUNT(*) as cnt FROM support_messages').get() as any).cnt;
  const avgMessagesPerThread = total > 0 ? Math.round(totalMessages / total * 10) / 10 : 0;

  // Last 24h activity
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const newToday = (db.prepare('SELECT COUNT(*) as cnt FROM support_threads WHERE created_at > ?').get(dayAgo) as any).cnt;
  const resolvedToday = (db.prepare('SELECT COUNT(*) as cnt FROM support_threads WHERE resolved_at > ?').get(dayAgo) as any).cnt;

  return { total, open, escalated, resolved, totalMessages, avgMessagesPerThread, newToday, resolvedToday };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLATFORM EVENTS (DATA COLLECTION)
// ═══════════════════════════════════════════════════════════════════════════════

export function insertPlatformEvent(event: {
  id: string;
  eventType: string;
  category: string;
  actorId?: string;
  actorType?: string;
  targetId?: string;
  targetType?: string;
  payload?: Record<string, any>;
  metadata?: Record<string, any>;
}): void {
  getDb().prepare(`
    INSERT INTO platform_events (id, event_type, category, actor_id, actor_type, target_id, target_type, payload, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.eventType, event.category,
    event.actorId ?? null, event.actorType ?? 'system',
    event.targetId ?? null, event.targetType ?? null,
    JSON.stringify(event.payload ?? {}),
    JSON.stringify(event.metadata ?? {}),
    Date.now(),
  );
}

export function getUnanchoredEvents(limit: number = 100): Record<string, any>[] {
  return getDb().prepare('SELECT * FROM platform_events WHERE anchored = 0 ORDER BY created_at ASC LIMIT ?').all(limit) as Record<string, any>[];
}

export function markEventsAnchored(eventIds: string[], txId: string): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE platform_events SET anchored = 1, anchor_tx_id = ? WHERE id = ?');
  const batchUpdate = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(txId, id);
  });
  batchUpdate(eventIds);
}

/**
 * Increment retry count and update last_retry_at for a failed event.
 * Called when HCS submission fails to track retry attempts.
 */
export function incrementEventRetryCount(eventId: string): number {
  const db = getDb();
  const now = Date.now();
  db.prepare('UPDATE platform_events SET retry_count = retry_count + 1, last_retry_at = ? WHERE id = ?').run(now, eventId);
  const row = db.prepare('SELECT retry_count FROM platform_events WHERE id = ?').get(eventId) as { retry_count: number } | undefined;
  return row?.retry_count ?? 0;
}

/**
 * Get events that should be retried: anchored=0, retry_count > 0 and < max, and enough time has passed.
 * Respects exponential backoff: delay = min(2^retry_count * 1000, 60000) ms
 */
export function getFailedEventsForRetry(maxRetries: number = 5): Record<string, any>[] {
  const db = getDb();
  const now = Date.now();
  const events = db.prepare(`
    SELECT * FROM platform_events
    WHERE anchored = 0
      AND retry_count > 0
      AND retry_count < ?
      AND (last_retry_at IS NULL OR last_retry_at + CAST(MIN(POW(2, retry_count) * 1000, 60000) AS INTEGER) <= ?)
    ORDER BY last_retry_at ASC, retry_count ASC
    LIMIT 50
  `).all(maxRetries, now) as Record<string, any>[];
  return events;
}

// ─── Audit Requests (Mutual Commitment Protocol) ──────────────────────────

export function createAuditRequest(id: string, agentId: string, requesterKeyId: string, auditData: string): void {
  getDb().prepare(`
    INSERT INTO audit_requests (id, agent_id, requester_key_id, audit_data, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(id, agentId, requesterKeyId, auditData);
}

export function getAuditRequest(id: string): Record<string, any> | undefined {
  return getDb().prepare('SELECT * FROM audit_requests WHERE id = ?').get(id) as Record<string, any> | undefined;
}

export function updateAuditRequestStatus(id: string, status: string, signature?: string): void {
  const now = new Date().toISOString();
  if (signature) {
    getDb().prepare('UPDATE audit_requests SET status = ?, signature = ?, resolved_at = ? WHERE id = ?').run(status, signature, now, id);
  } else {
    getDb().prepare('UPDATE audit_requests SET status = ?, resolved_at = ? WHERE id = ?').run(status, now, id);
  }
}

export function getPlatformEvents(opts: {
  category?: string;
  eventType?: string;
  actorId?: string;
  since?: number;
  limit?: number;
  offset?: number;
}): { events: Record<string, any>[]; total: number } {
  let where = 'WHERE 1=1';
  const params: any[] = [];
  if (opts.category) { where += ' AND category = ?'; params.push(opts.category); }
  if (opts.eventType) { where += ' AND event_type = ?'; params.push(opts.eventType); }
  if (opts.actorId) { where += ' AND actor_id = ?'; params.push(opts.actorId); }
  if (opts.since) { where += ' AND created_at > ?'; params.push(opts.since); }

  const total = (getDb().prepare(`SELECT COUNT(*) as cnt FROM platform_events ${where}`).get(...params) as any).cnt;
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const events = getDb().prepare(`SELECT * FROM platform_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Record<string, any>[];
  return { events, total };
}

export function getEventStats(since?: number): Record<string, any> {
  const db = getDb();
  const cutoff = since ?? Date.now() - 24 * 60 * 60 * 1000;
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM platform_events WHERE created_at > ?').get(cutoff) as any).cnt;
  const byCategory = db.prepare('SELECT category, COUNT(*) as cnt FROM platform_events WHERE created_at > ? GROUP BY category ORDER BY cnt DESC').all(cutoff) as any[];
  const byType = db.prepare('SELECT event_type, COUNT(*) as cnt FROM platform_events WHERE created_at > ? GROUP BY event_type ORDER BY cnt DESC LIMIT 20').all(cutoff) as any[];
  const anchored = (db.prepare('SELECT COUNT(*) as cnt FROM platform_events WHERE anchored = 1 AND created_at > ?').get(cutoff) as any).cnt;
  return { total, anchored, unanchored: total - anchored, byCategory, byType };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA AGGREGATES
// ═══════════════════════════════════════════════════════════════════════════════

export function upsertAggregate(metricKey: string, period: string, periodStart: number, value: number, metadata?: Record<string, any>): void {
  const now = Date.now();
  const id = `${metricKey}:${period}:${periodStart}`;
  getDb().prepare(`
    INSERT INTO data_aggregates (id, metric_key, period, period_start, value, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(metric_key, period, period_start) DO UPDATE SET
      value = excluded.value,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `).run(id, metricKey, period, periodStart, value, JSON.stringify(metadata ?? {}), now, now);
}

export function getAggregates(metricKey: string, period: string, since: number, until?: number): Record<string, any>[] {
  const end = until ?? Date.now();
  return getDb().prepare('SELECT * FROM data_aggregates WHERE metric_key = ? AND period = ? AND period_start >= ? AND period_start <= ? ORDER BY period_start ASC').all(metricKey, period, since, end) as Record<string, any>[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export function getAllUsers(opts: { limit?: number; offset?: number; tier?: string; role?: string; search?: string }): { users: UserRecord[]; total: number } {
  let where = 'WHERE 1=1';
  const params: any[] = [];
  if (opts.tier) { where += ' AND tier = ?'; params.push(opts.tier); }
  if (opts.role) { where += ' AND role = ?'; params.push(opts.role); }
  if (opts.search) { where += ' AND (email LIKE ? OR name LIKE ?)'; params.push(`%${opts.search}%`, `%${opts.search}%`); }

  const total = (getDb().prepare(`SELECT COUNT(*) as cnt FROM users ${where}`).get(...params) as any).cnt;
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const users = getDb().prepare(`SELECT id, email, name, tier, role, created_at, last_login_at, email_verified, active, stripe_customer_id, subscription_expires_at, subscription_method, subscription_plan_id FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as UserRecord[];
  return { users, total };
}

export function getAdminDashboardStats(): Record<string, any> {
  const db = getDb();
  const totalUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as any).cnt;
  const activeUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users WHERE active = 1').get() as any).cnt;
  const proUsers = (db.prepare("SELECT COUNT(*) as cnt FROM users WHERE tier = 'pro'").get() as any).cnt;
  const eliteUsers = (db.prepare("SELECT COUNT(*) as cnt FROM users WHERE tier = 'elite'").get() as any).cnt;
  const totalBots = (db.prepare('SELECT COUNT(*) as cnt FROM bots').get() as any).cnt;
  const activeBots = (db.prepare("SELECT COUNT(*) as cnt FROM bots WHERE status = 'active'").get() as any).cnt;
  const totalListings = (db.prepare('SELECT COUNT(*) as cnt FROM marketplace_listings').get() as any).cnt;
  const publishedListings = (db.prepare("SELECT COUNT(*) as cnt FROM marketplace_listings WHERE status = 'published'").get() as any).cnt;
  const totalOrders = (db.prepare('SELECT COUNT(*) as cnt FROM marketplace_orders').get() as any).cnt;
  const totalAgents = (db.prepare('SELECT COUNT(*) as cnt FROM agents WHERE active = 1').get() as any).cnt;
  const totalCertificates = (db.prepare('SELECT COUNT(*) as cnt FROM audit_certificates WHERE revoked = 0').get() as any).cnt;

  // Revenue (settled orders)
  const revenue = db.prepare("SELECT COALESCE(SUM(total_usdc), 0) as total FROM marketplace_orders WHERE status = 'settled'").get() as any;

  // Last 7 days signups
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const newUsersWeek = (db.prepare('SELECT COUNT(*) as cnt FROM users WHERE created_at > ?').get(weekAgo) as any).cnt;

  return {
    users: { total: totalUsers, active: activeUsers, pro: proUsers, elite: eliteUsers, newThisWeek: newUsersWeek },
    bots: { total: totalBots, active: activeBots },
    marketplace: { listings: totalListings, published: publishedListings, orders: totalOrders, revenueUsdc: revenue.total },
    protocol: { agents: totalAgents, certificates: totalCertificates },
  };
}

// ─── User Verification Queries (Trust Layer System) ─────────────────────────

export interface VerificationRecord {
  id: string;
  userId: string;
  verificationType: string;
  platform: string | null;
  verificationCode: string | null;
  profileUrl: string | null;
  status: string;
  trustPoints: number;
  metadata: string;
  reviewerId: string | null;
  reviewNotes: string | null;
  submittedAt: number;
  verifiedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TrustScoreRecord {
  userId: string;
  totalScore: number;
  trustLevel: string;
  emailVerified: number;
  socialVerified: number;
  documentVerified: number;
  transactionCount: number;
  hederaTxCount: number;
  stripeTxCount: number;
  accountAgeDays: number;
  lastComputedAt: number;
}

// Trust points configuration
export const TRUST_POINTS = {
  EMAIL_VERIFIED: 10,
  SOCIAL_MEDIA: 15,        // per verified social account
  SOCIAL_MEDIA_MAX: 45,    // max 3 social accounts counted
  GOVERNMENT_ID: 30,
  ACTIVE_DAYS_30: 5,       // bonus for 30+ active login days
  ACTIVE_DAYS_90: 10,      // bonus for 90+ active login days
  ACTIVE_DAYS_180: 15,     // bonus for 180+ active login days (requires sustained engagement)
  // Dual-rail transaction scoring: behavior-based trust, not payment verification
  HEDERA_TX_BONUS: 2,      // per Hedera-settled transaction (on-chain, immutable proof)
  STRIPE_TX_BONUS: 1,      // per Stripe-settled transaction (off-chain but verified, lower weight)
  TRANSACTION_MAX: 20,     // combined cap across both rails
} as const;

// Trust level thresholds
export const TRUST_LEVELS: Array<{ minScore: number; level: string }> = [
  { minScore: 0,   level: 'unverified' },
  { minScore: 10,  level: 'basic' },       // email only
  { minScore: 25,  level: 'verified' },     // email + 1 social
  { minScore: 50,  level: 'trusted' },      // email + social + govt OR multiple socials
  { minScore: 80,  level: 'premium' },      // all layers + history
  { minScore: 105, level: 'elite' },        // full verification + sustained transactional history + account age
];

function mapVerificationRow(row: any): VerificationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    verificationType: row.verification_type,
    platform: row.platform,
    verificationCode: row.verification_code,
    profileUrl: row.profile_url,
    status: row.status,
    trustPoints: row.trust_points,
    metadata: row.metadata,
    reviewerId: row.reviewer_id,
    reviewNotes: row.review_notes,
    submittedAt: row.submitted_at,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTrustScoreRow(row: any): TrustScoreRecord {
  return {
    userId: row.user_id,
    totalScore: row.total_score,
    trustLevel: row.trust_level,
    emailVerified: row.email_verified,
    socialVerified: row.social_verified,
    documentVerified: row.document_verified,
    transactionCount: row.transaction_count,
    hederaTxCount: row.hedera_tx_count ?? 0,
    stripeTxCount: row.stripe_tx_count ?? 0,
    accountAgeDays: row.account_age_days,
    lastComputedAt: row.last_computed_at,
  };
}

export function createVerification(params: {
  id: string;
  userId: string;
  verificationType: string;
  platform?: string;
  verificationCode?: string;
  profileUrl?: string;
  trustPoints?: number;
  metadata?: string;
}): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO user_verifications (id, user_id, verification_type, platform, verification_code, profile_url, status, trust_points, metadata, submitted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.userId,
    params.verificationType,
    params.platform || null,
    params.verificationCode || null,
    params.profileUrl || null,
    params.trustPoints || 0,
    params.metadata || '{}',
    now, now, now,
  );
}

export function getVerificationsByUser(userId: string): VerificationRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM user_verifications WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[];
  return rows.map(mapVerificationRow);
}

export function getVerificationById(id: string): VerificationRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM user_verifications WHERE id = ?').get(id) as any;
  return row ? mapVerificationRow(row) : null;
}

export function getVerificationByCode(code: string): VerificationRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM user_verifications WHERE verification_code = ? AND status = 'pending'").get(code) as any;
  return row ? mapVerificationRow(row) : null;
}

export function getActiveVerification(userId: string, platform: string): VerificationRecord | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM user_verifications WHERE user_id = ? AND platform = ? AND status IN ('pending', 'verified') ORDER BY created_at DESC LIMIT 1"
  ).get(userId, platform) as any;
  return row ? mapVerificationRow(row) : null;
}

export function updateVerificationStatus(
  id: string,
  status: 'verified' | 'rejected' | 'expired',
  opts?: { reviewerId?: string; reviewNotes?: string; trustPoints?: number }
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE user_verifications
    SET status = ?, verified_at = ?, reviewer_id = ?, review_notes = ?, trust_points = COALESCE(?, trust_points), updated_at = ?
    WHERE id = ?
  `).run(
    status,
    status === 'verified' ? now : null,
    opts?.reviewerId || null,
    opts?.reviewNotes || null,
    opts?.trustPoints ?? null,
    now,
    id,
  );
}

export function getPendingVerifications(type?: string): VerificationRecord[] {
  const db = getDb();
  let sql = "SELECT * FROM user_verifications WHERE status = 'pending'";
  const params: any[] = [];
  if (type) {
    sql += ' AND verification_type = ?';
    params.push(type);
  }
  sql += ' ORDER BY submitted_at ASC';
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(mapVerificationRow);
}

// ── Trust Score Computation ─────────────────────────────────────────────────

export function computeAndStoreTrustScore(userId: string): TrustScoreRecord {
  const db = getDb();
  const now = Date.now();

  // 1. Email verification
  const user = db.prepare('SELECT email_verified, created_at FROM users WHERE id = ?').get(userId) as any;
  const emailVerified = user?.email_verified ? 1 : 0;
  let totalScore = emailVerified ? TRUST_POINTS.EMAIL_VERIFIED : 0;

  // 2. Social media verifications
  const socialCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM user_verifications WHERE user_id = ? AND verification_type = 'social_media' AND status = 'verified'"
  ).get(userId) as any).cnt;
  const socialPoints = Math.min(socialCount * TRUST_POINTS.SOCIAL_MEDIA, TRUST_POINTS.SOCIAL_MEDIA_MAX);
  totalScore += socialPoints;

  // 3. Government ID verification
  const docVerified = (db.prepare(
    "SELECT COUNT(*) as cnt FROM user_verifications WHERE user_id = ? AND verification_type = 'government_id' AND status = 'verified'"
  ).get(userId) as any).cnt;
  if (docVerified > 0) totalScore += TRUST_POINTS.GOVERNMENT_ID;

  // 4. Active login days bonus (requires sustained engagement, not just passive account age)
  const activeLoginDays = getActiveLoginDays(userId);
  const accountAgeDays = activeLoginDays; // renamed for backward compatibility in trust score record
  if (activeLoginDays >= 180) totalScore += TRUST_POINTS.ACTIVE_DAYS_180;
  else if (activeLoginDays >= 90) totalScore += TRUST_POINTS.ACTIVE_DAYS_90;
  else if (activeLoginDays >= 30) totalScore += TRUST_POINTS.ACTIVE_DAYS_30;

  // 5. Dual-rail transaction history bonus
  //    Hedera-settled = 2 pts each (on-chain, immutable proof of delivery)
  //    Stripe-settled = 1 pt each  (off-chain but payment-verified)
  //    Combined cap: 20 pts — rewards sustained behavior, not payment verification alone
  const hederaTxCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM marketplace_orders WHERE (buyer_id = ? OR seller_id = ?) AND status IN ('completed', 'settled') AND settlement_type = 'hedera'"
  ).get(userId, userId) as any).cnt;
  const stripeTxCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM marketplace_orders WHERE (buyer_id = ? OR seller_id = ?) AND status IN ('completed', 'settled') AND settlement_type = 'stripe'"
  ).get(userId, userId) as any).cnt;
  const txCount = hederaTxCount + stripeTxCount;

  const hederaPoints = hederaTxCount * TRUST_POINTS.HEDERA_TX_BONUS;
  const stripePoints = stripeTxCount * TRUST_POINTS.STRIPE_TX_BONUS;
  const txPoints = Math.min(hederaPoints + stripePoints, TRUST_POINTS.TRANSACTION_MAX);
  totalScore += txPoints;

  // Determine trust level
  let trustLevel = 'unverified';
  for (const tl of TRUST_LEVELS) {
    if (totalScore >= tl.minScore) trustLevel = tl.level;
  }

  // Upsert trust score
  db.prepare(`
    INSERT INTO user_trust_scores (user_id, total_score, trust_level, email_verified, social_verified, document_verified, transaction_count, hedera_tx_count, stripe_tx_count, account_age_days, last_computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      total_score = excluded.total_score,
      trust_level = excluded.trust_level,
      email_verified = excluded.email_verified,
      social_verified = excluded.social_verified,
      document_verified = excluded.document_verified,
      transaction_count = excluded.transaction_count,
      hedera_tx_count = excluded.hedera_tx_count,
      stripe_tx_count = excluded.stripe_tx_count,
      account_age_days = excluded.account_age_days,
      last_computed_at = excluded.last_computed_at
  `).run(userId, totalScore, trustLevel, emailVerified, socialCount, docVerified > 0 ? 1 : 0, txCount, hederaTxCount, stripeTxCount, accountAgeDays, now);

  return {
    userId,
    totalScore,
    trustLevel,
    emailVerified,
    socialVerified: socialCount,
    documentVerified: docVerified > 0 ? 1 : 0,
    transactionCount: txCount,
    hederaTxCount,
    stripeTxCount,
    accountAgeDays,
    lastComputedAt: now,
  };
}

export function getTrustScore(userId: string): TrustScoreRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM user_trust_scores WHERE user_id = ?').get(userId) as any;
  return row ? mapTrustScoreRow(row) : null;
}

export function getUserTrustLevel(userId: string): string {
  const score = getTrustScore(userId);
  return score?.trustLevel ?? 'unverified';
}

// ─── v40 Signal Tower: Notification Queries ──────────────────────────────────

export interface NotificationRecord {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  icon: string;
  link: string | null;
  read: boolean;
  createdAt: number;
}

function mapNotificationRow(row: any): NotificationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    icon: row.icon ?? 'bell',
    link: row.link,
    read: !!row.read,
    createdAt: row.created_at,
  };
}

export function createNotification(data: {
  userId: string;
  type: string;
  title: string;
  body: string;
  icon?: string;
  link?: string;
}): NotificationRecord {
  const db = getDb();
  const id = uuidv4();
  const now = Date.now();
  db.prepare(`
    INSERT INTO user_notifications (id, user_id, type, title, body, icon, link, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, data.userId, data.type, data.title, data.body, data.icon ?? 'bell', data.link ?? null, now);
  return { id, userId: data.userId, type: data.type, title: data.title, body: data.body, icon: data.icon ?? 'bell', link: data.link ?? null, read: false, createdAt: now };
}

export function getUserNotifications(userId: string, opts?: { limit?: number; offset?: number; unreadOnly?: boolean }): NotificationRecord[] {
  const db = getDb();
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 50));
  const offset = Math.max(0, opts?.offset ?? 0);
  let query = 'SELECT * FROM user_notifications WHERE user_id = ?';
  const params: any[] = [userId];
  if (opts?.unreadOnly) {
    query += ' AND read = 0';
  }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return (db.prepare(query).all(...params) as any[]).map(mapNotificationRow);
}

export function getUnreadNotificationCount(userId: string): number {
  const db = getDb();
  return (db.prepare('SELECT COUNT(*) as c FROM user_notifications WHERE user_id = ? AND read = 0').get(userId) as any)?.c ?? 0;
}

export function markNotificationRead(notificationId: string, userId: string): boolean {
  const db = getDb();
  const result = db.prepare('UPDATE user_notifications SET read = 1 WHERE id = ? AND user_id = ?').run(notificationId, userId);
  return result.changes > 0;
}

export function markAllNotificationsRead(userId: string): number {
  const db = getDb();
  const result = db.prepare('UPDATE user_notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
  return result.changes;
}

export function deleteOldNotifications(olderThanMs: number = 90 * 24 * 60 * 60 * 1000): number {
  const db = getDb();
  const cutoff = Date.now() - olderThanMs;
  const result = db.prepare('DELETE FROM user_notifications WHERE created_at < ?').run(cutoff);
  return result.changes;
}

// ─── Notification Preferences ─────────────────────────────────────────────────

export interface NotificationPreferences {
  userId: string;
  emailOrders: boolean;
  emailVerification: boolean;
  emailPayment: boolean;
  emailSystem: boolean;
  emailMarketing: boolean;
  inappOrders: boolean;
  inappVerification: boolean;
  inappPayment: boolean;
  inappSystem: boolean;
  inappTrust: boolean;
  inappSupport: boolean;
  updatedAt: number;
}

function mapPrefsRow(row: any): NotificationPreferences {
  return {
    userId: row.user_id,
    emailOrders: !!row.email_orders,
    emailVerification: !!row.email_verification,
    emailPayment: !!row.email_payment,
    emailSystem: !!row.email_system,
    emailMarketing: !!row.email_marketing,
    inappOrders: !!row.inapp_orders,
    inappVerification: !!row.inapp_verification,
    inappPayment: !!row.inapp_payment,
    inappSystem: !!row.inapp_system,
    inappTrust: !!row.inapp_trust,
    inappSupport: !!row.inapp_support,
    updatedAt: row.updated_at,
  };
}

export function getNotificationPreferences(userId: string): NotificationPreferences {
  const db = getDb();
  const row = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId) as any;
  if (row) return mapPrefsRow(row);
  // Return defaults if no row exists
  return {
    userId,
    emailOrders: true, emailVerification: true, emailPayment: true,
    emailSystem: true, emailMarketing: false,
    inappOrders: true, inappVerification: true, inappPayment: true,
    inappSystem: true, inappTrust: true, inappSupport: true,
    updatedAt: 0,
  };
}

export function updateNotificationPreferences(userId: string, prefs: Partial<Omit<NotificationPreferences, 'userId' | 'updatedAt'>>): NotificationPreferences {
  const db = getDb();
  const now = Date.now();
  const current = getNotificationPreferences(userId);

  db.prepare(`
    INSERT INTO notification_preferences (user_id, email_orders, email_verification, email_payment, email_system, email_marketing, inapp_orders, inapp_verification, inapp_payment, inapp_system, inapp_trust, inapp_support, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email_orders = excluded.email_orders,
      email_verification = excluded.email_verification,
      email_payment = excluded.email_payment,
      email_system = excluded.email_system,
      email_marketing = excluded.email_marketing,
      inapp_orders = excluded.inapp_orders,
      inapp_verification = excluded.inapp_verification,
      inapp_payment = excluded.inapp_payment,
      inapp_system = excluded.inapp_system,
      inapp_trust = excluded.inapp_trust,
      inapp_support = excluded.inapp_support,
      updated_at = excluded.updated_at
  `).run(
    userId,
    prefs.emailOrders !== undefined ? (prefs.emailOrders ? 1 : 0) : (current.emailOrders ? 1 : 0),
    prefs.emailVerification !== undefined ? (prefs.emailVerification ? 1 : 0) : (current.emailVerification ? 1 : 0),
    prefs.emailPayment !== undefined ? (prefs.emailPayment ? 1 : 0) : (current.emailPayment ? 1 : 0),
    prefs.emailSystem !== undefined ? (prefs.emailSystem ? 1 : 0) : (current.emailSystem ? 1 : 0),
    prefs.emailMarketing !== undefined ? (prefs.emailMarketing ? 1 : 0) : (current.emailMarketing ? 1 : 0),
    prefs.inappOrders !== undefined ? (prefs.inappOrders ? 1 : 0) : (current.inappOrders ? 1 : 0),
    prefs.inappVerification !== undefined ? (prefs.inappVerification ? 1 : 0) : (current.inappVerification ? 1 : 0),
    prefs.inappPayment !== undefined ? (prefs.inappPayment ? 1 : 0) : (current.inappPayment ? 1 : 0),
    prefs.inappSystem !== undefined ? (prefs.inappSystem ? 1 : 0) : (current.inappSystem ? 1 : 0),
    prefs.inappTrust !== undefined ? (prefs.inappTrust ? 1 : 0) : (current.inappTrust ? 1 : 0),
    prefs.inappSupport !== undefined ? (prefs.inappSupport ? 1 : 0) : (current.inappSupport ? 1 : 0),
    now,
  );

  return getNotificationPreferences(userId);
}

// ══════════════════════════════════════════════════════════════════════════════
// ACADEMY PROGRESSION ENGINE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * XP required to reach a given level from level 1.
 * Formula: 100 * level^1.5 (cumulative)
 * Level 1→2: 100 XP,  Level 10→11: ~3,162 XP,  Level 50→51: ~35,355 XP
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.floor(100 * Math.pow(level, 1.5));
}

/** Total cumulative XP needed to reach a level */
export function cumulativeXpForLevel(level: number): number {
  let total = 0;
  for (let i = 2; i <= level; i++) {
    total += xpForLevel(i);
  }
  return total;
}

/** Calculate level from total XP */
export function levelFromXp(totalXp: number): number {
  let level = 1;
  let cumulative = 0;
  while (level < 100) {
    const needed = xpForLevel(level + 1);
    if (cumulative + needed > totalXp) break;
    cumulative += needed;
    level++;
  }
  return level;
}

/** Get title and tier for a given level */
export function getTitleForLevel(level: number): { title: string; tier: string; tierColor: string } {
  const row = getDb().prepare(
    'SELECT title, tier, tier_color FROM level_definitions WHERE min_level <= ? AND max_level >= ?'
  ).get(level, level) as { title: string; tier: string; tier_color: string } | undefined;
  return row
    ? { title: row.title, tier: row.tier, tierColor: row.tier_color }
    : { title: 'Newcomer', tier: 'Basic', tierColor: '#9CA3AF' };
}

/** AP rank derived from total AP */
export function apRankFromTotal(apTotal: number): string {
  if (apTotal >= 10000) return 'Diamond Contributor';
  if (apTotal >= 2000) return 'Gold Contributor';
  if (apTotal >= 500) return 'Silver Contributor';
  if (apTotal >= 100) return 'Bronze Contributor';
  if (apTotal >= 25) return 'Active Voice';
  if (apTotal >= 1) return 'Participant';
  return 'Observer';
}

/** Ensure user_progression row exists for a user */
export function ensureUserProgression(userId: string): void {
  const exists = getDb().prepare('SELECT 1 FROM user_progression WHERE user_id = ?').get(userId);
  if (!exists) {
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO user_progression (user_id, xp_total, xp_current_level, level, title, tier, tier_color, ap_total, ap_rank, current_streak, longest_streak, created_at, updated_at)
      VALUES (?, 0, 0, 1, 'Newcomer', 'Basic', '#9CA3AF', 0, 'Observer', 0, 0, ?, ?)
    `).run(userId, now, now);
  }
}

/** Get a user's full progression state */
export function getUserProgression(userId: string): any {
  ensureUserProgression(userId);
  const row = getDb().prepare('SELECT * FROM user_progression WHERE user_id = ?').get(userId) as Record<string, any>;
  const level = row.level as number;
  const xpTotal = row.xp_total as number;
  const currentLevelCumulative = cumulativeXpForLevel(level);
  const nextLevelCumulative = cumulativeXpForLevel(level + 1);
  const xpIntoCurrentLevel = xpTotal - currentLevelCumulative;
  const xpNeededForNext = nextLevelCumulative - currentLevelCumulative;

  return {
    userId: row.user_id,
    xpTotal: row.xp_total,
    xpIntoCurrentLevel,
    xpNeededForNext,
    xpProgress: xpNeededForNext > 0 ? Math.min(1, xpIntoCurrentLevel / xpNeededForNext) : 1,
    level: row.level,
    title: row.title,
    tier: row.tier,
    tierColor: row.tier_color,
    apTotal: row.ap_total,
    apRank: row.ap_rank,
    currentStreak: row.current_streak,
    longestStreak: row.longest_streak,
    lastActivityDate: row.last_activity_date,
    gamesPlayed: row.games_played,
    gamesWon: row.games_won,
    articlesRead: row.articles_read,
    contributions: row.contributions,
    featuredBadgeId: row.featured_badge_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Award XP to a user. Handles leveling, title changes, and badge checks.
 * Returns the transaction and any level-up info.
 */
export function awardXp(userId: string, amount: number, source: string, description: string, sourceId?: string): {
  transaction: any;
  leveledUp: boolean;
  newLevel?: number;
  newTitle?: string;
  newTier?: string;
  badgesEarned: string[];
} {
  ensureUserProgression(userId);
  const db = getDb();

  const prog = db.prepare('SELECT * FROM user_progression WHERE user_id = ?').get(userId) as Record<string, any>;
  const oldLevel = prog.level as number;
  const newXpTotal = (prog.xp_total as number) + amount;
  const newLevel = Math.min(100, levelFromXp(newXpTotal));
  const { title, tier, tierColor } = getTitleForLevel(newLevel);
  const leveledUp = newLevel > oldLevel;

  // Update today's activity
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO daily_activity_log (user_id, activity_date, xp_earned_today)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, activity_date) DO UPDATE SET xp_earned_today = xp_earned_today + ?
  `).run(userId, today, amount, amount);

  // Update streak
  let currentStreak = prog.current_streak as number;
  let longestStreak = prog.longest_streak as number;
  const lastDate = prog.last_activity_date as string | null;
  if (lastDate !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (lastDate === yesterday) {
      currentStreak += 1;
    } else if (lastDate !== today) {
      currentStreak = 1; // streak broken
    }
    if (currentStreak > longestStreak) longestStreak = currentStreak;
  }

  // Record transaction
  const txId = uuidv4();
  const now = Date.now();
  db.prepare(`
    INSERT INTO xp_transactions (id, user_id, amount, source, source_id, description, balance_after, level_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(txId, userId, amount, source, sourceId ?? null, description, newXpTotal, newLevel, now);

  // Update progression
  const xpCurrentLevel = newXpTotal - cumulativeXpForLevel(newLevel);
  db.prepare(`
    UPDATE user_progression SET
      xp_total = ?, xp_current_level = ?, level = ?, title = ?, tier = ?, tier_color = ?,
      current_streak = ?, longest_streak = ?, last_activity_date = ?, updated_at = ?
    WHERE user_id = ?
  `).run(newXpTotal, xpCurrentLevel, newLevel, title, tier, tierColor, currentStreak, longestStreak, today, now, userId);

  // Check and award badges
  const badgesEarned = checkAndAwardBadges(userId, {
    xpTotal: newXpTotal,
    level: newLevel,
    streak: currentStreak,
    gamesPlayed: prog.games_played as number,
    contributions: prog.contributions as number,
    apTotal: prog.ap_total as number,
  });

  return {
    transaction: { id: txId, amount, source, description, balanceAfter: newXpTotal, levelAfter: newLevel },
    leveledUp,
    newLevel: leveledUp ? newLevel : undefined,
    newTitle: leveledUp ? title : undefined,
    newTier: leveledUp ? tier : undefined,
    badgesEarned,
  };
}

/**
 * Award AP (contribution points) to a user.
 */
export function awardAp(userId: string, amount: number, source: string, description: string, sourceId?: string): {
  transaction: any;
  badgesEarned: string[];
} {
  ensureUserProgression(userId);
  const db = getDb();

  const prog = db.prepare('SELECT ap_total, contributions FROM user_progression WHERE user_id = ?').get(userId) as { ap_total: number; contributions: number };
  const newApTotal = prog.ap_total + amount;
  const newRank = apRankFromTotal(newApTotal);
  const now = Date.now();

  const txId = uuidv4();
  db.prepare(`
    INSERT INTO ap_transactions (id, user_id, amount, source, source_id, description, balance_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(txId, userId, amount, source, sourceId ?? null, description, newApTotal, now);

  db.prepare(`
    UPDATE user_progression SET ap_total = ?, ap_rank = ?, contributions = contributions + 1, updated_at = ?
    WHERE user_id = ?
  `).run(newApTotal, newRank, now, userId);

  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO daily_activity_log (user_id, activity_date, ap_earned_today)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, activity_date) DO UPDATE SET ap_earned_today = ap_earned_today + ?
  `).run(userId, today, amount, amount);

  const badgesEarned = checkAndAwardBadges(userId, {
    xpTotal: 0, level: 0, streak: 0, gamesPlayed: 0,
    contributions: prog.contributions + 1,
    apTotal: newApTotal,
  });

  return {
    transaction: { id: txId, amount, source, description, balanceAfter: newApTotal },
    badgesEarned,
  };
}

/** Increment games_played counter and optionally games_won */
export function recordGamePlayed(userId: string, won: boolean): void {
  ensureUserProgression(userId);
  const db = getDb();
  if (won) {
    db.prepare('UPDATE user_progression SET games_played = games_played + 1, games_won = games_won + 1, updated_at = ? WHERE user_id = ?').run(Date.now(), userId);
  } else {
    db.prepare('UPDATE user_progression SET games_played = games_played + 1, updated_at = ? WHERE user_id = ?').run(Date.now(), userId);
  }
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO daily_activity_log (user_id, activity_date, games_played)
    VALUES (?, ?, 1)
    ON CONFLICT(user_id, activity_date) DO UPDATE SET games_played = games_played + 1
  `).run(userId, today);
}

/**
 * Check all badge requirements and award any newly-earned badges.
 * Returns array of badge IDs that were newly earned.
 */
export function checkAndAwardBadges(userId: string, stats: {
  xpTotal: number; level: number; streak: number;
  gamesPlayed: number; contributions: number; apTotal: number;
}): string[] {
  const db = getDb();
  const allBadges = db.prepare(
    'SELECT id, requirement_type, requirement_value FROM badge_definitions WHERE active = 1 AND requirement_type != ?'
  ).all('manual') as Array<{ id: string; requirement_type: string; requirement_value: number }>;

  const earned = db.prepare('SELECT badge_id FROM user_badges WHERE user_id = ?').all(userId) as Array<{ badge_id: string }>;
  const earnedSet = new Set(earned.map(e => e.badge_id));
  const newBadges: string[] = [];
  const now = Date.now();

  for (const badge of allBadges) {
    if (earnedSet.has(badge.id)) continue;

    let qualifies = false;
    switch (badge.requirement_type) {
      case 'xp_total': qualifies = stats.xpTotal >= badge.requirement_value; break;
      case 'level': qualifies = stats.level >= badge.requirement_value; break;
      case 'streak': qualifies = stats.streak >= badge.requirement_value; break;
      case 'games_played': qualifies = stats.gamesPlayed >= badge.requirement_value; break;
      case 'contributions': qualifies = stats.contributions >= badge.requirement_value; break;
      case 'ap_total': qualifies = stats.apTotal >= badge.requirement_value; break;
    }

    if (qualifies) {
      const badgeRowId = uuidv4();
      try {
        db.prepare('INSERT INTO user_badges (id, user_id, badge_id, earned_at) VALUES (?, ?, ?, ?)').run(badgeRowId, userId, badge.id, now);
        newBadges.push(badge.id);
      } catch { /* unique constraint — already earned */ }
    }
  }

  return newBadges;
}

/** Get all badges earned by a user */
export function getUserBadges(userId: string): any[] {
  return getDb().prepare(`
    SELECT ub.badge_id, ub.earned_at, ub.seen,
           bd.name, bd.description, bd.category, bd.icon_svg, bd.rarity, bd.sort_order
    FROM user_badges ub
    JOIN badge_definitions bd ON bd.id = ub.badge_id
    WHERE ub.user_id = ?
    ORDER BY bd.sort_order ASC
  `).all(userId) as any[];
}

/** Get all available badge definitions */
export function getAllBadgeDefinitions(): any[] {
  return getDb().prepare(
    'SELECT id, name, description, category, icon_svg, rarity, requirement_type, requirement_value, sort_order FROM badge_definitions WHERE active = 1 ORDER BY sort_order ASC'
  ).all() as any[];
}

/** Mark badges as seen (dismiss notification) */
export function markBadgesSeen(userId: string, badgeIds: string[]): void {
  const stmt = getDb().prepare('UPDATE user_badges SET seen = 1 WHERE user_id = ? AND badge_id = ?');
  for (const bid of badgeIds) stmt.run(userId, bid);
}

/** Set a user's featured badge */
export function setFeaturedBadge(userId: string, badgeId: string | null): void {
  getDb().prepare('UPDATE user_progression SET featured_badge_id = ?, updated_at = ? WHERE user_id = ?')
    .run(badgeId, Date.now(), userId);
}

/** Get XP transaction history for a user (paginated) */
export function getXpHistory(userId: string, limit = 20, offset = 0): any[] {
  return getDb().prepare(
    'SELECT id, amount, source, source_id, description, balance_after, level_after, created_at FROM xp_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(userId, limit, offset) as any[];
}

/** Get AP transaction history for a user (paginated) */
export function getApHistory(userId: string, limit = 20, offset = 0): any[] {
  return getDb().prepare(
    'SELECT id, amount, source, source_id, description, balance_after, created_at FROM ap_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(userId, limit, offset) as any[];
}

/** Leaderboard: top users by level/XP */
export function getLeaderboard(limit = 25): any[] {
  return getDb().prepare(`
    SELECT up.user_id, u.name, u.email, up.level, up.xp_total, up.title, up.tier, up.tier_color, up.ap_total, up.ap_rank,
           up.current_streak, up.featured_badge_id
    FROM user_progression up
    JOIN users u ON u.id = up.user_id AND u.active = 1
    ORDER BY up.xp_total DESC
    LIMIT ?
  `).all(limit) as any[];
}

// ─── The Spark — Trust Token Economy & Learning Engine ─────────────────────────

/** Get all active Trust Guides */
export function getSparkGuides(): any[] {
  return getDb().prepare(
    'SELECT id, slug, name, domain, color, icon_svg, tagline, description, sort_order FROM spark_guides WHERE active = 1 ORDER BY sort_order ASC'
  ).all() as any[];
}

/** Get a single guide by slug */
export function getSparkGuideBySlug(slug: string): any | undefined {
  return getDb().prepare(
    'SELECT id, slug, name, domain, color, icon_svg, tagline, description FROM spark_guides WHERE slug = ? AND active = 1'
  ).get(slug);
}

/** Set user's selected guide */
export function selectSparkGuide(userId: string, guideSlug: string): void {
  getDb().prepare('UPDATE user_progression SET selected_guide = ?, updated_at = ? WHERE user_id = ?')
    .run(guideSlug, Date.now(), userId);
}

/** Get user's selected guide */
export function getSelectedGuide(userId: string): string | null {
  const row = getDb().prepare('SELECT selected_guide FROM user_progression WHERE user_id = ?').get(userId) as { selected_guide: string | null } | undefined;
  return row?.selected_guide ?? null;
}

/** Get lessons for a guide (optionally filtered by difficulty) */
export function getSparkLessons(guideId: string, difficulty?: string): any[] {
  if (difficulty) {
    return getDb().prepare(
      'SELECT id, guide_id, title, slug, description, difficulty, xp_reward, sort_order, age_min, age_max FROM spark_lessons WHERE guide_id = ? AND difficulty = ? AND active = 1 ORDER BY sort_order ASC'
    ).all(guideId, difficulty) as any[];
  }
  return getDb().prepare(
    'SELECT id, guide_id, title, slug, description, difficulty, xp_reward, sort_order, age_min, age_max FROM spark_lessons WHERE guide_id = ? AND active = 1 ORDER BY sort_order ASC'
  ).all(guideId) as any[];
}

/** Get full lesson details by slug (includes all content) */
export function getSparkLessonBySlug(slug: string): any | undefined {
  return getDb().prepare(
    'SELECT * FROM spark_lessons WHERE slug = ? AND active = 1'
  ).get(slug);
}

/** Get lesson by ID */
export function getSparkLessonById(id: string): any | undefined {
  return getDb().prepare(
    'SELECT * FROM spark_lessons WHERE id = ? AND active = 1'
  ).get(id);
}

/** Get user's progress on all lessons (for a specific guide or all) */
export function getSparkProgress(userId: string, guideId?: string): any[] {
  if (guideId) {
    return getDb().prepare(`
      SELECT sp.*, sl.title, sl.slug, sl.guide_id, sl.xp_reward, sl.difficulty
      FROM spark_progress sp
      JOIN spark_lessons sl ON sl.id = sp.lesson_id
      WHERE sp.user_id = ? AND sl.guide_id = ?
      ORDER BY sl.sort_order ASC
    `).all(userId, guideId) as any[];
  }
  return getDb().prepare(`
    SELECT sp.*, sl.title, sl.slug, sl.guide_id, sl.xp_reward, sl.difficulty
    FROM spark_progress sp
    JOIN spark_lessons sl ON sl.id = sp.lesson_id
    WHERE sp.user_id = ?
    ORDER BY sl.sort_order ASC
  `).all(userId) as any[];
}

/** Start or get existing progress for a lesson */
export function startSparkLesson(userId: string, lessonId: string): any {
  const existing = getDb().prepare(
    'SELECT * FROM spark_progress WHERE user_id = ? AND lesson_id = ?'
  ).get(userId, lessonId);
  if (existing) return existing;

  const id = uuidv4();
  const now = Date.now();
  getDb().prepare(
    'INSERT INTO spark_progress (id, user_id, lesson_id, status, started_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, userId, lessonId, 'started', now);
  return getDb().prepare('SELECT * FROM spark_progress WHERE id = ?').get(id);
}

/** Update lesson progress (complete a stage) */
export function updateSparkProgress(userId: string, lessonId: string, stage: 'hook' | 'adventure' | 'reflection', reflectionAnswer?: string): any {
  const col = stage === 'hook' ? 'hook_completed' : stage === 'adventure' ? 'adventure_completed' : 'reflection_completed';
  const updates: string[] = [`${col} = 1`];
  const params: any[] = [];

  if (stage === 'reflection' && reflectionAnswer) {
    updates.push('reflection_answer = ?');
    params.push(reflectionAnswer);
  }

  params.push(userId, lessonId);
  getDb().prepare(
    `UPDATE spark_progress SET ${updates.join(', ')} WHERE user_id = ? AND lesson_id = ?`
  ).run(...params);

  return getDb().prepare(
    'SELECT * FROM spark_progress WHERE user_id = ? AND lesson_id = ?'
  ).get(userId, lessonId);
}

/** Complete a Spark lesson and award XP (Trust Tokens) */
export function completeSparkLesson(userId: string, lessonId: string, timeSpentSeconds: number): { xpAwarded: number; newBalance: number; leveledUp: boolean; newLevel?: number; newTitle?: string } {
  const db = getDb();
  const lesson = db.prepare('SELECT xp_reward FROM spark_lessons WHERE id = ?').get(lessonId) as { xp_reward: number } | undefined;
  if (!lesson) throw new Error('Lesson not found');

  const progress = db.prepare('SELECT * FROM spark_progress WHERE user_id = ? AND lesson_id = ?').get(userId, lessonId) as any;
  if (!progress) throw new Error('No progress record found');
  if (progress.status === 'completed') return { xpAwarded: 0, newBalance: 0, leveledUp: false };

  const now = Date.now();
  const xpAmount = lesson.xp_reward;

  // Mark lesson completed
  db.prepare(
    'UPDATE spark_progress SET status = ?, hook_completed = 1, adventure_completed = 1, reflection_completed = 1, xp_awarded = ?, time_spent_seconds = ?, completed_at = ? WHERE user_id = ? AND lesson_id = ?'
  ).run('completed', xpAmount, timeSpentSeconds, now, userId, lessonId);

  // Award XP + Trust Tokens (spendable_xp)
  const award = awardXp(userId, xpAmount, 'spark_lesson', `Completed: ${lessonId}`, lessonId);

  // Update spendable_xp
  db.prepare('UPDATE user_progression SET spendable_xp = spendable_xp + ? WHERE user_id = ?').run(xpAmount, userId);
  const prog = db.prepare('SELECT spendable_xp, level, title FROM user_progression WHERE user_id = ?').get(userId) as { spendable_xp: number; level: number; title: string };

  return {
    xpAwarded: xpAmount,
    newBalance: prog.spendable_xp,
    leveledUp: award.leveledUp,
    newLevel: award.leveledUp ? award.newLevel : undefined,
    newTitle: award.leveledUp ? award.newTitle : undefined
  };
}

/** Get Trust Token (spendable_xp) balance */
export function getTrustTokenBalance(userId: string): number {
  const row = getDb().prepare('SELECT spendable_xp FROM user_progression WHERE user_id = ?').get(userId) as { spendable_xp: number } | undefined;
  return row?.spendable_xp ?? 0;
}

/** Get all active shop items */
export function getSparkShopItems(category?: string): any[] {
  if (category) {
    return getDb().prepare(
      'SELECT * FROM spark_shop_items WHERE category = ? AND active = 1 ORDER BY price_tt ASC'
    ).all(category) as any[];
  }
  return getDb().prepare(
    'SELECT * FROM spark_shop_items WHERE active = 1 ORDER BY category, price_tt ASC'
  ).all() as any[];
}

/** Purchase a shop item with Trust Tokens */
export function purchaseSparkItem(userId: string, itemId: string): { success: boolean; error?: string; newBalance?: number } {
  const db = getDb();
  const item = db.prepare('SELECT * FROM spark_shop_items WHERE id = ? AND active = 1').get(itemId) as any;
  if (!item) return { success: false, error: 'Item not found' };

  // Check if already purchased (for unique items)
  const alreadyOwned = db.prepare('SELECT id FROM spark_purchases WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  if (alreadyOwned) return { success: false, error: 'Already owned' };

  const prog = db.prepare('SELECT spendable_xp, level, selected_guide FROM user_progression WHERE user_id = ?').get(userId) as any;
  if (!prog) return { success: false, error: 'No progression record' };

  // Check balance
  if (prog.spendable_xp < item.price_tt) return { success: false, error: 'Insufficient Trust Tokens' };

  // Check level requirement
  if (prog.level < item.level_requirement) return { success: false, error: `Requires level ${item.level_requirement}` };

  // Check guide requirement
  if (item.guide_requirement && prog.selected_guide !== item.guide_requirement.replace('guide-', '')) {
    return { success: false, error: `Requires ${item.guide_requirement.replace('guide-', '')} path` };
  }

  // Check stock
  if (item.limited_stock !== null && item.sold_count >= item.limited_stock) {
    return { success: false, error: 'Out of stock' };
  }

  const now = Date.now();
  const newBalance = prog.spendable_xp - item.price_tt;

  // Deduct Trust Tokens
  db.prepare('UPDATE user_progression SET spendable_xp = ? WHERE user_id = ?').run(newBalance, userId);

  // Record purchase
  db.prepare(
    'INSERT INTO spark_purchases (id, user_id, item_id, price_tt, balance_after, purchased_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(uuidv4(), userId, itemId, item.price_tt, newBalance, now);

  // Update sold count
  db.prepare('UPDATE spark_shop_items SET sold_count = sold_count + 1 WHERE id = ?').run(itemId);

  return { success: true, newBalance };
}

/** Get user's purchased items */
export function getUserPurchases(userId: string): any[] {
  return getDb().prepare(`
    SELECT sp.id, sp.item_id, sp.price_tt, sp.purchased_at,
           si.name, si.description, si.category, si.item_type, si.icon_svg, si.rarity
    FROM spark_purchases sp
    JOIN spark_shop_items si ON si.id = sp.item_id
    WHERE sp.user_id = ?
    ORDER BY sp.purchased_at DESC
  `).all(userId) as any[];
}

/** Get user's avatar configuration */
export function getSparkAvatar(userId: string): any {
  let avatar = getDb().prepare('SELECT * FROM spark_avatar WHERE user_id = ?').get(userId);
  if (!avatar) {
    getDb().prepare(
      'INSERT INTO spark_avatar (user_id, avatar_base, updated_at) VALUES (?, ?, ?)'
    ).run(userId, 'default', Date.now());
    avatar = getDb().prepare('SELECT * FROM spark_avatar WHERE user_id = ?').get(userId);
  }
  return avatar;
}

/** Equip an item to avatar */
export function equipSparkItem(userId: string, itemId: string, slot: 'hat' | 'outfit' | 'accessory' | 'background' | 'title'): boolean {
  // Verify ownership
  const owned = getDb().prepare('SELECT id FROM spark_purchases WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  if (!owned) return false;

  // Ensure avatar exists
  getSparkAvatar(userId);

  const col = `${slot}_item_id`;
  getDb().prepare(
    `UPDATE spark_avatar SET ${col} = ?, updated_at = ? WHERE user_id = ?`
  ).run(itemId, Date.now(), userId);
  return true;
}

/** Get Spark stats for a user (overview) */
export function getSparkStats(userId: string): any {
  const db = getDb();
  const prog = db.prepare('SELECT spendable_xp, selected_guide FROM user_progression WHERE user_id = ?').get(userId) as any;
  const lessonsCompleted = (db.prepare(
    "SELECT COUNT(*) as cnt FROM spark_progress WHERE user_id = ? AND status = 'completed'"
  ).get(userId) as { cnt: number }).cnt;
  const lessonsStarted = (db.prepare(
    "SELECT COUNT(*) as cnt FROM spark_progress WHERE user_id = ? AND status = 'started'"
  ).get(userId) as { cnt: number }).cnt;
  const totalTimeSeconds = (db.prepare(
    'SELECT COALESCE(SUM(time_spent_seconds), 0) as total FROM spark_progress WHERE user_id = ?'
  ).get(userId) as { total: number }).total;
  const itemsOwned = (db.prepare(
    'SELECT COUNT(*) as cnt FROM spark_purchases WHERE user_id = ?'
  ).get(userId) as { cnt: number }).cnt;

  return {
    trustTokens: prog?.spendable_xp ?? 0,
    selectedGuide: prog?.selected_guide ?? null,
    lessonsCompleted,
    lessonsStarted,
    totalTimeMinutes: Math.round(totalTimeSeconds / 60),
    itemsOwned
  };
}

/** Parent link: connect parent to child account */
export function createParentLink(parentUserId: string, childUserId: string): string {
  const id = uuidv4();
  getDb().prepare(
    'INSERT INTO spark_parent_links (id, parent_user_id, child_user_id, linked_at) VALUES (?, ?, ?, ?)'
  ).run(id, parentUserId, childUserId, Date.now());
  return id;
}

/** Get parent's linked children */
export function getParentChildren(parentUserId: string): any[] {
  return getDb().prepare(`
    SELECT spl.child_user_id, spl.permissions, spl.daily_time_limit_minutes, spl.linked_at,
           u.name, u.email,
           up.level, up.xp_total, up.spendable_xp, up.selected_guide
    FROM spark_parent_links spl
    JOIN users u ON u.id = spl.child_user_id
    LEFT JOIN user_progression up ON up.user_id = spl.child_user_id
    WHERE spl.parent_user_id = ? AND spl.active = 1
  `).all(parentUserId) as any[];
}

/** Get child's parent link (for permission checks) */
export function getChildParentLink(childUserId: string): any | undefined {
  return getDb().prepare(
    'SELECT * FROM spark_parent_links WHERE child_user_id = ? AND active = 1'
  ).get(childUserId);
}

// ─── Debate Pipeline Functions ───────────────────────────────────────────────

/** Insert a source article from RSS ingestion */
export function insertDebateSource(source: {
  id: string; title: string; summary: string; source_url: string;
  source_name: string; author?: string; published_at?: number; topic_tags?: string[];
}): boolean {
  try {
    getDb().prepare(`
      INSERT OR IGNORE INTO debate_sources (id, title, summary, source_url, source_name, author, published_at, fetched_at, topic_tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.id, source.title, source.summary, source.source_url,
      source.source_name, source.author || null, source.published_at || Date.now(),
      Date.now(), JSON.stringify(source.topic_tags || [])
    );
    return true;
  } catch { return false; }
}

/** Get recent unused source articles */
export function getUnusedSources(limit = 10): any[] {
  return getDb().prepare(
    'SELECT * FROM debate_sources WHERE used_in_debate = 0 ORDER BY published_at DESC LIMIT ?'
  ).all(limit) as any[];
}

/** Mark source as used in a debate */
export function markSourceUsed(sourceId: string): void {
  getDb().prepare('UPDATE debate_sources SET used_in_debate = 1 WHERE id = ?').run(sourceId);
}

/** Insert a generated debate */
export function insertDebate(debate: {
  id: string; topic: string; question: string; summary?: string;
  source_article_id?: string; source_url?: string; source_name?: string;
  source_title?: string; exchanges: any[]; status?: string;
  published?: number; featured?: number;
}): void {
  getDb().prepare(`
    INSERT INTO debates (id, topic, question, summary, source_article_id, source_url, source_name, source_title, exchanges, status, published, featured, created_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    debate.id, debate.topic, debate.question, debate.summary || null,
    debate.source_article_id || null, debate.source_url || null,
    debate.source_name || null, debate.source_title || null,
    JSON.stringify(debate.exchanges), debate.status || 'published',
    debate.published ?? 1, debate.featured ?? 1,
    Date.now(), debate.published ? Date.now() : null
  );
}

/** Get the latest featured debate */
export function getLatestDebate(): any | undefined {
  const row = getDb().prepare(
    'SELECT * FROM debates WHERE published = 1 AND featured = 1 ORDER BY published_at DESC LIMIT 1'
  ).get() as any;
  if (row) {
    row.exchanges = JSON.parse(row.exchanges || '[]');
  }
  return row;
}

/** Get a specific debate by ID */
export function getDebateById(id: string): any | undefined {
  const row = getDb().prepare('SELECT * FROM debates WHERE id = ?').get(id) as any;
  if (row) {
    row.exchanges = JSON.parse(row.exchanges || '[]');
  }
  return row;
}

/** List recent debates */
export function listDebates(limit = 10, offset = 0): any[] {
  const rows = getDb().prepare(
    'SELECT id, topic, question, summary, source_name, source_title, status, published, featured, created_at, published_at FROM debates ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as any[];
  return rows;
}

/** Get recent debate sources */
export function listDebateSources(limit = 20): any[] {
  return getDb().prepare(
    'SELECT * FROM debate_sources ORDER BY fetched_at DESC LIMIT ?'
  ).all(limit) as any[];
}

/** Unflag all featured debates (before setting a new one) */
export function clearFeaturedDebates(): void {
  getDb().prepare('UPDATE debates SET featured = 0 WHERE featured = 1').run();
}
