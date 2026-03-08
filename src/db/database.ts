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
  `);

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
      hedera_transaction_id TEXT,
      hcs_topic_id TEXT,
      hcs_sequence_number INTEGER,
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
      FOREIGN KEY (user_id) REFERENCES users(id)
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
  `);

  // Migrate: add CAD pricing + shipping columns to marketplace_listings
  const listingColsV2 = (db.prepare("PRAGMA table_info(marketplace_listings)").all() as Array<{ name: string }>).map(r => r.name);
  if (!listingColsV2.includes('price_cad'))          db.exec("ALTER TABLE marketplace_listings ADD COLUMN price_cad REAL");
  if (!listingColsV2.includes('shipping_cost_cad'))  db.exec("ALTER TABLE marketplace_listings ADD COLUMN shipping_cost_cad REAL DEFAULT 0");
  if (!listingColsV2.includes('video_url'))          db.exec("ALTER TABLE marketplace_listings ADD COLUMN video_url TEXT");

  // Migrate: add featured flag to seller_storefronts
  const sfCols = (db.prepare("PRAGMA table_info(seller_storefronts)").all() as Array<{ name: string }>).map(r => r.name);
  if (!sfCols.includes('featured')) db.exec("ALTER TABLE seller_storefronts ADD COLUMN featured INTEGER DEFAULT 0");

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

// ─── API Tiers Seeding ──────────────────────────────────────────────────────

export function seedApiTiers(): void {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as count FROM api_tiers').get() as { count: number };
  if (existing.count > 0) return; // Already seeded

  const tiers = [
    { id: 'tier_free', name: 'free', displayName: 'Free', monthlyLimit: 100, maxAgents: 1, maxWebhooks: 0, rateLimit: 10, priceCents: 0, stripePriceId: null },
    { id: 'tier_starter', name: 'starter', displayName: 'Starter', monthlyLimit: 10000, maxAgents: 5, maxWebhooks: 3, rateLimit: 60, priceCents: 4900, stripePriceId: 'price_1T7uLtJ5qkaENvhUYrD3Ss5e' },
    { id: 'tier_business', name: 'business', displayName: 'Business', monthlyLimit: 100000, maxAgents: 25, maxWebhooks: 10, rateLimit: 200, priceCents: 19900, stripePriceId: 'price_1T7uLrJ5qkaENvhUQ1GOXfhH' },
    { id: 'tier_enterprise', name: 'enterprise', displayName: 'Enterprise', monthlyLimit: 1000000, maxAgents: -1, maxWebhooks: -1, rateLimit: 1000, priceCents: 49900, stripePriceId: 'price_1T7uLuJ5qkaENvhUBvPN4AXr' },
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
  const total = getDb().prepare('SELECT COUNT(*) as cnt FROM bots WHERE status = "active"').get() as { cnt: number };

  const byTier = getDb().prepare(`
    SELECT tier, COUNT(*) as cnt FROM bots WHERE status = 'active' GROUP BY tier
  `).all() as Array<{ tier: string; cnt: number }>;

  const tierMap: Record<string, number> = {};
  for (const row of byTier) {
    tierMap[row.tier] = row.cnt;
  }

  const avgRating = getDb().prepare('SELECT AVG(star_rating) as avg FROM bots WHERE status = "active"').get() as { avg: number | null };
  const avgAp = getDb().prepare('SELECT AVG(ap_points) as avg FROM bots WHERE status = "active"').get() as { avg: number | null };

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
