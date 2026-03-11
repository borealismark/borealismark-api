/**
 * BorealisMark — Expanded Marketplace Routes
 *
 * Full peer-to-peer economy: Users and Agents can list, buy, sell, and trade.
 * Every listing is audited before publishing. Parties negotiate via message
 * threads, then commit through escrow-secured contracts with bidirectional
 * ratings anchored to Hedera.
 *
 *   ── Listings ──
 *   POST   /v1/marketplace/listings            — Create a listing (enters audit queue)
 *   GET    /v1/marketplace/listings             — Browse published listings
 *   GET    /v1/marketplace/listings/:id         — Get listing details
 *   GET    /v1/marketplace/listings/my          — Get user's own listings (all statuses)
 *   PATCH  /v1/marketplace/listings/:id         — Update own listing
 *   POST   /v1/marketplace/listings/:id/assign  — Assign agent to help sell
 *
 *   ── Audit ──
 *   GET    /v1/marketplace/audits/queue         — Admin: get pending audits
 *   PATCH  /v1/marketplace/audits/:id           — Admin: approve/reject listing
 *
 *   ── Messaging ──
 *   POST   /v1/marketplace/threads              — Start a DM thread (re: listing or contract)
 *   GET    /v1/marketplace/threads              — List user's threads
 *   GET    /v1/marketplace/threads/:id          — Get thread messages
 *   POST   /v1/marketplace/threads/:id/messages — Send a message
 *
 *   ── Escrow Deposits ──
 *   POST   /v1/marketplace/contracts/:id/deposit   — Initiate escrow deposit
 *   POST   /v1/marketplace/contracts/:id/verify    — Verify deposit via Mirror Node
 *
 *   ── Ratings ──
 *   POST   /v1/marketplace/contracts/:id/rate      — Rate counterparty (1-5)
 *   GET    /v1/marketplace/contracts/:id/ratings    — Get ratings for a contract
 *
 *   ── Settlement ──
 *   POST   /v1/marketplace/contracts/:id/complete  — Mark contract complete + settle
 *   POST   /v1/marketplace/contracts/:id/dispute   — Raise a dispute
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { requireAuth, type AuthRequest } from './auth';
import { logger } from '../middleware/logger';
import { getDb, createStorefront, getStorefrontBySlug, getStorefrontByUserId, updateStorefront, getUserSanction, addViolation, upsertUserSanction, getViolationCount, getUserViolations, getAllViolations, getAllSanctions, getUserTrustLevel, computeAndStoreTrustScore } from '../db/database';
import {
  USDC_TOKEN_ID,
  TREASURY_ACCOUNT_ID,
} from '../hedera/usdc';
import {
  moderateListing,
  getTierPrivileges,
  scanContent,
  getModerationStats,
} from '../middleware/contentModeration';
import {
  getActiveProhibitedItems,
  addProhibitedItem,
  removeProhibitedItem,
} from '../db/database';
import {
  moderateServerSide,
  determineAction,
  actionToSanctionParams,
  formatSanctionStatus,
  type SanctionAction,
} from '../middleware/messageModeration';
import { importEbayStore } from '../services/ebayScraper';
import { createHash } from 'crypto';
import { storeInboundEmail } from './adminMail';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ListingCreateSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  listingType: z.enum(['sell', 'buy', 'trade']),
  category: z.enum([
    'digital-goods', 'physical-goods', 'services', 'ai-models',
    'datasets', 'consulting', 'creative', 'development',
    'marketing', 'other',
  ]),
  priceUsdc: z.number().min(0).max(1000000).optional(),
  priceCad: z.number().min(0).max(1000000).optional(),
  shippingCostCad: z.number().min(0).max(10000).default(0),
  tradeFor: z.string().max(500).optional(),
  tags: z.array(z.string().max(30)).max(10).optional().default([]),
  agentId: z.string().uuid().optional(),
  condition: z.enum(['new', 'like-new', 'good', 'acceptable']).optional(),
  platform: z.enum(['ps5', 'ps4', 'ps3', 'ps2', 'ps1', 'ps-vita', 'psp', 'xbox-series', 'xbox-one', 'xbox-360', 'xbox', 'switch', 'wii-u', 'wii', 'ds', 'gamecube', 'pc', 'retro', 'other']).optional(),
  sku: z.string().max(100).optional(),
  externalUrl: z.string().url().max(500).optional(),
  externalSource: z.enum(['ebay', 'amazon', 'other']).optional(),
  videoUrl: z.string().url().max(500).optional(),
});

const ListingUpdateSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(10).max(5000).optional(),
  priceUsdc: z.number().min(0).max(1000000).optional(),
  tradeFor: z.string().max(500).optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
});

const MessageSchema = z.object({
  body: z.string().min(1).max(5000),
});

const ThreadCreateSchema = z.object({
  recipientId: z.string().uuid(),
  listingId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  subject: z.string().max(200).optional().default(''),
  initialMessage: z.string().min(1).max(5000),
});

const RatingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

// ─── v44: Trust-Gated Feature Helpers ────────────────────────────────────────

/**
 * Trust level gates for marketplace features.
 * Higher trust = more visibility and capabilities.
 */
const TRUST_GATES = {
  createListing: 'basic',        // Must have at least basic trust to list
  sendMessages: 'basic',         // Must have basic trust to message
  makeOffer: 'verified',         // Must be verified to make offers
  featuredListing: 'trusted',    // Trusted+ gets featured placement
  unlimitedListings: 'premium',  // Premium+ gets unlimited listings
  exportData: 'verified',        // Verified+ can export their data
} as const;

const TRUST_LEVEL_ORDER = ['unverified', 'basic', 'verified', 'trusted', 'premium', 'elite'];

function meetsMinTrustLevel(userLevel: string, requiredLevel: string): boolean {
  const userIdx = TRUST_LEVEL_ORDER.indexOf(userLevel);
  const requiredIdx = TRUST_LEVEL_ORDER.indexOf(requiredLevel);
  return userIdx >= requiredIdx;
}

/**
 * Get listing limit based on trust level.
 * Higher trust = more concurrent active listings.
 */
function getListingLimit(trustLevel: string): number {
  const limits: Record<string, number> = {
    unverified: 2,
    basic: 5,
    verified: 15,
    trusted: 30,
    premium: 100,
    elite: 999,
  };
  return limits[trustLevel] || 2;
}

/**
 * Get trust boost multiplier for search ranking.
 * Higher trust listings appear higher in search results.
 */
function getTrustBoost(trustLevel: string): number {
  const boosts: Record<string, number> = {
    unverified: 1.0,
    basic: 1.1,
    verified: 1.3,
    trusted: 1.5,
    premium: 1.8,
    elite: 2.0,
  };
  return boosts[trustLevel] || 1.0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── LISTINGS ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/marketplace/listings — Create a new listing
 * Listing is scanned through content moderation and tier privileges.
 *   - Blocked content → rejected immediately
 *   - Flagged content → always goes to human audit regardless of tier
 *   - Clean content + Platinum/Sovereign → auto-published
 *   - Clean content + Pro/Elite → auto-published (light audit pass)
 *   - Clean content + Standard → enters audit queue
 */
router.post('/listings', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // v44: Trust-gated listing creation
    const userTrustLevel = getUserTrustLevel(userId);
    if (!meetsMinTrustLevel(userTrustLevel, TRUST_GATES.createListing)) {
      return res.status(403).json({
        success: false,
        error: 'You need at least "Basic" trust level to create listings. Verify your email to get started.',
        requiredTrust: TRUST_GATES.createListing,
        currentTrust: userTrustLevel,
      });
    }

    // Check listing limit based on trust level
    const listingLimit = getListingLimit(userTrustLevel);
    const activeCount = getDb().prepare(
      "SELECT COUNT(*) as cnt FROM marketplace_listings WHERE user_id = ? AND status NOT IN ('rejected', 'sold', 'deleted')"
    ).get(userId) as { cnt: number };

    if (activeCount.cnt >= listingLimit) {
      return res.status(403).json({
        success: false,
        error: `You've reached your listing limit (${listingLimit}). Increase your trust level to list more items.`,
        limit: listingLimit,
        current: activeCount.cnt,
        trustLevel: userTrustLevel,
      });
    }

    const parsed = ListingCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { title, description, listingType, category, priceUsdc, tradeFor, tags, agentId, condition, platform, sku, externalUrl, externalSource } = parsed.data;

    // Sell and buy listings require a price
    if ((listingType === 'sell' || listingType === 'buy') && !priceUsdc) {
      return res.status(400).json({
        success: false,
        error: 'Price is required for buy/sell listings',
      });
    }

    // Trade listings require tradeFor description
    if (listingType === 'trade' && !tradeFor) {
      return res.status(400).json({
        success: false,
        error: 'Trade-for description is required for trade listings',
      });
    }

    // ─── Content Moderation + Tier Privileges ─────────────────────────
    const userTier = authReq.user?.tier ?? 'standard';
    const moderation = moderateListing(userId, userTier, title, description, tags);

    // Blocked by content moderation (prohibited items or listing limit)
    if (moderation.status === 'blocked') {
      return res.status(403).json({
        success: false,
        error: moderation.reason,
        moderation: {
          verdict: moderation.scanResult.verdict,
          matchedKeywords: moderation.scanResult.matchedKeywords.map(m => ({
            keyword: m.keyword,
            category: m.category,
            foundIn: m.foundIn,
          })),
          listingLimitReached: moderation.listingLimitReached,
          tierPrivileges: {
            tier: userTier,
            maxListings: moderation.tierPrivileges.maxActiveListings,
          },
        },
      });
    }

    const listingId = uuid();
    const now = Date.now();

    if (moderation.status === 'auto_published') {
      // ─── Auto-publish (clean content + elevated tier) ─────────────
      getDb().prepare(`
        INSERT INTO marketplace_listings
          (id, user_id, agent_id, title, description, listing_type, category,
           price_usdc, trade_for, tags, status, condition, platform, sku, external_url, external_source, created_at, updated_at, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        listingId, userId, agentId ?? null, title, description, listingType, category,
        priceUsdc ?? null, tradeFor ?? null, JSON.stringify(tags),
        condition ?? null, platform ?? null, sku ?? null, externalUrl ?? null, externalSource ?? null,
        now, now, now,
      );

      logger.info('Marketplace listing auto-published', {
        listingId, userId, userTier, listingType, category,
        reason: moderation.reason,
      });

      const badge = moderation.tierPrivileges.badge;

      res.status(201).json({
        success: true,
        data: {
          id: listingId,
          title,
          listingType,
          category,
          status: 'published',
          badge,
          message: moderation.reason,
          createdAt: now,
          publishedAt: now,
        },
      });
    } else {
      // ─── Pending audit (flagged content or standard tier) ─────────
      const auditId = uuid();

      getDb().prepare(`
        INSERT INTO marketplace_listings
          (id, user_id, agent_id, title, description, listing_type, category,
           price_usdc, trade_for, tags, status, condition, platform, sku, external_url, external_source, audit_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_audit', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        listingId, userId, agentId ?? null, title, description, listingType, category,
        priceUsdc ?? null, tradeFor ?? null, JSON.stringify(tags),
        condition ?? null, platform ?? null, sku ?? null, externalUrl ?? null, externalSource ?? null,
        auditId, now, now,
      );

      // Create audit record with moderation notes
      const auditNotes = moderation.scanResult.matchedKeywords.length > 0
        ? `Auto-flagged keywords: ${moderation.scanResult.matchedKeywords.map(m => `${m.keyword} (${m.severity}/${m.foundIn})`).join(', ')}`
        : null;

      getDb().prepare(`
        INSERT INTO listing_audits (id, listing_id, status, notes, created_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(auditId, listingId, auditNotes, now);

      logger.info('Marketplace listing created (pending audit)', {
        listingId, userId, userTier, listingType, category,
        flaggedKeywords: moderation.scanResult.matchedKeywords.map(m => m.keyword),
      });

      res.status(201).json({
        success: true,
        data: {
          id: listingId,
          title,
          listingType,
          category,
          status: 'pending_audit',
          auditId,
          message: moderation.reason,
          createdAt: now,
        },
      });
    }
  } catch (err: any) {
    logger.error('Listing creation error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create listing' });
  }
});

/**
 * GET /v1/marketplace/category-counts — Get listing counts per category
 */
router.get('/category-counts', async (_req: Request, res: Response) => {
  try {
    const rows = getDb().prepare(
      `SELECT category, COUNT(*) as count FROM marketplace_listings WHERE status = 'published' GROUP BY category ORDER BY count DESC`
    ).all() as Array<{ category: string; count: number }>;

    const total = rows.reduce((sum, r) => sum + r.count, 0);

    res.json({
      success: true,
      data: { total, categories: rows },
    });
  } catch (err: any) {
    logger.error('Category counts error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load category counts' });
  }
});

/**
 * GET /v1/marketplace/listings — Browse published listings with advanced search
 */
router.get('/listings', async (req: Request, res: Response) => {
  try {
    // v44: Advanced search and filtering
    const q = (req.query.q as string || '').trim();
    const category = req.query.category as string;
    const listingType = req.query.listingType as string;
    const minPrice = parseFloat(req.query.minPrice as string) || 0;
    const maxPrice = parseFloat(req.query.maxPrice as string) || 0;
    const condition = req.query.condition as string;
    const sort = req.query.sort as string || 'newest';
    const minTrustLevel = req.query.trustLevel as string;
    const storeId = req.query.storeId as string;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 24));
    const offset = (page - 1) * limit;

    let where = "l.status = 'published'";
    const params: any[] = [];

    if (q) {
      where += " AND (l.title LIKE ? OR l.description LIKE ?)";
      params.push(`%${q}%`, `%${q}%`);
    }
    if (category) {
      where += " AND l.category = ?";
      params.push(category);
    }
    if (listingType) {
      where += " AND l.listing_type = ?";
      params.push(listingType);
    }
    if (minPrice > 0) {
      where += " AND (l.price_cad >= ? OR l.price_usdc >= ?)";
      params.push(minPrice, minPrice);
    }
    if (maxPrice > 0) {
      where += " AND (l.price_cad <= ? OR l.price_usdc <= ?)";
      params.push(maxPrice, maxPrice);
    }
    if (condition) {
      where += " AND l.condition = ?";
      params.push(condition);
    }
    if (minTrustLevel) {
      const minIdx = TRUST_LEVEL_ORDER.indexOf(minTrustLevel);
      if (minIdx >= 0) {
        const validLevels = TRUST_LEVEL_ORDER.slice(minIdx);
        where += ` AND uts.trust_level IN (${validLevels.map(() => '?').join(',')})`;
        params.push(...validLevels);
      }
    }
    if (storeId) {
      where += " AND EXISTS (SELECT 1 FROM seller_storefronts s WHERE s.user_id = l.user_id AND s.id = ?)";
      params.push(storeId);
    }

    // Sort order
    let orderBy = 'l.published_at DESC';
    switch (sort) {
      case 'oldest': orderBy = 'l.published_at ASC'; break;
      case 'price_low': orderBy = 'COALESCE(l.price_cad, l.price_usdc) ASC'; break;
      case 'price_high': orderBy = 'COALESCE(l.price_cad, l.price_usdc) DESC'; break;
      case 'popular': orderBy = 'l.view_count DESC'; break;
      case 'newest': default: orderBy = 'l.published_at DESC'; break;
    }

    // Count total results
    const countQuery = `SELECT COUNT(*) as total FROM marketplace_listings l LEFT JOIN user_trust_scores uts ON l.user_id = uts.user_id WHERE ${where}`;
    const totalResult = getDb().prepare(countQuery).get(...params) as { total: number };

    // Fetch results with trust data
    const query = `
      SELECT l.*,
        uts.trust_level as seller_trust_level,
        uts.total_score as seller_trust_score,
        u.name as seller_name,
        sf.store_name as seller_store_name,
        sf.slug as seller_store_slug,
        (SELECT COUNT(*) FROM listing_likes ll WHERE ll.listing_id = l.id) as like_count
      FROM marketplace_listings l
      LEFT JOIN user_trust_scores uts ON l.user_id = uts.user_id
      LEFT JOIN users u ON l.user_id = u.id
      LEFT JOIN seller_storefronts sf ON l.user_id = sf.user_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;
    const listings = getDb().prepare(query).all(...params, limit, offset) as any[];

    res.json({
      success: true,
      data: {
        listings: listings.map(l => {
          const trustLevel = l.seller_trust_level || 'unverified';
          const trustBoost = getTrustBoost(trustLevel);
          return {
            id: l.id,
            userId: l.user_id,
            title: l.title,
            description: l.description,
            listingType: l.listing_type,
            category: l.category,
            priceUsdc: l.price_usdc,
            priceCad: l.price_cad,
            shippingCostCad: l.shipping_cost_cad || 0,
            tradeFor: l.trade_for,
            tags: JSON.parse(l.tags || '[]'),
            condition: l.condition,
            platform: l.platform,
            sku: l.sku,
            externalUrl: l.external_url,
            externalSource: l.external_source,
            sellerName: l.seller_name,
            sellerId: l.user_id,
            sellerTrustLevel: trustLevel,
            sellerTrustScore: l.seller_trust_score || 0,
            sellerStorefront: l.seller_store_name ? {
              name: l.seller_store_name,
              slug: l.seller_store_slug,
            } : null,
            trustBoost,
            likeCount: l.like_count || 0,
            viewCount: l.view_count,
            hasAgent: !!l.assigned_agent_id,
            createdAt: l.created_at,
            publishedAt: l.published_at,
            images: JSON.parse(l.images || '[]'),
          };
        }),
        pagination: { page, limit, total: totalResult.total, totalPages: Math.ceil(totalResult.total / limit) },
        searchParams: {
          query: q || undefined,
          category: category || undefined,
          listingType: listingType || undefined,
          priceRange: (minPrice > 0 || maxPrice > 0) ? { min: minPrice, max: maxPrice } : undefined,
          condition: condition || undefined,
          minTrustLevel: minTrustLevel || undefined,
          sort,
        },
      },
    });
  } catch (err: any) {
    logger.error('Listing browse error', { error: err.message });
    res.status(500).json({ success: false, error: 'Browse failed' });
  }
});

/**
 * GET /v1/marketplace/listings/my — Get user's own listings (all statuses)
 */
router.get('/listings/my', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const listings = getDb().prepare(`
      SELECT l.*, la.status as audit_status, la.reason as audit_reason
      FROM marketplace_listings l
      LEFT JOIN listing_audits la ON l.audit_id = la.id
      WHERE l.user_id = ?
      ORDER BY l.created_at DESC
    `).all(userId) as any[];

    res.json({
      success: true,
      data: {
        listings: listings.map(l => ({
          id: l.id,
          title: l.title,
          description: l.description,
          listingType: l.listing_type,
          category: l.category,
          priceUsdc: l.price_usdc,
          tradeFor: l.trade_for,
          tags: JSON.parse(l.tags || '[]'),
          status: l.status,
          auditStatus: l.audit_status,
          auditReason: l.audit_reason,
          assignedAgentId: l.assigned_agent_id,
          viewCount: l.view_count,
          createdAt: l.created_at,
          publishedAt: l.published_at,
          images: JSON.parse(l.images || '[]'),
        })),
      },
    });
  } catch (err: any) {
    logger.error('My listings error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch listings' });
  }
});

/**
 * GET /v1/marketplace/listings/:id — Get listing detail
 */
router.get('/listings/:id', async (req: Request, res: Response) => {
  try {
    const listing = getDb().prepare(`
      SELECT l.*, u.name as seller_name, u.tier as seller_tier, u.created_at as seller_created_at,
        (SELECT COUNT(*) FROM listing_likes WHERE listing_id = l.id) as like_count,
                 (SELECT COUNT(*) FROM user_watchlist WHERE listing_id = l.id) as watch_count
      FROM marketplace_listings l
      JOIN users u ON l.user_id = u.id
      WHERE l.id = ?
    `).get(req.params.id) as any;

    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    // Increment view count
    getDb().prepare('UPDATE marketplace_listings SET view_count = view_count + 1 WHERE id = ?')
      .run(req.params.id);

    // Get seller storefront info
    const storefront = getDb().prepare(
      'SELECT slug, store_name FROM seller_storefronts WHERE user_id = ?'
    ).get(listing.user_id) as { slug: string; store_name: string } | undefined;

    res.json({
      success: true,
      data: {
        id: listing.id,
        userId: listing.user_id,
        title: listing.title,
        description: listing.description,
        listingType: listing.listing_type,
        category: listing.category,
        priceUsdc: listing.price_usdc,
        priceCad: listing.price_cad,
        shippingCostCad: listing.shipping_cost_cad || 0,
        tradeFor: listing.trade_for,
        tags: JSON.parse(listing.tags || '[]'),
        images: JSON.parse(listing.images || '[]'),
        condition: listing.condition,
        platform: listing.platform,
        sku: listing.sku,
        externalUrl: listing.external_url,
        externalSource: listing.external_source,
        videoUrl: listing.video_url,
        sellerName: listing.seller_name,
        sellerTier: listing.seller_tier || 'standard',
        sellerVerified: listing.seller_tier === 'pro' || listing.seller_tier === 'elite',
        sellerTrustLevel: getUserTrustLevel(listing.user_id),
        sellerMemberSince: listing.seller_created_at,
        sellerStoreSlug: storefront?.slug,
        sellerStoreName: storefront?.store_name,
        status: listing.status,
        hasAgent: !!listing.assigned_agent_id,
        likeCount: listing.like_count || 0,
        watchCount: listing.watch_count || 0,
        viewCount: listing.view_count + 1,
        createdAt: listing.created_at,
        publishedAt: listing.published_at,
      },
    });
  } catch (err: any) {
    logger.error('Listing detail error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch listing' });
  }
});

/**
 * PATCH /v1/marketplace/listings/bulk-update — Admin bulk update images & shipping
 * Body: { updates: [{ id, images?, shippingCostCad? }] }
 * MUST be defined before /listings/:id to avoid Express param matching
 */
router.patch('/listings/bulk-update', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userTier = authReq.user?.tier ?? 'standard';
    if (!['admin', 'sovereign'].includes(userTier)) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ success: false, error: 'updates array required' });
    }

    const db = getDb();
    const stmt = db.prepare('UPDATE marketplace_listings SET images = ?, shipping_cost_cad = ?, updated_at = ? WHERE id = ?');
    let updated = 0;
    let errors: string[] = [];

    for (const u of updates) {
      try {
        if (!u.id) { errors.push('Missing id'); continue; }
        // images can be a JSON string or an array — normalize to JSON string
        const images = u.images ? (typeof u.images === 'string' ? u.images : JSON.stringify(u.images)) : undefined;
        const shipping = typeof u.shippingCostCad === 'number' ? u.shippingCostCad : undefined;
        if (!images && shipping === undefined) { continue; }

        const existing = db.prepare('SELECT id, images, shipping_cost_cad FROM marketplace_listings WHERE id = ?').get(u.id) as any;
        if (!existing) { errors.push(`Not found: ${u.id}`); continue; }

        const finalImages = images || existing.images;
        const finalShipping = shipping !== undefined ? shipping : (existing.shipping_cost_cad || 0);
        stmt.run(finalImages, finalShipping, Date.now(), u.id);
        updated++;
      } catch (e: any) {
        errors.push(`${u.id}: ${e.message}`);
      }
    }

    res.json({ success: true, data: { updated, failed: errors.length, errors: errors.length > 0 ? errors : undefined, total: updates.length } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /v1/marketplace/listings/:id — Update own listing
 * Can only update listings in pending_audit or rejected status
 */
router.patch('/listings/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;

    const listing = getDb().prepare('SELECT * FROM marketplace_listings WHERE id = ? AND user_id = ?')
      .get(req.params.id, userId) as any;

    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found or not yours' });
    }

    if (!['pending_audit', 'rejected', 'published'].includes(listing.status)) {
      return res.status(400).json({ success: false, error: 'Cannot edit listing in current state' });
    }

    const parsed = ListingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const updates = parsed.data;
    const now = Date.now();

    // ─── Scan updated content through moderation ──────────────────────
    const newTitle = updates.title ?? listing.title;
    const newDesc = updates.description ?? listing.description;
    const newTags = updates.tags ?? JSON.parse(listing.tags || '[]');

    const scanResult = scanContent(newTitle, newDesc, newTags);

    // Block prohibited content even on edits
    if (scanResult.verdict === 'block') {
      return res.status(403).json({
        success: false,
        error: 'Updated content contains prohibited items and cannot be saved.',
        moderation: {
          verdict: 'block',
          matchedKeywords: scanResult.matchedKeywords.map(m => ({
            keyword: m.keyword,
            category: m.category,
            foundIn: m.foundIn,
          })),
        },
      });
    }

    // Determine new status based on tier and scan result
    const authReq2 = req as AuthRequest;
    const userTier = authReq2.user?.tier ?? 'standard';
    const privileges = getTierPrivileges(userTier);

    let newStatus: string;
    let newAuditId = listing.audit_id;

    if (scanResult.verdict === 'flag') {
      // Flagged → always audit
      newStatus = 'pending_audit';
      newAuditId = uuid();
      const auditNotes = `Edit re-scan flagged: ${scanResult.matchedKeywords.map(m => `${m.keyword} (${m.severity})`).join(', ')}`;
      getDb().prepare(`INSERT INTO listing_audits (id, listing_id, status, notes, created_at) VALUES (?, ?, 'pending', ?, ?)`)
        .run(newAuditId, req.params.id, auditNotes, now);
    } else if (listing.status === 'published' && privileges.auditType === 'none') {
      // Platinum/Sovereign editing a published listing: stays published
      newStatus = 'published';
    } else if (listing.status === 'published' && privileges.auditType === 'light') {
      // Pro/Elite editing a published listing: stays published if clean
      newStatus = 'published';
    } else if (listing.status === 'published') {
      // Standard editing a published listing: back to audit
      newStatus = 'pending_audit';
      newAuditId = uuid();
      getDb().prepare(`INSERT INTO listing_audits (id, listing_id, status, created_at) VALUES (?, ?, 'pending', ?)`)
        .run(newAuditId, req.params.id, now);
    } else if (listing.status === 'rejected') {
      newStatus = 'pending_audit';
      newAuditId = uuid();
      getDb().prepare(`INSERT INTO listing_audits (id, listing_id, status, created_at) VALUES (?, ?, 'pending', ?)`)
        .run(newAuditId, req.params.id, now);
    } else {
      newStatus = listing.status;
    }

    getDb().prepare(`
      UPDATE marketplace_listings SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        price_usdc = COALESCE(?, price_usdc),
        trade_for = COALESCE(?, trade_for),
        tags = COALESCE(?, tags),
        status = ?,
        audit_id = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      updates.title ?? null, updates.description ?? null,
      updates.priceUsdc ?? null, updates.tradeFor ?? null,
      updates.tags ? JSON.stringify(updates.tags) : null,
      newStatus, newAuditId, now, req.params.id,
    );

    res.json({
      success: true,
      data: {
        id: req.params.id,
        status: newStatus,
        message: newStatus === 'pending_audit'
          ? 'Listing updated and resubmitted for review'
          : 'Listing updated successfully',
        updatedAt: now,
      },
    });
  } catch (err: any) {
    logger.error('Listing update error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update listing' });
  }
});

/**
 * POST /v1/marketplace/listings/:id/assign — Assign an agent to help sell
 */
router.post('/listings/:id/assign', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId is required' });
    }

    const listing = getDb().prepare('SELECT * FROM marketplace_listings WHERE id = ? AND user_id = ?')
      .get(req.params.id, userId) as any;

    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found or not yours' });
    }

    const now = Date.now();
    getDb().prepare('UPDATE marketplace_listings SET assigned_agent_id = ?, updated_at = ? WHERE id = ?')
      .run(agentId, now, req.params.id);

    logger.info('Agent assigned to listing', { listingId: req.params.id, agentId, userId });

    res.json({
      success: true,
      data: { listingId: req.params.id, assignedAgentId: agentId, message: 'Agent assigned to help with this listing' },
    });
  } catch (err: any) {
    logger.error('Agent assign error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to assign agent' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── AUDIT QUEUE ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/marketplace/audits/queue — Admin: get pending listing audits
 */
router.get('/audits/queue', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    if (authReq.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const audits = getDb().prepare(`
      SELECT la.*, ml.title, ml.description, ml.listing_type, ml.category,
             ml.price_usdc, ml.trade_for, u.name as poster_name, u.email as poster_email
      FROM listing_audits la
      JOIN marketplace_listings ml ON la.listing_id = ml.id
      JOIN users u ON ml.user_id = u.id
      WHERE la.status = 'pending'
      ORDER BY la.created_at ASC
      LIMIT 50
    `).all() as any[];

    res.json({
      success: true,
      data: {
        audits: audits.map(a => ({
          auditId: a.id,
          listingId: a.listing_id,
          title: a.title,
          description: a.description,
          listingType: a.listing_type,
          category: a.category,
          priceUsdc: a.price_usdc,
          tradeFor: a.trade_for,
          posterName: a.poster_name,
          posterEmail: a.poster_email,
          createdAt: a.created_at,
        })),
        pendingCount: audits.length,
      },
    });
  } catch (err: any) {
    logger.error('Audit queue error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch audit queue' });
  }
});

/**
 * PATCH /v1/marketplace/audits/:id — Admin: approve or reject a listing
 */
router.patch('/audits/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    if (authReq.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { decision, reason } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ success: false, error: 'Decision must be "approved" or "rejected"' });
    }

    const audit = getDb().prepare('SELECT * FROM listing_audits WHERE id = ?')
      .get(req.params.id) as any;

    if (!audit) {
      return res.status(404).json({ success: false, error: 'Audit not found' });
    }

    if (audit.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Audit already processed' });
    }

    const now = Date.now();

    // Update audit record
    getDb().prepare(`
      UPDATE listing_audits SET status = ?, reason = ?, auditor_id = ?, completed_at = ? WHERE id = ?
    `).run(decision, reason ?? null, authReq.user?.sub, now, req.params.id);

    // Update listing status
    const newListingStatus = decision === 'approved' ? 'published' : 'rejected';
    getDb().prepare(`
      UPDATE marketplace_listings SET status = ?, published_at = ?, updated_at = ? WHERE id = ?
    `).run(newListingStatus, decision === 'approved' ? now : null, now, audit.listing_id);

    logger.info('Listing audit completed', {
      auditId: req.params.id,
      listingId: audit.listing_id,
      decision,
      auditorId: authReq.user?.sub,
    });

    res.json({
      success: true,
      data: {
        auditId: req.params.id,
        listingId: audit.listing_id,
        decision,
        reason: reason ?? null,
        listingStatus: newListingStatus,
      },
    });
  } catch (err: any) {
    logger.error('Audit decision error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to process audit' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MESSAGING (DM / NEGOTIATION THREADS) ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/marketplace/threads — Start a new DM thread
 *
 * Also applies moderation enforcement to the initial message.
 */
router.post('/threads', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const senderId = authReq.user?.sub;
    if (!senderId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // ─── Check sender's sanction status ──────────────────────────────────
    const sanction = getUserSanction(senderId);
    if (sanction) {
      const now = Date.now();

      if (sanction.status === 'banned') {
        return res.status(403).json({
          success: false,
          error: 'Your account has been permanently suspended for policy violations.',
          banned: true,
        });
      }

      if (sanction.status === 'suspended' && sanction.suspended_until && sanction.suspended_until > now) {
        const date = new Date(sanction.suspended_until).toLocaleString();
        return res.status(403).json({
          success: false,
          error: `Your account is suspended until ${date} for policy violations.`,
          suspended: true,
          suspendedUntil: sanction.suspended_until,
        });
      }

      if (sanction.status === 'muted' && sanction.muted_until && sanction.muted_until > now) {
        const date = new Date(sanction.muted_until).toLocaleString();
        return res.status(403).json({
          success: false,
          error: `You are muted until ${date}. Please review our community guidelines.`,
          muted: true,
          mutedUntil: sanction.muted_until,
        });
      }
    }

    const parsed = ThreadCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { recipientId, listingId, contractId, subject, initialMessage } = parsed.data;

    // Don't allow messaging yourself
    if (senderId === recipientId) {
      return res.status(400).json({ success: false, error: 'Cannot message yourself' });
    }

    // ─── Moderate the initial message ────────────────────────────────────
    const modResult = moderateServerSide(initialMessage);

    if (modResult.blocked) {
      // Get current violation count and determine action
      const violationCount = (sanction?.violation_count ?? 0) + 1;
      const action = determineAction(violationCount, modResult.severity);

      // Log the violation
      addViolation(
        senderId,
        modResult.violationType || 'unknown',
        modResult.severity,
        null,
        null,  // no thread yet since we're blocking creation
        JSON.stringify(modResult.matchedPatterns),
        action,
      );

      // Apply the sanction
      const sanctionParams = actionToSanctionParams(action as SanctionAction);
      upsertUserSanction(
        senderId,
        sanctionParams.status,
        sanctionParams.mutedUntil,
        sanctionParams.suspendedUntil,
        violationCount,
      );

      logger.warn('Thread creation blocked by content moderation', {
        senderId,
        recipientId,
        violationType: modResult.violationType,
        severity: modResult.severity,
        patterns: modResult.matchedPatterns,
        action,
      });

      return res.status(400).json({
        success: false,
        error: `Message violates community guidelines (${modResult.violationType}). ${
          action === 'mute_24h' ? 'You have been muted for 24 hours.' :
          action === 'suspend_7d' ? 'Your account has been suspended for 7 days.' :
          action === 'permanent_ban' ? 'Your account has been permanently suspended.' :
          'Please review our community guidelines.'
        }`,
        moderation: {
          blocked: true,
          reason: modResult.reason,
          violationType: modResult.violationType,
          severity: modResult.severity,
          action,
        },
      });
    }

    // Check if thread already exists between these two for this listing/contract
    const existing = getDb().prepare(`
      SELECT id FROM message_threads
      WHERE ((participant_a = ? AND participant_b = ?) OR (participant_a = ? AND participant_b = ?))
        AND COALESCE(listing_id, '') = COALESCE(?, '')
        AND COALESCE(contract_id, '') = COALESCE(?, '')
        AND status = 'active'
    `).get(senderId, recipientId, recipientId, senderId, listingId ?? '', contractId ?? '') as any;

    let finalMessage = initialMessage;
    if (!modResult.clean) {
      finalMessage = modResult.filteredText;
      // Log warning-level violation
      addViolation(
        senderId,
        modResult.violationType || 'unknown',
        modResult.severity,
        null,
        null,
        JSON.stringify(modResult.matchedPatterns),
        'warning',
      );
    }

    if (existing) {
      // Thread exists — just add the message
      const msgId = uuid();
      const now = Date.now();
      getDb().prepare('INSERT INTO messages (id, thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(msgId, existing.id, senderId, finalMessage, now);
      getDb().prepare('UPDATE message_threads SET updated_at = ? WHERE id = ?')
        .run(now, existing.id);

      return res.json({
        success: true,
        data: { threadId: existing.id, messageId: msgId, isNew: false, filtered: !modResult.clean },
      });
    }

    const threadId = uuid();
    const msgId = uuid();
    const now = Date.now();

    getDb().prepare(`
      INSERT INTO message_threads (id, listing_id, contract_id, participant_a, participant_b, subject, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(threadId, listingId ?? null, contractId ?? null, senderId, recipientId, subject, now, now);

    getDb().prepare('INSERT INTO messages (id, thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, threadId, senderId, finalMessage, now);

    logger.info('Message thread created', { threadId, senderId, recipientId, listingId, contractId });

    res.status(201).json({
      success: true,
      data: { threadId, messageId: msgId, isNew: true, filtered: !modResult.clean },
    });
  } catch (err: any) {
    logger.error('Thread creation error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create thread' });
  }
});

/**
 * GET /v1/marketplace/threads — List user's message threads
 */
router.get('/threads', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;

    const threads = getDb().prepare(`
      SELECT t.*,
        CASE WHEN t.participant_a = ? THEN t.participant_b ELSE t.participant_a END as other_party,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.sender_id != ? AND m.read_at IS NULL) as unread_count,
        (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) as last_message
      FROM message_threads t
      WHERE (t.participant_a = ? OR t.participant_b = ?) AND t.status = 'active'
      ORDER BY t.updated_at DESC
      LIMIT 50
    `).all(userId, userId, userId, userId) as any[];

    // Get other party names and tier
    const result = threads.map(t => {
      const otherUser = getDb().prepare('SELECT name, email, tier FROM users WHERE id = ?').get(t.other_party) as any;
      return {
        threadId: t.id,
        listingId: t.listing_id,
        contractId: t.contract_id,
        subject: t.subject,
        otherPartyId: t.other_party,
        otherPartyName: otherUser?.name ?? 'Unknown',
        otherPartyTier: otherUser?.tier ?? 'unverified',
        unreadCount: t.unread_count,
        lastMessage: t.last_message,
        updatedAt: t.updated_at,
        createdAt: t.created_at,
      };
    });

    res.json({ success: true, data: { threads: result } });
  } catch (err: any) {
    logger.error('Thread list error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list threads' });
  }
});

/**
 * GET /v1/marketplace/threads/:id — Get thread messages
 */
router.get('/threads/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;

    const thread = getDb().prepare(`
      SELECT * FROM message_threads WHERE id = ? AND (participant_a = ? OR participant_b = ?)
    `).get(req.params.id, userId, userId) as any;

    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }

    // Mark messages as read
    getDb().prepare('UPDATE messages SET read_at = ? WHERE thread_id = ? AND sender_id != ? AND read_at IS NULL')
      .run(Date.now(), req.params.id, userId);

    const messages = getDb().prepare(`
      SELECT m.*, u.name as sender_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.thread_id = ?
      ORDER BY m.created_at ASC
      LIMIT 200
    `).all(req.params.id) as any[];

    res.json({
      success: true,
      data: {
        thread: {
          id: thread.id,
          listingId: thread.listing_id,
          contractId: thread.contract_id,
          subject: thread.subject,
          participantA: thread.participant_a,
          participantB: thread.participant_b,
        },
        messages: messages.map(m => ({
          id: m.id,
          senderId: m.sender_id,
          senderName: m.sender_name,
          body: m.body,
          readAt: m.read_at,
          createdAt: m.created_at,
        })),
      },
    });
  } catch (err: any) {
    logger.error('Thread fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch thread' });
  }
});

/**
 * POST /v1/marketplace/threads/:id/messages — Send a message
 *
 * With server-side content moderation enforcement:
 *   1. Check if user is muted/suspended/banned
 *   2. Run moderation scan on message
 *   3. Block if critical/major violations found
 *   4. Log violations and apply escalating sanctions
 */
router.post('/threads/:id/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;

    // v44: Trust-gated messaging
    const senderTrustLevel = getUserTrustLevel(userId!);
    if (!meetsMinTrustLevel(senderTrustLevel, TRUST_GATES.sendMessages)) {
      return res.status(403).json({
        success: false,
        error: 'You need at least "Basic" trust level to send messages. Verify your email to get started.',
      });
    }

    // ─── Step 1: Check user sanction status ─────────────────────────────────
    const sanction = getUserSanction(userId!);
    if (sanction) {
      const now = Date.now();

      if (sanction.status === 'banned') {
        return res.status(403).json({
          success: false,
          error: 'Your account has been permanently suspended for policy violations.',
          banned: true,
        });
      }

      if (sanction.status === 'suspended' && sanction.suspended_until && sanction.suspended_until > now) {
        const date = new Date(sanction.suspended_until).toLocaleString();
        return res.status(403).json({
          success: false,
          error: `Your account is suspended until ${date} for policy violations.`,
          suspended: true,
          suspendedUntil: sanction.suspended_until,
        });
      }

      if (sanction.status === 'muted' && sanction.muted_until && sanction.muted_until > now) {
        const date = new Date(sanction.muted_until).toLocaleString();
        return res.status(403).json({
          success: false,
          error: `You are muted until ${date}. Please review our community guidelines.`,
          muted: true,
          mutedUntil: sanction.muted_until,
        });
      }
    }

    const thread = getDb().prepare(`
      SELECT * FROM message_threads WHERE id = ? AND (participant_a = ? OR participant_b = ?) AND status = 'active'
    `).get(req.params.id, userId, userId) as any;

    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found or closed' });
    }

    const parsed = MessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Message body is required (1-5000 chars)' });
    }

    // ─── Step 2: Run moderation scan ──────────────────────────────────────
    const messageBody = parsed.data.body;
    const modResult = moderateServerSide(messageBody);

    // ─── Step 3: Handle blocked violations ────────────────────────────────
    if (modResult.blocked) {
      // Get current violation count and determine action
      const violationCount = (sanction?.violation_count ?? 0) + 1;
      const action = determineAction(violationCount, modResult.severity);

      // Log the violation
      addViolation(
        userId!,
        modResult.violationType || 'unknown',
        modResult.severity,
        null,  // no message ID since we're blocking it
        req.params.id,
        JSON.stringify(modResult.matchedPatterns),
        action,
      );

      // Apply the sanction
      const sanctionParams = actionToSanctionParams(action as SanctionAction);
      upsertUserSanction(
        userId!,
        sanctionParams.status,
        sanctionParams.mutedUntil,
        sanctionParams.suspendedUntil,
        violationCount,
      );

      logger.warn('Message blocked by content moderation', {
        userId,
        threadId: req.params.id,
        violationType: modResult.violationType,
        severity: modResult.severity,
        patterns: modResult.matchedPatterns,
        action,
        violationCount,
      });

      // Return error with enforcement details
      const statusParams = sanctionParams;
      return res.status(400).json({
        success: false,
        error: `Message violates community guidelines (${modResult.violationType}). ${
          action === 'mute_24h' ? 'You have been muted for 24 hours.' :
          action === 'suspend_7d' ? 'Your account has been suspended for 7 days.' :
          action === 'permanent_ban' ? 'Your account has been permanently suspended.' :
          'Please review our community guidelines.'
        }`,
        moderation: {
          blocked: true,
          reason: modResult.reason,
          violationType: modResult.violationType,
          severity: modResult.severity,
          action,
        },
        sanction: statusParams.status !== 'active' ? statusParams : undefined,
      });
    }

    // ─── Step 4: Handle filtered (warning-level) violations ────────────────
    let finalBody = messageBody;
    let shouldLog = false;

    if (!modResult.clean) {
      // Message is filtered but allowed
      finalBody = modResult.filteredText;

      // Log warning-level violation
      const violationCount = (sanction?.violation_count ?? 0) + 1;
      addViolation(
        userId!,
        modResult.violationType || 'unknown',
        modResult.severity,
        null,
        req.params.id,
        JSON.stringify(modResult.matchedPatterns),
        'warning',
      );

      shouldLog = true;
      logger.info('Message filtered by content moderation', {
        userId,
        threadId: req.params.id,
        violationType: modResult.violationType,
        patterns: modResult.matchedPatterns,
      });
    }

    // ─── Step 5: Save message ────────────────────────────────────────────
    const msgId = uuid();
    const now = Date.now();

    getDb().prepare('INSERT INTO messages (id, thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, req.params.id, userId, finalBody, now);

    getDb().prepare('UPDATE message_threads SET updated_at = ? WHERE id = ?')
      .run(now, req.params.id);

    res.status(201).json({
      success: true,
      data: {
        messageId: msgId,
        threadId: req.params.id,
        createdAt: now,
        filtered: !modResult.clean,
        filterReason: !modResult.clean ? modResult.reason : undefined,
      },
    });
  } catch (err: any) {
    logger.error('Message send error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ESCROW DEPOSITS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/marketplace/contracts/:id/deposit — Initiate escrow deposit
 * Returns USDC payment instructions with unique memo.
 */
router.post('/contracts/:id/deposit', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    const { party } = req.body; // 'provider' or 'requester'

    if (!['provider', 'requester'].includes(party)) {
      return res.status(400).json({ success: false, error: 'Party must be "provider" or "requester"' });
    }

    const contract = getDb().prepare('SELECT * FROM terminal_contracts WHERE id = ?')
      .get(req.params.id) as any;

    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    if (!['pending', 'escrow'].includes(contract.status)) {
      return res.status(400).json({ success: false, error: 'Contract not in deposit phase' });
    }

    // Check if this party already deposited
    const existingDeposit = getDb().prepare(
      'SELECT * FROM contract_deposits WHERE contract_id = ? AND party = ?'
    ).get(req.params.id, party) as any;

    if (existingDeposit) {
      return res.json({
        success: true,
        data: {
          depositId: existingDeposit.id,
          status: existingDeposit.status,
          memo: existingDeposit.memo,
          amount: existingDeposit.amount_usdc,
          message: existingDeposit.status === 'confirmed'
            ? 'Deposit already confirmed'
            : 'Deposit already initiated — use verify endpoint to check',
        },
      });
    }

    const depositId = uuid();
    const memo = `BM-ESC:${req.params.id}:${party}:${depositId.slice(0, 8)}`;
    const amount = contract.agreed_price; // Both parties deposit the agreed price
    const now = Date.now();

    getDb().prepare(`
      INSERT INTO contract_deposits (id, contract_id, party, agent_id, amount_usdc, memo, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      depositId, req.params.id, party,
      party === 'provider' ? contract.provider_agent_id : contract.requester_agent_id,
      amount, memo, now,
    );

    // Move contract to escrow state if still pending
    if (contract.status === 'pending') {
      getDb().prepare('UPDATE terminal_contracts SET status = ?, updated_at = ? WHERE id = ?')
        .run('escrow', now, req.params.id);
    }

    res.status(201).json({
      success: true,
      data: {
        depositId,
        contractId: req.params.id,
        party,
        payment: {
          sendTo: TREASURY_ACCOUNT_ID,
          tokenId: USDC_TOKEN_ID,
          amount: amount.toFixed(6),
          currency: 'USDC',
          memo,
          network: process.env.HEDERA_NETWORK ?? 'testnet',
        },
        instructions: [
          `Send exactly ${amount.toFixed(6)} USDC to Hedera account ${TREASURY_ACCOUNT_ID}`,
          `Include memo: ${memo}`,
          `Use POST /v1/marketplace/contracts/${req.params.id}/verify to confirm`,
        ],
      },
    });
  } catch (err: any) {
    logger.error('Deposit initiation error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to initiate deposit' });
  }
});

/**
 * POST /v1/marketplace/contracts/:id/verify — Verify escrow deposit via Mirror Node
 */
router.post('/contracts/:id/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const { party } = req.body;

    const deposit = getDb().prepare(
      'SELECT * FROM contract_deposits WHERE contract_id = ? AND party = ?'
    ).get(req.params.id, party) as any;

    if (!deposit) {
      return res.status(404).json({ success: false, error: 'No deposit found for this party' });
    }

    if (deposit.status === 'confirmed') {
      return res.json({ success: true, data: { status: 'already_confirmed' } });
    }

    // Query Mirror Node for matching USDC transfer
    const MIRROR_NODE_BASE = process.env.HEDERA_MIRROR_NODE_URL
      ?? (process.env.HEDERA_NETWORK === 'mainnet'
        ? 'https://mainnet.mirrornode.hedera.com'
        : 'https://testnet.mirrornode.hedera.com');

    const sinceTimestamp = (deposit.created_at / 1000).toFixed(9);
    const url = `${MIRROR_NODE_BASE}/api/v1/transactions`
      + `?account.id=${TREASURY_ACCOUNT_ID}`
      + `&transactiontype=CRYPTOTRANSFER`
      + `&timestamp=gte:${sinceTimestamp}`
      + `&limit=50&order=desc`;

    const response = await fetch(url);
    if (!response.ok) {
      return res.json({ success: true, data: { status: 'pending', message: 'Mirror node unavailable, try again' } });
    }

    const data = await response.json() as any;
    const expectedAmount = BigInt(Math.round(deposit.amount_usdc * 1_000_000));

    for (const tx of data.transactions) {
      if (tx.result !== 'SUCCESS') continue;
      const decodedMemo = Buffer.from(tx.memo_base64 ?? '', 'base64').toString('utf-8');
      if (decodedMemo !== deposit.memo) continue;

      const tokenTransfers = tx.token_transfers ?? [];
      const match = tokenTransfers.find(
        (t: any) => t.token_id === USDC_TOKEN_ID
          && t.account === TREASURY_ACCOUNT_ID
          && BigInt(t.amount) >= expectedAmount,
      );

      if (match) {
        const now = Date.now();
        getDb().prepare(`
          UPDATE contract_deposits SET status = 'confirmed', hedera_transaction_id = ?, confirmed_at = ? WHERE id = ?
        `).run(tx.transaction_id, now, deposit.id);

        // Check if BOTH parties have confirmed deposits
        const allDeposits = getDb().prepare(
          "SELECT * FROM contract_deposits WHERE contract_id = ? AND status = 'confirmed'"
        ).all(req.params.id) as any[];

        let bothConfirmed = false;
        if (allDeposits.length >= 2) {
          // Both sides confirmed — move contract to in_progress
          getDb().prepare('UPDATE terminal_contracts SET status = ?, updated_at = ? WHERE id = ?')
            .run('in_progress', now, req.params.id);
          bothConfirmed = true;
        }

        logger.info('Escrow deposit confirmed', {
          depositId: deposit.id, contractId: req.params.id, party,
          transactionId: tx.transaction_id, bothConfirmed,
        });

        return res.json({
          success: true,
          data: {
            status: 'confirmed',
            transactionId: tx.transaction_id,
            bothPartiesConfirmed: bothConfirmed,
            message: bothConfirmed
              ? 'Both deposits confirmed — contract is now in progress!'
              : 'Your deposit confirmed. Waiting for other party.',
          },
        });
      }
    }

    res.json({
      success: true,
      data: { status: 'pending', message: 'Deposit not yet detected. Ensure correct amount and memo.' },
    });
  } catch (err: any) {
    logger.error('Deposit verification error', { error: err.message });
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── RATINGS ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/marketplace/contracts/:id/rate — Rate counterparty after completion
 */
router.post('/contracts/:id/rate', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;

    const contract = getDb().prepare('SELECT * FROM terminal_contracts WHERE id = ?')
      .get(req.params.id) as any;

    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    if (contract.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Can only rate completed contracts' });
    }

    const parsed = RatingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Rating (1-5) is required' });
    }

    // Determine which agent this user is rating (rater rates the OTHER party)
    const { agentId } = req.body;
    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId (your agent) is required to identify you' });
    }

    const isProvider = agentId === contract.provider_agent_id;
    const isRequester = agentId === contract.requester_agent_id;

    if (!isProvider && !isRequester) {
      return res.status(403).json({ success: false, error: 'Your agent is not part of this contract' });
    }

    const raterAgentId = agentId;
    const ratedAgentId = isProvider ? contract.requester_agent_id : contract.provider_agent_id;

    // Check if already rated
    const existing = getDb().prepare(
      'SELECT id FROM contract_ratings WHERE contract_id = ? AND rater_agent_id = ?'
    ).get(req.params.id, raterAgentId) as any;

    if (existing) {
      return res.status(409).json({ success: false, error: 'You have already rated this contract' });
    }

    const ratingId = uuid();
    const now = Date.now();

    getDb().prepare(`
      INSERT INTO contract_ratings (id, contract_id, rater_agent_id, rated_agent_id, rating, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ratingId, req.params.id, raterAgentId, ratedAgentId, parsed.data.rating, parsed.data.comment ?? null, now);

    logger.info('Contract rated', {
      contractId: req.params.id, raterAgentId, ratedAgentId,
      rating: parsed.data.rating,
    });

    res.status(201).json({
      success: true,
      data: {
        ratingId,
        contractId: req.params.id,
        ratedAgentId,
        rating: parsed.data.rating,
        message: 'Rating submitted. This will permanently affect the rated party\'s trust score.',
      },
    });
  } catch (err: any) {
    logger.error('Rating error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to submit rating' });
  }
});

/**
 * GET /v1/marketplace/contracts/:id/ratings — Get ratings for a contract
 */
router.get('/contracts/:id/ratings', async (req: Request, res: Response) => {
  try {
    const ratings = getDb().prepare(`
      SELECT cr.*, a.name as rater_name
      FROM contract_ratings cr
      LEFT JOIN agents a ON cr.rater_agent_id = a.id
      WHERE cr.contract_id = ?
    `).all(req.params.id) as any[];

    res.json({
      success: true,
      data: {
        ratings: ratings.map(r => ({
          id: r.id,
          raterAgentId: r.rater_agent_id,
          raterName: r.rater_name,
          ratedAgentId: r.rated_agent_id,
          rating: r.rating,
          comment: r.comment,
          createdAt: r.created_at,
        })),
      },
    });
  } catch (err: any) {
    logger.error('Ratings fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch ratings' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SETTLEMENT & DISPUTES ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/marketplace/contracts/:id/complete — Mark contract complete
 * Both parties must confirm completion. Funds are then released.
 */
router.post('/contracts/:id/complete', requireAuth, async (req: Request, res: Response) => {
  try {
    const contract = getDb().prepare('SELECT * FROM terminal_contracts WHERE id = ?')
      .get(req.params.id) as any;

    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    if (contract.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: 'Contract must be in_progress to complete' });
    }

    const now = Date.now();
    getDb().prepare('UPDATE terminal_contracts SET status = ?, updated_at = ? WHERE id = ?')
      .run('completed', now, req.params.id);

    logger.info('Contract completed', {
      contractId: req.params.id,
      agreedPrice: contract.agreed_price,
      networkFee: contract.network_fee,
    });

    res.json({
      success: true,
      data: {
        contractId: req.params.id,
        status: 'completed',
        settlement: {
          providerReceives: contract.agreed_price,
          networkFee: contract.network_fee,
          requesterDeposit: 'returned',
          note: 'Both escrow deposits will be settled. Provider receives the agreed amount. Requester deposit is returned minus network fee.',
        },
        nextSteps: [
          'Both parties should rate each other via POST /v1/marketplace/contracts/:id/rate',
          'Ratings permanently affect trust scores and are anchored to Hedera',
        ],
        completedAt: now,
      },
    });
  } catch (err: any) {
    logger.error('Contract completion error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to complete contract' });
  }
});

/**
 * POST /v1/marketplace/contracts/:id/dispute — Raise a dispute
 */
router.post('/contracts/:id/dispute', requireAuth, async (req: Request, res: Response) => {
  try {
    const { reason, evidence } = req.body;

    if (!reason || reason.length < 10) {
      return res.status(400).json({ success: false, error: 'Dispute reason required (min 10 chars)' });
    }

    const contract = getDb().prepare('SELECT * FROM terminal_contracts WHERE id = ?')
      .get(req.params.id) as any;

    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    if (!['in_progress', 'escrow'].includes(contract.status)) {
      return res.status(400).json({ success: false, error: 'Can only dispute active contracts' });
    }

    const now = Date.now();
    getDb().prepare('UPDATE terminal_contracts SET status = ?, updated_at = ? WHERE id = ?')
      .run('disputed', now, req.params.id);

    logger.warn('Contract disputed', {
      contractId: req.params.id,
      reason,
    });

    res.json({
      success: true,
      data: {
        contractId: req.params.id,
        status: 'disputed',
        message: 'Dispute raised. Both escrow deposits are frozen pending resolution. ' +
                 'The outcome will permanently affect the responsible party\'s trust score, ' +
                 'AP rating, and may result in tier downgrade or platform restriction.',
        consequences: {
          forRogueParty: [
            'Permanent negative rating anchored to Hedera (immutable)',
            'AP penalty: -5,000 to -50,000 depending on severity',
            'Potential tier downgrade',
            'Dispute record visible on public BM Score profile',
            'Possible marketplace suspension for repeat offenders',
          ],
          forInnocentParty: [
            'Full deposit refund',
            'Compensation from rogue party\'s deposit',
            'Dispute resolution on public record (positive)',
          ],
        },
        disputedAt: now,
      },
    });
  } catch (err: any) {
    logger.error('Dispute error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to raise dispute' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CONTENT MODERATION (Admin) ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/marketplace/moderation/stats — Admin: get moderation overview
 */
router.get('/moderation/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    if (authReq.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const stats = getModerationStats();
    res.json({ success: true, data: stats });
  } catch (err: any) {
    logger.error('Moderation stats error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch moderation stats' });
  }
});

/**
 * GET /v1/marketplace/moderation/prohibited — Admin: list all prohibited items
 */
router.get('/moderation/prohibited', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    if (authReq.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const items = getActiveProhibitedItems();

    // Group by category
    const byCategory: Record<string, any[]> = {};
    for (const item of items) {
      if (!byCategory[item.category]) byCategory[item.category] = [];
      byCategory[item.category].push(item);
    }

    res.json({
      success: true,
      data: {
        totalItems: items.length,
        categories: Object.keys(byCategory),
        byCategory,
      },
    });
  } catch (err: any) {
    logger.error('Prohibited items list error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch prohibited items' });
  }
});

/**
 * POST /v1/marketplace/moderation/prohibited — Admin: add a new prohibited item
 */
router.post('/moderation/prohibited', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    if (authReq.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { category, keyword, severity, description } = req.body;

    if (!category || !keyword || !severity) {
      return res.status(400).json({
        success: false,
        error: 'category, keyword, and severity (block|flag|warn) are required',
      });
    }

    if (!['block', 'flag', 'warn'].includes(severity)) {
      return res.status(400).json({ success: false, error: 'severity must be block, flag, or warn' });
    }

    const id = uuid();
    addProhibitedItem(id, category, keyword, severity, description);

    logger.info('Prohibited item added', { id, category, keyword, severity });

    res.status(201).json({
      success: true,
      data: { id, category, keyword, severity, description: description ?? null },
    });
  } catch (err: any) {
    logger.error('Add prohibited item error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to add prohibited item' });
  }
});

/**
 * DELETE /v1/marketplace/moderation/prohibited/:id — Admin: deactivate a prohibited item
 */
router.delete('/moderation/prohibited/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    if (authReq.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const removed = removeProhibitedItem(req.params.id);

    if (!removed) {
      return res.status(404).json({ success: false, error: 'Prohibited item not found' });
    }

    logger.info('Prohibited item deactivated', { id: req.params.id });
    res.json({ success: true, data: { id: req.params.id, message: 'Item deactivated' } });
  } catch (err: any) {
    logger.error('Remove prohibited item error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to remove prohibited item' });
  }
});

/**
 * POST /v1/marketplace/moderation/scan — Admin: test scan text against prohibited database
 */
router.post('/moderation/scan', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    if (authReq.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { title, description, tags } = req.body;
    if (!title && !description) {
      return res.status(400).json({ success: false, error: 'Provide title and/or description to scan' });
    }

    const result = scanContent(title ?? '', description ?? '', tags ?? []);

    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error('Moderation scan error', { error: err.message });
    res.status(500).json({ success: false, error: 'Scan failed' });
  }
});

/**
 * GET /v1/marketplace/tier-info — Get tier privileges information (public)
 */
router.get('/tier-info', async (_req: Request, res: Response) => {
  const tiers = ['standard', 'pro', 'elite', 'platinum', 'sovereign'];
  const info = tiers.map(tier => ({
    tier,
    ...getTierPrivileges(tier),
  }));

  res.json({ success: true, data: { tiers: info } });
});

// ─── Social Engagement: Likes ────────────────────────────────────────────────

/** Helper: get like stats for a listing */
function getLikeStats(listingId: string, userId?: string) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT user_tier, COUNT(*) as cnt FROM listing_likes WHERE listing_id = ? GROUP BY user_tier`
  ).all(listingId) as Array<{ user_tier: string; cnt: number }>;

  const breakdown: Record<string, number> = { standard: 0, pro: 0, elite: 0 };
  let total = 0;
  for (const r of rows) {
    breakdown[r.user_tier] = (breakdown[r.user_tier] || 0) + r.cnt;
    total += r.cnt;
  }

  let userHasLiked = false;
  if (userId) {
    const row = db.prepare(`SELECT 1 FROM listing_likes WHERE listing_id = ? AND user_id = ?`).get(listingId, userId);
    userHasLiked = !!row;
  }

  return { total, breakdown, userHasLiked };
}

/**
 * POST /v1/marketplace/listings/:id/like — Like a listing
 */
router.post('/listings/:id/like', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const listingId = req.params.id;
    const db = getDb();

    // Verify listing exists and is published
    const listing = db.prepare(`SELECT id FROM marketplace_listings WHERE id = ? AND status = 'published'`).get(listingId);
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });

    // Get user tier
    const user = db.prepare(`SELECT tier FROM users WHERE id = ?`).get(userId) as any;
    const tier = user?.tier || 'standard';

    // Insert like (ignore if duplicate)
    try {
      db.prepare(`INSERT INTO listing_likes (id, listing_id, user_id, user_tier, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        uuid(), listingId, userId, tier, Date.now()
      );
    } catch (e: any) {
      if (e.message?.includes('UNIQUE constraint')) {
        const stats = getLikeStats(listingId, userId);
        return res.status(409).json({ success: false, error: 'Already liked', stats });
      }
      throw e;
    }

    const stats = getLikeStats(listingId, userId);
    res.status(201).json({ success: true, message: 'Listing liked', stats });
  } catch (err: any) {
    logger.error('Like error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to like listing' });
  }
});

/**
 * DELETE /v1/marketplace/listings/:id/like — Unlike a listing
 */
router.delete('/listings/:id/like', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const listingId = req.params.id;
    getDb().prepare(`DELETE FROM listing_likes WHERE listing_id = ? AND user_id = ?`).run(listingId, userId);

    const stats = getLikeStats(listingId, userId);
    res.json({ success: true, message: 'Like removed', stats });
  } catch (err: any) {
    logger.error('Unlike error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to unlike listing' });
  }
});

/**
 * GET /v1/marketplace/listings/:id/likes — Get like stats (public, optional auth)
 */
router.get('/listings/:id/likes', async (req: Request, res: Response) => {
  try {
    // Optional auth — extract user if present
    let userId: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) throw new Error('JWT_SECRET not configured');
        const decoded = jwt.verify(authHeader.slice(7), jwtSecret) as any;
        userId = decoded.sub;
      } catch (_) { /* not authenticated, that's fine */ }
    }

    const stats = getLikeStats(req.params.id, userId);
    res.json({ success: true, stats });
  } catch (err: any) {
    logger.error('Get likes error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch likes' });
  }
});

/**
 * GET /v1/marketplace/my-likes — Get listing IDs the current user has liked
 */
router.get('/my-likes', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const rows = getDb().prepare(`SELECT listing_id FROM listing_likes WHERE user_id = ?`).all(userId) as Array<{ listing_id: string }>;
    res.json({ success: true, likeIds: rows.map(r => r.listing_id) });
  } catch (err: any) {
    logger.error('My likes error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch likes' });
  }
});

// ─── Social Engagement: Watchlist ────────────────────────────────────────────

/**
 * POST /v1/marketplace/listings/:id/watch — Add to watchlist
 */
router.post('/listings/:id/watch', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const listingId = req.params.id;
    const db = getDb();

    const listing = db.prepare(`SELECT id FROM marketplace_listings WHERE id = ? AND status = 'published'`).get(listingId);
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });

    try {
      db.prepare(`INSERT INTO user_watchlist (id, user_id, listing_id, added_at) VALUES (?, ?, ?, ?)`).run(
        uuid(), userId, listingId, Date.now()
      );
    } catch (e: any) {
      if (e.message?.includes('UNIQUE constraint')) {
        return res.status(409).json({ success: false, error: 'Already in watchlist' });
      }
      throw e;
    }

    res.status(201).json({ success: true, message: 'Added to watchlist' });
  } catch (err: any) {
    logger.error('Watchlist add error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to add to watchlist' });
  }
});

/**
 * DELETE /v1/marketplace/listings/:id/watch — Remove from watchlist
 */
router.delete('/listings/:id/watch', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    getDb().prepare(`DELETE FROM user_watchlist WHERE user_id = ? AND listing_id = ?`).run(userId, req.params.id);
    res.json({ success: true, message: 'Removed from watchlist' });
  } catch (err: any) {
    logger.error('Watchlist remove error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to remove from watchlist' });
  }
});

/**
 * GET /v1/marketplace/watchlist — Get user's watchlist with full listing data
 */
router.get('/watchlist', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const rows = getDb().prepare(`
      SELECT w.id as watchlist_id, w.added_at, l.*, u.name as seller_name, u.tier as seller_tier
      FROM user_watchlist w
      JOIN marketplace_listings l ON w.listing_id = l.id
      JOIN users u ON l.user_id = u.id
      WHERE w.user_id = ? AND l.status = 'published'
      ORDER BY w.added_at DESC
    `).all(userId) as any[];

    res.json({
      success: true,
      data: {
        watchlist: rows.map(r => ({
          watchlistId: r.watchlist_id,
          addedAt: r.added_at,
          listingId: r.id,
          listing: {
            id: r.id,
            title: r.title,
            description: r.description,
            listingType: r.listing_type,
            category: r.category,
            priceUsdc: r.price_usdc,
            tradeFor: r.trade_for,
            tags: JSON.parse(r.tags || '[]'),
            sellerName: r.seller_name,
            sellerTier: r.seller_tier,
            sellerVerified: r.seller_tier === 'pro' || r.seller_tier === 'elite',
            viewCount: r.view_count,
            createdAt: r.created_at,
          },
        })),
        count: rows.length,
      },
    });
  } catch (err: any) {
    logger.error('Watchlist fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch watchlist' });
  }
});

/**
 * GET /v1/marketplace/my-watchlist-ids — Get listing IDs on user's watchlist
 */
router.get('/my-watchlist-ids', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const rows = getDb().prepare(`SELECT listing_id FROM user_watchlist WHERE user_id = ?`).all(userId) as Array<{ listing_id: string }>;
    res.json({ success: true, watchIds: rows.map(r => r.listing_id) });
  } catch (err: any) {
    logger.error('Watchlist IDs error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch watchlist IDs' });
  }
});

// ─── Storefronts ─────────────────────────────────────────────────────────────

const StorefrontCreateSchema = z.object({
  slug: z.string().min(3).max(50).regex(/^[a-z0-9-]+$/),
  storeName: z.string().min(2).max(100),
  description: z.string().max(1000).optional(),
  logoUrl: z.string().url().max(500).optional(),
  bannerUrl: z.string().url().max(500).optional(),
});

/**
 * POST /v1/marketplace/storefronts — Create a new seller storefront
 */
router.post('/storefronts', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const parsed = StorefrontCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // Check if user already has a storefront
    const existingStorefront = getStorefrontByUserId(userId);
    if (existingStorefront) {
      return res.status(400).json({
        success: false,
        error: 'User already has a storefront',
      });
    }

    // Check if slug is already taken
    const slugTaken = getStorefrontBySlug(parsed.data.slug);
    if (slugTaken) {
      return res.status(400).json({
        success: false,
        error: 'Slug is already taken',
      });
    }

    const storefrontId = createStorefront(
      userId,
      parsed.data.slug,
      parsed.data.storeName,
      parsed.data.description,
    );

    // Update with logo and banner URLs if provided
    if (parsed.data.logoUrl || parsed.data.bannerUrl) {
      updateStorefront(storefrontId, {
        logo_url: parsed.data.logoUrl,
        banner_url: parsed.data.bannerUrl,
      });
    }

    const storefront = getDb()
      .prepare('SELECT * FROM seller_storefronts WHERE id = ?')
      .get(storefrontId) as any;

    logger.info('Storefront created', { storefrontId, userId, slug: parsed.data.slug });

    res.status(201).json({
      success: true,
      data: {
        id: storefront.id,
        userId: storefront.user_id,
        slug: storefront.slug,
        storeName: storefront.store_name,
        description: storefront.description,
        logoUrl: storefront.logo_url,
        bannerUrl: storefront.banner_url,
        createdAt: storefront.created_at,
        updatedAt: storefront.updated_at,
      },
    });
  } catch (err: any) {
    logger.error('Storefront creation error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create storefront' });
  }
});

/**
 * GET /v1/marketplace/storefronts/featured — Get featured vendor storefronts
 * Public endpoint — must be registered BEFORE /:slug route.
 */
router.get('/storefronts/featured', async (_req: Request, res: Response) => {
  try {
    const { getFeaturedStorefronts } = await import('../db/database');
    const storefronts = getFeaturedStorefronts();

    res.json({
      success: true,
      data: storefronts.map(s => ({
        id: s.id,
        slug: s.slug,
        storeName: s.store_name,
        description: s.description,
        logoUrl: s.logo_url,
        bannerUrl: s.banner_url,
        listingCount: s.listing_count,
        avgRating: Math.round((s.avg_rating as number) * 10) / 10,
        ratingCount: s.rating_count,
        featured: true,
      })),
    });
  } catch (err: any) {
    logger.error('Featured storefronts error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch featured vendors' });
  }
});

/**
 * GET /v1/marketplace/storefronts/:slug — Get storefront details and listings (PUBLIC)
 */
router.get('/storefronts/:slug', async (req: Request, res: Response) => {
  try {
    const storefront = getStorefrontBySlug(req.params.slug);
    if (!storefront) {
      return res.status(404).json({ success: false, error: 'Storefront not found' });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const category = req.query.category as string;
    const platform = req.query.platform as string;
    const condition = req.query.condition as string;
    const search = req.query.q as string;
    const sort = (req.query.sort || 'created_at') as string;

    let query = `SELECT l.*, u.name as seller_name, u.tier as seller_tier, u.created_at as seller_created_at,
                 (SELECT COUNT(*) FROM listing_likes WHERE listing_id = l.id) as like_count,
                 (SELECT COUNT(*) FROM user_watchlist WHERE listing_id = l.id) as watch_count
                 FROM marketplace_listings l
                 JOIN users u ON l.user_id = u.id
                 WHERE l.status = 'published' AND l.user_id = ?`;
    const params: any[] = [(storefront as any).user_id];

    if (category) {
      query += ` AND l.category = ?`;
      params.push(category);
    }
    if (platform) {
      query += ` AND l.platform = ?`;
      params.push(platform);
    }
    if (condition) {
      query += ` AND l.condition = ?`;
      params.push(condition);
    }
    if (search) {
      query += ` AND (l.title LIKE ? OR l.description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    // Count — build separate count query to avoid regex issues
    let countQuery = `SELECT COUNT(*) as total FROM marketplace_listings l
                      JOIN users u ON l.user_id = u.id
                      WHERE l.status = 'published' AND l.user_id = ?`;
    const countParams: any[] = [(storefront as any).user_id];
    if (category) { countQuery += ` AND l.category = ?`; countParams.push(category); }
    if (platform) { countQuery += ` AND l.platform = ?`; countParams.push(platform); }
    if (condition) { countQuery += ` AND l.condition = ?`; countParams.push(condition); }
    if (search) { countQuery += ` AND (l.title LIKE ? OR l.description LIKE ?)`; countParams.push(`%${search}%`, `%${search}%`); }
    const { total } = getDb().prepare(countQuery).get(...countParams) as any;

    // Sorting
    const validSorts = ['created_at', 'price_usdc', 'view_count'];
    const sortField = validSorts.includes(sort) ? sort : 'created_at';
    query += ` ORDER BY l.${sortField} DESC LIMIT ? OFFSET ?`;
    params.push(limit, (page - 1) * limit);

    const listings = getDb().prepare(query).all(...params) as any[];

    res.json({
      success: true,
      data: {
        storefront: {
          id: (storefront as any).id,
          slug: (storefront as any).slug,
          storeName: (storefront as any).store_name,
          description: (storefront as any).description,
          logoUrl: (storefront as any).logo_url,
          bannerUrl: (storefront as any).banner_url,
          createdAt: (storefront as any).created_at,
        },
        listings: listings.map(l => ({
          id: l.id,
          title: l.title,
          description: l.description,
          listingType: l.listing_type,
          category: l.category,
          priceUsdc: l.price_usdc,
          condition: l.condition,
          platform: l.platform,
          sku: l.sku,
          tags: JSON.parse(l.tags || '[]'),
          images: JSON.parse(l.images || '[]'),
          sellerName: l.seller_name,
          sellerTier: l.seller_tier,
          sellerVerified: l.seller_tier === 'pro' || l.seller_tier === 'elite',
          externalUrl: l.external_url,
          externalSource: l.external_source,
          likeCount: l.like_count || 0,
          watchCount: l.watch_count || 0,
          viewCount: l.view_count,
          createdAt: l.created_at,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (err: any) {
    logger.error('Storefront fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch storefront' });
  }
});

/**
 * PATCH /v1/marketplace/storefronts/:slug — Update storefront (owner only)
 */
router.patch('/storefronts/:slug', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const storefront = getStorefrontBySlug(req.params.slug);
    if (!storefront) {
      return res.status(404).json({ success: false, error: 'Storefront not found' });
    }

    if ((storefront as any).user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const parsed = StorefrontCreateSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const updates: Record<string, any> = {};
    if (parsed.data.storeName) updates.store_name = parsed.data.storeName;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.logoUrl !== undefined) updates.logo_url = parsed.data.logoUrl;
    if (parsed.data.bannerUrl !== undefined) updates.banner_url = parsed.data.bannerUrl;

    if (Object.keys(updates).length > 0) {
      updateStorefront((storefront as any).id, updates);
    }

    const updated = getDb()
      .prepare('SELECT * FROM seller_storefronts WHERE id = ?')
      .get((storefront as any).id) as any;

    logger.info('Storefront updated', { storefrontId: updated.id, userId });

    res.json({
      success: true,
      data: {
        id: updated.id,
        userId: updated.user_id,
        slug: updated.slug,
        storeName: updated.store_name,
        description: updated.description,
        logoUrl: updated.logo_url,
        bannerUrl: updated.banner_url,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err: any) {
    logger.error('Storefront update error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update storefront' });
  }
});

// ─── Bulk Import ──────────────────────────────────────────────────────────────

const BulkListingSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  listingType: z.enum(['sell', 'buy', 'trade']),
  category: z.enum([
    'digital-goods', 'physical-goods', 'services', 'ai-models',
    'datasets', 'consulting', 'creative', 'development',
    'marketing', 'other',
  ]),
  priceUsdc: z.number().min(0).max(1000000).optional(),
  priceCad: z.number().min(0).max(1000000).optional(),
  shippingCostCad: z.number().min(0).max(10000).default(0),
  tradeFor: z.string().max(500).optional(),
  tags: z.array(z.string().max(30)).max(10).optional().default([]),
  condition: z.enum(['new', 'like-new', 'good', 'acceptable']).optional(),
  platform: z.enum(['ps5', 'ps4', 'ps3', 'ps2', 'ps1', 'ps-vita', 'psp', 'xbox-series', 'xbox-one', 'xbox-360', 'xbox', 'switch', 'wii-u', 'wii', 'ds', 'gamecube', 'pc', 'retro', 'other']).optional(),
  sku: z.string().max(100).optional(),
  externalUrl: z.string().url().max(500).optional(),
  externalSource: z.enum(['ebay', 'amazon', 'other']).optional(),
  images: z.array(z.string().url()).max(12).optional().default([]),
  videoUrl: z.string().url().max(500).optional(),
});

const BulkImportSchema = z.object({
  listings: z.array(BulkListingSchema).max(100),
  targetUserId: z.string().uuid().optional(),
});

/**
 * POST /v1/marketplace/listings/bulk — Bulk import listings (admin only)
 */
router.post('/listings/bulk', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // Check if user is admin
    const user = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as any;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const parsed = BulkImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // Admin can specify a target user to import listings under
    const targetUser = parsed.data.targetUserId || userId;

    let imported = 0;
    let failed = 0;
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < parsed.data.listings.length; i++) {
      try {
        const item = parsed.data.listings[i];
        const listingId = uuid();
        const now = Date.now();

        // Run content moderation
        const moderation = moderateListing(targetUser, 'sovereign', item.title, item.description, item.tags || []);

        // If blocked, skip this item
        if (moderation.status === 'blocked') {
          failed++;
          errors.push({ index: i, error: moderation.reason });
          continue;
        }

        // Admin bulk import always publishes automatically
        getDb().prepare(`
          INSERT INTO marketplace_listings
            (id, user_id, title, description, listing_type, category,
             price_usdc, trade_for, tags, images, status, condition, platform, sku, external_url, external_source, created_at, updated_at, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          listingId, targetUser, item.title, item.description, item.listingType, item.category,
          item.priceUsdc ?? null, item.tradeFor ?? null, JSON.stringify(item.tags || []), JSON.stringify(item.images || []),
          item.condition ?? null, item.platform ?? null, item.sku ?? null, item.externalUrl ?? null, item.externalSource ?? null,
          now, now, now,
        );

        imported++;
      } catch (err: any) {
        failed++;
        errors.push({ index: i, error: err.message });
      }
    }

    logger.info('Bulk import completed', { imported, failed, total: parsed.data.listings.length });

    res.status(201).json({
      success: true,
      imported,
      failed,
      total: parsed.data.listings.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    logger.error('Bulk import error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to import listings' });
  }
});

/**
 * DELETE /v1/marketplace/listings/bulk — Admin bulk delete all own listings
 */
router.delete('/listings/bulk', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const user = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as any;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const result = getDb().prepare('DELETE FROM marketplace_listings WHERE user_id = ?').run(userId);
    logger.info('Bulk delete completed', { deleted: result.changes, userId });

    res.json({ success: true, deleted: result.changes });
  } catch (err: any) {
    logger.error('Bulk delete error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to delete listings' });
  }
});

/**
 * POST /v1/marketplace/admin/promote — Admin: promote user tier
 */
router.post('/admin/promote', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const adminId = authReq.user?.sub;
    if (!adminId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const admin = getDb().prepare('SELECT role FROM users WHERE id = ?').get(adminId) as any;
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { userId, tier } = req.body;
    if (!userId || !tier) return res.status(400).json({ success: false, error: 'userId and tier required' });

    getDb().prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, userId);
    logger.info('User promoted', { userId, tier, by: adminId });

    res.json({ success: true, message: `User ${userId} promoted to ${tier}` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /v1/marketplace/admin/reassign — Admin: reassign all listings from one user to another
 */
router.post('/admin/reassign', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const adminId = authReq.user?.sub;
    if (!adminId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const admin = getDb().prepare('SELECT role FROM users WHERE id = ?').get(adminId) as any;
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { fromUserId, toUserId } = req.body;
    if (!fromUserId || !toUserId) return res.status(400).json({ success: false, error: 'fromUserId and toUserId required' });

    const result = getDb().prepare('UPDATE marketplace_listings SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);

    // Also transfer storefront ownership
    getDb().prepare('UPDATE seller_storefronts SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);

    logger.info('Listings reassigned', { from: fromUserId, to: toUserId, count: result.changes });

    res.json({ success: true, reassigned: result.changes });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── eBay Store Import ──────────────────────────────────────────────────────

/**
 * POST /v1/marketplace/ebay-import — Start importing an eBay store
 * Requires Pro tier or above. Visible to all, gated by tier.
 */
router.post('/ebay-import', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // Check tier — Pro or above required
    const user = getDb().prepare('SELECT tier, role FROM users WHERE id = ?').get(userId) as any;
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const allowedTiers = ['pro', 'enterprise', 'sovereign'];
    if (user.role !== 'admin' && !allowedTiers.includes(user.tier?.toLowerCase())) {
      return res.status(403).json({
        success: false,
        error: 'eBay Store Import requires a Pro tier or above subscription.',
        requiredTier: 'pro'
      });
    }

    const { storeUrl, storeName } = req.body;
    if (!storeUrl) return res.status(400).json({ success: false, error: 'storeUrl is required' });

    // Validate it looks like an eBay store URL
    if (!storeUrl.includes('ebay.com/str/') && !storeUrl.includes('ebay.ca/str/') && !storeUrl.includes('ebay.co.uk/str/')) {
      return res.status(400).json({ success: false, error: 'Invalid eBay store URL. Expected format: https://www.ebay.com/str/YourStoreName' });
    }

    // Check for existing active import
    const activeImport = getDb().prepare(
      "SELECT id, status FROM ebay_store_imports WHERE user_id = ? AND status IN ('pending', 'scraping', 'importing')"
    ).get(userId) as any;
    if (activeImport) {
      return res.status(409).json({
        success: false,
        error: 'You already have an active import in progress.',
        importId: activeImport.id,
        status: activeImport.status
      });
    }

    const importId = uuid();
    const name = storeName || storeUrl.split('/str/')[1]?.split('?')[0] || 'My eBay Store';

    getDb().prepare(
      'INSERT INTO ebay_store_imports (id, user_id, store_url, store_name, status) VALUES (?, ?, ?, ?, ?)'
    ).run(importId, userId, storeUrl, name, 'pending');

    // Kick off async import (don't await — return immediately)
    importEbayStore(importId, userId, storeUrl, name).catch(err => {
      logger.error(`[eBay Import] Async import failed: ${err.message}`);
    });

    res.status(202).json({
      success: true,
      importId,
      message: 'Import started. Poll GET /v1/marketplace/ebay-import/' + importId + ' for progress.'
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/marketplace/ebay-import/:id — Poll import status
 */
router.get('/ebay-import/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const importJob = getDb().prepare(
      'SELECT * FROM ebay_store_imports WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId) as any;

    if (!importJob) return res.status(404).json({ success: false, error: 'Import job not found' });

    res.json({
      success: true,
      data: {
        id: importJob.id,
        storeUrl: importJob.store_url,
        storeName: importJob.store_name,
        status: importJob.status,
        listingsFound: importJob.listings_found,
        listingsImported: importJob.listings_imported,
        listingsFailed: importJob.listings_failed,
        errorMessage: importJob.error_message,
        createdAt: importJob.created_at,
        completedAt: importJob.completed_at
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/marketplace/ebay-import — List user's import jobs
 */
router.get('/ebay-imports', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const imports = getDb().prepare(
      'SELECT * FROM ebay_store_imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
    ).all(userId) as any[];

    res.json({
      success: true,
      data: imports.map((j: any) => ({
        id: j.id,
        storeUrl: j.store_url,
        storeName: j.store_name,
        status: j.status,
        listingsFound: j.listings_found,
        listingsImported: j.listings_imported,
        listingsFailed: j.listings_failed,
        createdAt: j.created_at,
        completedAt: j.completed_at
      }))
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Marketing Campaigns & Referral Tracking ────────────────────────────────

/**
 * GET /r/:code — Public referral redirect (no auth)
 */
router.get('/r/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const campaign = getDb().prepare(
      'SELECT id, listing_id, platform FROM marketing_campaigns WHERE tracking_code = ?'
    ).get(code) as any;

    if (!campaign) {
      return res.redirect('https://borealisterminal.com/#browse');
    }

    // Log the click
    const clickId = uuid();
    const ipRaw = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const ipHash = createHash('sha256').update(String(ipRaw)).digest('hex').substring(0, 16);

    getDb().prepare(
      'INSERT INTO referral_clicks (id, campaign_id, tracking_code, source_platform, referrer_url, user_agent, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(clickId, campaign.id, code, campaign.platform, req.headers.referer || '', req.headers['user-agent'] || '', ipHash);

    // Redirect to listing
    res.redirect(`https://borealisterminal.com/#listing/${campaign.listing_id}?ref=${code}`);
  } catch (err: any) {
    res.redirect('https://borealisterminal.com/#browse');
  }
});

/**
 * POST /v1/marketplace/campaigns — Create a marketing campaign for a listing
 */
router.post('/campaigns', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const { listingId, platform } = req.body;
    if (!listingId || !platform) return res.status(400).json({ success: false, error: 'listingId and platform required' });

    const validPlatforms = ['x', 'instagram', 'facebook', 'general'];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ success: false, error: 'Invalid platform. Use: x, instagram, facebook, or general' });
    }

    // Verify listing belongs to user
    const listing = getDb().prepare(
      'SELECT id, title, description, price_cad, images, category, condition FROM marketplace_listings WHERE id = ? AND user_id = ?'
    ).get(listingId, userId) as any;
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found or not yours' });

    // Generate tracking code (8 char alphanumeric)
    const trackingCode = uuid().replace(/-/g, '').substring(0, 8);
    const trackingUrl = `https://borealismark-api.onrender.com/v1/marketplace/r/${trackingCode}`;

    // Generate AI copy based on platform
    const price = listing.price_cad ? `$${listing.price_cad.toFixed(2)} CAD` : 'Contact for price';
    const title = listing.title || 'Great product';
    const desc = listing.description || title;
    const condition = listing.condition || '';
    let images: string[] = [];
    try { images = JSON.parse(listing.images || '[]'); } catch(e) { images = []; }

    let campaignCopy = '';
    let hashtags: string[] = [];

    if (platform === 'x') {
      // Twitter: 280 char limit
      hashtags = ['#BorealisTerminal', '#TrustGated'];
      if (listing.category) hashtags.push('#' + listing.category.replace(/-/g, ''));
      const hashStr = hashtags.join(' ');
      const maxTitleLen = 280 - price.length - hashStr.length - trackingUrl.length - 10;
      const shortTitle = title.length > maxTitleLen ? title.substring(0, maxTitleLen - 3) + '...' : title;
      campaignCopy = `${shortTitle}\n${price}\n\n${hashStr}\n${trackingUrl}`;
    } else if (platform === 'instagram') {
      hashtags = ['#BorealisTerminal', '#TrustGated', '#OnlineShopping', '#VerifiedSeller'];
      if (listing.category) hashtags.push('#' + listing.category.replace(/-/g, ''));
      if (condition) hashtags.push('#' + condition.replace(/\s+/g, ''));
      campaignCopy = `${title}\n\n${desc.substring(0, 300)}\n\n${price}\n\nShop securely on Borealis Terminal — the trust-gated marketplace.\nLink in bio\n\n${hashtags.join(' ')}`;
    } else {
      // General / Facebook
      hashtags = ['#BorealisTerminal', '#TrustGated'];
      campaignCopy = `${title}\n\n${desc.substring(0, 500)}\n\nPrice: ${price}${condition ? ' | Condition: ' + condition : ''}\n\nShop with confidence on Borealis Terminal:\n${trackingUrl}\n\n${hashtags.join(' ')}`;
    }

    const campaignId = uuid();
    getDb().prepare(`
      INSERT INTO marketing_campaigns (id, listing_id, user_id, platform, status, campaign_copy, hashtags, image_urls, tracking_code, tracking_url)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
    `).run(
      campaignId, listingId, userId, platform,
      campaignCopy, JSON.stringify(hashtags), JSON.stringify(images.slice(0, 4)),
      trackingCode, trackingUrl
    );

    res.json({
      success: true,
      data: {
        id: campaignId,
        platform,
        trackingCode,
        trackingUrl,
        campaignCopy,
        hashtags,
        imageUrls: images.slice(0, 4)
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/marketplace/campaigns — List user's campaigns with click counts
 */
router.get('/campaigns', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const campaigns = getDb().prepare(`
      SELECT mc.*, ml.title as listing_title,
        (SELECT COUNT(*) FROM referral_clicks WHERE campaign_id = mc.id) as click_count
      FROM marketing_campaigns mc
      LEFT JOIN marketplace_listings ml ON ml.id = mc.listing_id
      WHERE mc.user_id = ?
      ORDER BY mc.created_at DESC
      LIMIT 50
    `).all(userId) as any[];

    res.json({
      success: true,
      data: campaigns.map((c: any) => ({
        id: c.id,
        listingId: c.listing_id,
        listingTitle: c.listing_title,
        platform: c.platform,
        status: c.status,
        campaignCopy: c.campaign_copy,
        hashtags: JSON.parse(c.hashtags || '[]'),
        imageUrls: JSON.parse(c.image_urls || '[]'),
        trackingCode: c.tracking_code,
        trackingUrl: c.tracking_url,
        clickCount: c.click_count,
        createdAt: c.created_at,
        postedAt: c.posted_at
      }))
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/marketplace/campaigns/:id/analytics — Detailed campaign analytics
 */
router.get('/campaigns/:id/analytics', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const campaign = getDb().prepare(
      'SELECT * FROM marketing_campaigns WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId) as any;
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

    const clicks = getDb().prepare(
      'SELECT * FROM referral_clicks WHERE campaign_id = ? ORDER BY clicked_at DESC LIMIT 100'
    ).all(campaign.id) as any[];

    const conversions = getDb().prepare(
      'SELECT * FROM marketing_conversions WHERE campaign_id = ? ORDER BY converted_at DESC LIMIT 100'
    ).all(campaign.id) as any[];

    // Click stats by day
    const clicksByDay = getDb().prepare(`
      SELECT date(clicked_at) as day, COUNT(*) as count
      FROM referral_clicks WHERE campaign_id = ?
      GROUP BY date(clicked_at) ORDER BY day DESC LIMIT 30
    `).all(campaign.id) as any[];

    res.json({
      success: true,
      data: {
        campaign: {
          id: campaign.id,
          platform: campaign.platform,
          trackingCode: campaign.tracking_code,
          trackingUrl: campaign.tracking_url,
          createdAt: campaign.created_at
        },
        totalClicks: clicks.length,
        totalConversions: conversions.length,
        ctr: clicks.length > 0 ? ((conversions.length / clicks.length) * 100).toFixed(1) + '%' : '0%',
        clicksByDay,
        recentClicks: clicks.slice(0, 20).map((c: any) => ({
          clickedAt: c.clicked_at,
          sourcePlatform: c.source_platform,
          referrer: c.referrer_url
        }))
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================
// AI Agent Task Endpoints
// =============================================

import { queueMarketingTasks, processQueuedTasks, getListingAgentStatus, getUserAgentTasks, getAgentSummary } from '../services/agentWorker';

/**
 * POST /v1/marketplace/agent/promote/:listingId — Queue AI agent marketing for a listing
 */
router.post('/agent/promote/:listingId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const { listingId } = req.params;

    // Verify listing belongs to user
    const listing = getDb().prepare(
      'SELECT id, title FROM marketplace_listings WHERE id = ? AND user_id = ?'
    ).get(listingId, userId) as any;
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found or not yours' });

    // Queue tasks for all platforms
    const taskIds = queueMarketingTasks(listingId, userId);

    // Process them immediately in the background
    processQueuedTasks().catch(err => {
      logger.error(`[Agent] Background processing failed: ${err.message}`);
    });

    res.json({
      success: true,
      data: {
        message: `AI agents queued for ${listing.title}`,
        taskIds,
        listingId
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/marketplace/agent/status/:listingId — Get agent task status for a listing
 */
router.get('/agent/status/:listingId', async (req: Request, res: Response) => {
  try {
    const { listingId } = req.params;
    const tasks = getListingAgentStatus(listingId);

    res.json({
      success: true,
      data: {
        listingId,
        tasks: tasks.map((t: any) => ({
          id: t.id,
          agentName: t.agent_name,
          taskType: t.task_type,
          platform: t.platform,
          status: t.status,
          statusMessage: t.status_message,
          trackingCode: t.tracking_code,
          updatedAt: t.updated_at
        }))
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/marketplace/agent/tasks — Get all agent tasks for the logged-in user
 */
router.get('/agent/tasks', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const tasks = getUserAgentTasks(userId);
    const summary = getAgentSummary(userId);

    res.json({
      success: true,
      data: {
        summary,
        tasks: tasks.map((t: any) => ({
          id: t.id,
          listingId: t.listing_id,
          listingTitle: t.listing_title,
          agentName: t.agent_name,
          taskType: t.task_type,
          platform: t.platform,
          status: t.status,
          statusMessage: t.status_message,
          trackingCode: t.tracking_code,
          startedAt: t.started_at,
          updatedAt: t.updated_at,
          completedAt: t.completed_at
        }))
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /v1/marketplace/agent/process — Trigger processing of queued tasks (admin only)
 */
router.post('/agent/process', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // Check admin
    const user = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as any;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    const processed = await processQueuedTasks();
    res.json({ success: true, data: { processed } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/marketplace/agent/activity — Public endpoint showing recent agent activity
 * (for showing "live" agent work on the marketplace)
 */
router.get('/agent/activity', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const recentTasks = db.prepare(`
      SELECT at.id, at.agent_name, at.task_type, at.platform, at.status, at.status_message,
             at.listing_id, at.updated_at, ml.title as listing_title
      FROM agent_tasks at
      LEFT JOIN marketplace_listings ml ON at.listing_id = ml.id
      WHERE at.updated_at > datetime('now', '-24 hours')
      ORDER BY at.updated_at DESC
      LIMIT 20
    `).all() as any[];

    res.json({
      success: true,
      data: recentTasks.map((t: any) => ({
        agentName: t.agent_name,
        platform: t.platform,
        status: t.status,
        statusMessage: t.status_message,
        listingId: t.listing_id,
        listingTitle: t.listing_title ? t.listing_title.substring(0, 60) : '',
        updatedAt: t.updated_at
      }))
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ADMIN: MODERATION DASHBOARD ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/marketplace/admin/violations — List all user violations (admin only)
 */
router.get('/admin/violations', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // Check admin
    const user = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as any;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const violations = getAllViolations(limit);

    // Enrich with user details
    const enriched = violations.map((v: any) => {
      const userInfo = getDb().prepare('SELECT name, email, tier FROM users WHERE id = ?').get(v.user_id) as any;
      return {
        ...v,
        userName: userInfo?.name || 'Unknown',
        userEmail: userInfo?.email || 'Unknown',
        userTier: userInfo?.tier || 'standard',
        details: v.details ? JSON.parse(v.details) : [],
      };
    });

    res.json({
      success: true,
      data: {
        total: enriched.length,
        violations: enriched,
      },
    });
  } catch (err: any) {
    logger.error('Admin violations list error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch violations' });
  }
});

/**
 * GET /v1/marketplace/admin/sanctions — List all active sanctions (admin only)
 */
router.get('/admin/sanctions', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // Check admin
    const user = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as any;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const sanctions = getAllSanctions(limit);

    // Format sanctions with human-readable expiry times
    const formatted = sanctions.map((s: any) => ({
      ...s,
      statusDisplay: formatSanctionStatus(
        s.status,
        s.status === 'muted' ? s.muted_until : s.status === 'suspended' ? s.suspended_until : undefined,
      ),
      mutedUntilFormatted: s.muted_until ? new Date(s.muted_until).toISOString() : null,
      suspendedUntilFormatted: s.suspended_until ? new Date(s.suspended_until).toISOString() : null,
    }));

    res.json({
      success: true,
      data: {
        total: formatted.length,
        sanctions: formatted,
      },
    });
  } catch (err: any) {
    logger.error('Admin sanctions list error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch sanctions' });
  }
});

/**
 * POST /v1/marketplace/admin/sanction — Manually apply a sanction (admin only)
 * Body: { userId: string, action: 'warning' | 'mute_24h' | 'suspend_7d' | 'permanent_ban' }
 */
router.post('/admin/sanction', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const adminId = authReq.user?.sub;
    if (!adminId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // Check admin
    const admin = getDb().prepare('SELECT role FROM users WHERE id = ?').get(adminId) as any;
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    const { userId, action } = req.body;
    if (!userId || !action || !['warning', 'mute_24h', 'suspend_7d', 'permanent_ban'].includes(action)) {
      return res.status(400).json({ success: false, error: 'userId and action required' });
    }

    // Apply sanction
    const sanctionParams = actionToSanctionParams(action as SanctionAction);
    upsertUserSanction(
      userId,
      sanctionParams.status,
      sanctionParams.mutedUntil,
      sanctionParams.suspendedUntil,
      (getUserSanction(userId)?.violation_count ?? 0) + 1,
    );

    // Log this action
    logger.warn('Admin sanction applied', {
      adminId,
      targetUserId: userId,
      action,
    });

    res.json({
      success: true,
      data: {
        message: `Sanction applied: ${action}`,
        status: sanctionParams.status,
      },
    });
  } catch (err: any) {
    logger.error('Admin sanction error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to apply sanction' });
  }
});

/**
 * POST /v1/marketplace/admin/unsanction — Lift/clear a user's sanction (admin only)
 * Body: { userId: string }
 */
router.post('/admin/unsanction', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const adminId = authReq.user?.sub;
    if (!adminId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // Check admin
    const admin = getDb().prepare('SELECT role FROM users WHERE id = ?').get(adminId) as any;
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId required' });
    }

    // Lift sanction (set status back to active, clear mutes/suspensions)
    const currentSanction = getUserSanction(userId);
    if (currentSanction) {
      upsertUserSanction(
        userId,
        'active',
        null,
        null,
        currentSanction.violation_count,
      );
    }

    logger.warn('Admin sanction lifted', {
      adminId,
      targetUserId: userId,
    });

    res.json({
      success: true,
      data: { message: 'Sanction cleared. User is now active.' },
    });
  } catch (err: any) {
    logger.error('Admin unsanction error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to lift sanction' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── STORE MIGRATION REQUEST ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const MigrationRequestSchema = z.object({
  platform: z.enum(['ebay', 'etsy', 'shopify', 'amazon', 'woocommerce', 'other']),
  storeUrl: z.string().url().max(500),
  storeName: z.string().min(1).max(200),
  listingCount: z.enum(['1-50', '51-200', '201-500', '500+']).optional(),
  notes: z.string().max(2000).optional(),
  verifyMethod: z.enum(['code', 'listing', 'email']),
  verifyCode: z.string().regex(/^BT-[A-Z0-9]{8}$/),
});

/**
 * POST /v1/marketplace/migration-request — Submit a store migration request
 *
 * Requires authentication. Validates the migration data, stores the request
 * in the admin mail center for Aurora / admin review, and returns confirmation.
 */
router.post('/migration-request', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;
    const userEmail = authReq.user?.email || 'unknown';
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // ─── Rate limit: 1 migration request per 60 seconds per user ──────
    const rateLimitKey = `migration:${userId}`;
    const now = Date.now();
    if ((globalThis as any).__migrationRateLimit === undefined) {
      (globalThis as any).__migrationRateLimit = new Map<string, number>();
    }
    const rateMap = (globalThis as any).__migrationRateLimit as Map<string, number>;
    const lastRequest = rateMap.get(rateLimitKey) || 0;
    if (now - lastRequest < 60_000) {
      return res.status(429).json({
        success: false,
        error: 'Please wait before submitting another migration request.',
      });
    }
    rateMap.set(rateLimitKey, now);

    // ─── Validate request body ────────────────────────────────────────
    const parsed = MigrationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { platform, storeUrl, storeName, listingCount, notes, verifyMethod, verifyCode } = parsed.data;

    // ─── Sanitize URL: only allow http/https ──────────────────────────
    try {
      const url = new URL(storeUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return res.status(400).json({ success: false, error: 'Invalid store URL protocol' });
      }
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid store URL' });
    }

    const platformNames: Record<string, string> = {
      ebay: 'eBay', etsy: 'Etsy', shopify: 'Shopify',
      amazon: 'Amazon', woocommerce: 'WooCommerce', other: 'Other',
    };

    const verifyMethodNames: Record<string, string> = {
      code: 'Meta Tag / Description Code',
      listing: 'Verification Listing',
      email: 'Email Verification',
    };

    // ─── Store as admin mail (internal notification) ──────────────────
    const subject = `Store Migration Request: ${platformNames[platform] || platform} → Borealis Terminal [${verifyCode}]`;
    const bodyText = [
      '=== STORE MIGRATION REQUEST ===',
      '',
      `User ID: ${userId}`,
      `User Email: ${userEmail}`,
      `Source Platform: ${platformNames[platform] || platform}`,
      `Store URL: ${storeUrl}`,
      `Store Name: ${storeName}`,
      `Estimated Listings: ${listingCount || 'Not specified'}`,
      `Verification Method: ${verifyMethodNames[verifyMethod] || verifyMethod}`,
      `Verification Code: ${verifyCode}`,
      '',
      notes ? `Notes: ${notes}` : '',
      '',
      '--- AGENT INSTRUCTIONS ---',
      `1. Verify code ${verifyCode} is present on the seller's store using method: ${verifyMethod}`,
      '2. Do NOT begin any scraping or import until verification is confirmed',
      '3. Once verified, begin catalog import with seller approval',
      '4. Report progress through the messaging system',
    ].join('\n');

    const mailId = storeInboundEmail({
      from: userEmail,
      fromName: storeName,
      to: 'verify@borealisterminal.com',
      subject,
      bodyText,
      source: 'migration-request',
    });

    // ─── Also store in migration_requests table if it exists ──────────
    try {
      const db = getDb();
      db.prepare(`
        CREATE TABLE IF NOT EXISTS migration_requests (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          store_url TEXT NOT NULL,
          store_name TEXT NOT NULL,
          listing_count TEXT,
          notes TEXT,
          verify_method TEXT NOT NULL,
          verify_code TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending_verification',
          admin_mail_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `).run();

      const reqId = uuid();
      db.prepare(`
        INSERT INTO migration_requests (id, user_id, platform, store_url, store_name, listing_count, notes, verify_method, verify_code, status, admin_mail_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        reqId, userId, platform, storeUrl, storeName,
        listingCount || null, notes || null,
        verifyMethod, verifyCode,
        'pending_verification', mailId,
        now, now,
      );

      logger.info('Migration request stored', { reqId, userId, platform, verifyCode });

      res.json({
        success: true,
        data: {
          requestId: reqId,
          status: 'pending_verification',
          verifyCode,
          message: 'Your migration request has been submitted. Our AI agent will verify your store ownership and begin the import process.',
        },
      });
    } catch (dbErr: any) {
      // Even if DB table creation fails, the admin mail was stored
      logger.error('Failed to store migration request in DB', { error: dbErr.message });
      res.json({
        success: true,
        data: {
          requestId: mailId,
          status: 'queued',
          verifyCode,
          message: 'Your migration request has been queued for processing.',
        },
      });
    }
  } catch (err: any) {
    logger.error('Migration request error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to submit migration request' });
  }
});

export default router;
