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
import { getDb, createStorefront, getStorefrontBySlug, getStorefrontByUserId, updateStorefront } from '../db/database';
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
  tradeFor: z.string().max(500).optional(),
  tags: z.array(z.string().max(30)).max(10).optional().default([]),
  agentId: z.string().uuid().optional(),
  condition: z.enum(['new', 'like-new', 'good', 'acceptable']).optional(),
  platform: z.enum(['ps5', 'ps4', 'xbox-series', 'xbox-one', 'switch', 'pc', 'retro', 'other']).optional(),
  sku: z.string().max(100).optional(),
  externalUrl: z.string().url().max(500).optional(),
  externalSource: z.enum(['ebay', 'amazon', 'other']).optional(),
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
 * GET /v1/marketplace/listings — Browse published listings
 */
router.get('/listings', async (req: Request, res: Response) => {
  try {
    const type = req.query.type as string;
    const category = req.query.category as string;
    const search = req.query.q as string;
    const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : undefined;
    const platform = req.query.platform as string;
    const condition = req.query.condition as string;
    const storefront = req.query.storefront as string;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    let query = `SELECT l.*, u.name as seller_name, u.email as seller_email, u.tier as seller_tier, u.created_at as seller_created_at,
                 (SELECT COUNT(*) FROM listing_likes WHERE listing_id = l.id) as like_count
                 FROM marketplace_listings l
                 JOIN users u ON l.user_id = u.id
                 WHERE l.status = 'published'`;
    const params: any[] = [];

    if (type) {
      query += ` AND l.listing_type = ?`;
      params.push(type);
    }
    if (category) {
      query += ` AND l.category = ?`;
      params.push(category);
    }
    if (search) {
      query += ` AND (l.title LIKE ? OR l.description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
    if (maxPrice !== undefined) {
      query += ` AND l.price_usdc <= ?`;
      params.push(maxPrice);
    }
    if (platform) {
      query += ` AND l.platform = ?`;
      params.push(platform);
    }
    if (condition) {
      query += ` AND l.condition = ?`;
      params.push(condition);
    }
    if (storefront) {
      query += ` AND l.user_id = ?`;
      params.push(storefront);
    }

    // Count
    const countQuery = query.replace(/SELECT l\.\*, u\.name as seller_name, u\.email as seller_email/, 'SELECT COUNT(*) as total');
    const { total } = getDb().prepare(countQuery).get(...params) as any;

    query += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, (page - 1) * limit);

    const listings = getDb().prepare(query).all(...params) as any[];

    res.json({
      success: true,
      data: {
        listings: listings.map(l => ({
          id: l.id,
          userId: l.user_id,
          title: l.title,
          description: l.description,
          listingType: l.listing_type,
          category: l.category,
          priceUsdc: l.price_usdc,
          tradeFor: l.trade_for,
          tags: JSON.parse(l.tags || '[]'),
          condition: l.condition,
          platform: l.platform,
          sku: l.sku,
          externalUrl: l.external_url,
          externalSource: l.external_source,
          sellerName: l.seller_name,
          sellerId: l.user_id,
          sellerTier: l.seller_tier || 'standard',
          sellerVerified: l.seller_tier === 'pro' || l.seller_tier === 'elite',
          sellerAge: Math.floor((Date.now() - (l.seller_created_at || Date.now())) / (1000 * 60 * 60 * 24)),
          likeCount: l.like_count || 0,
          viewCount: l.view_count,
          hasAgent: !!l.assigned_agent_id,
          createdAt: l.created_at,
          publishedAt: l.published_at,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
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
      SELECT l.*, u.name as seller_name
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
        tradeFor: listing.trade_for,
        tags: JSON.parse(listing.tags || '[]'),
        condition: listing.condition,
        platform: listing.platform,
        sku: listing.sku,
        externalUrl: listing.external_url,
        externalSource: listing.external_source,
        sellerName: listing.seller_name,
        status: listing.status,
        hasAgent: !!listing.assigned_agent_id,
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
 */
router.post('/threads', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const senderId = authReq.user?.sub;
    if (!senderId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const parsed = ThreadCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { recipientId, listingId, contractId, subject, initialMessage } = parsed.data;

    // Don't allow messaging yourself
    if (senderId === recipientId) {
      return res.status(400).json({ success: false, error: 'Cannot message yourself' });
    }

    // Check if thread already exists between these two for this listing/contract
    const existing = getDb().prepare(`
      SELECT id FROM message_threads
      WHERE ((participant_a = ? AND participant_b = ?) OR (participant_a = ? AND participant_b = ?))
        AND COALESCE(listing_id, '') = COALESCE(?, '')
        AND COALESCE(contract_id, '') = COALESCE(?, '')
        AND status = 'active'
    `).get(senderId, recipientId, recipientId, senderId, listingId ?? '', contractId ?? '') as any;

    if (existing) {
      // Thread exists — just add the message
      const msgId = uuid();
      const now = Date.now();
      getDb().prepare('INSERT INTO messages (id, thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(msgId, existing.id, senderId, initialMessage, now);
      getDb().prepare('UPDATE message_threads SET updated_at = ? WHERE id = ?')
        .run(now, existing.id);

      return res.json({
        success: true,
        data: { threadId: existing.id, messageId: msgId, isNew: false },
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
      .run(msgId, threadId, senderId, initialMessage, now);

    logger.info('Message thread created', { threadId, senderId, recipientId, listingId, contractId });

    res.status(201).json({
      success: true,
      data: { threadId, messageId: msgId, isNew: true },
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

    // Get other party names
    const result = threads.map(t => {
      const otherUser = getDb().prepare('SELECT name, email FROM users WHERE id = ?').get(t.other_party) as any;
      return {
        threadId: t.id,
        listingId: t.listing_id,
        contractId: t.contract_id,
        subject: t.subject,
        otherPartyId: t.other_party,
        otherPartyName: otherUser?.name ?? 'Unknown',
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
 */
router.post('/threads/:id/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub;

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

    const msgId = uuid();
    const now = Date.now();

    getDb().prepare('INSERT INTO messages (id, thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, req.params.id, userId, parsed.data.body, now);

    getDb().prepare('UPDATE message_threads SET updated_at = ? WHERE id = ?')
      .run(now, req.params.id);

    res.status(201).json({
      success: true,
      data: { messageId: msgId, threadId: req.params.id, createdAt: now },
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
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || 'borealis-jwt-secret-2026') as any;
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
                 (SELECT COUNT(*) FROM listing_likes WHERE listing_id = l.id) as like_count
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

    // Count
    const countQuery = query.replace(/SELECT l\.\*, u\.name/, 'SELECT COUNT(*) as total');
    const { total } = getDb().prepare(countQuery).get(...params) as any;

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
          sellerVerified: l.seller_tier === 'pro' || l.seller_tier === 'elite',
          likeCount: l.like_count || 0,
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
  tradeFor: z.string().max(500).optional(),
  tags: z.array(z.string().max(30)).max(10).optional().default([]),
  condition: z.enum(['new', 'like-new', 'good', 'acceptable']).optional(),
  platform: z.enum(['ps5', 'ps4', 'xbox-series', 'xbox-one', 'switch', 'pc', 'retro', 'other']).optional(),
  sku: z.string().max(100).optional(),
  externalUrl: z.string().url().max(500).optional(),
  externalSource: z.enum(['ebay', 'amazon', 'other']).optional(),
});

const BulkImportSchema = z.object({
  listings: z.array(BulkListingSchema).max(100),
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

    let imported = 0;
    let failed = 0;
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < parsed.data.listings.length; i++) {
      try {
        const item = parsed.data.listings[i];
        const listingId = uuid();
        const now = Date.now();

        // Run content moderation
        const moderation = moderateListing(userId, 'elite', item.title, item.description, item.tags || []);

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
             price_usdc, trade_for, tags, status, condition, platform, sku, external_url, external_source, created_at, updated_at, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          listingId, userId, item.title, item.description, item.listingType, item.category,
          item.priceUsdc ?? null, item.tradeFor ?? null, JSON.stringify(item.tags || []),
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

export default router;
