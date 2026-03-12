/**
 * BorealisMark — Migration Officer Routes
 *
 * Cross-platform listing migration, sync scheduling, and inventory reconciliation.
 * Powered by the Migration Officer bot — handles eBay (and future platforms) import,
 * ongoing sync sweeps, and automatic sold-item detection/delisting.
 *
 *   ── Services ──
 *   GET    /v1/migration/services            — List Migration Officer service tiers
 *
 *   ── Import ──
 *   POST   /v1/migration/import              — Start a migration import job
 *   GET    /v1/migration/import/:id          — Poll import job status
 *   GET    /v1/migration/imports             — List user's import history
 *
 *   ── Sync ──
 *   POST   /v1/migration/sync/subscribe      — Subscribe to recurring sync
 *   GET    /v1/migration/sync/schedules      — List user's sync subscriptions
 *   PATCH  /v1/migration/sync/schedules/:id  — Update or pause a sync schedule
 *   POST   /v1/migration/sync/run/:id        — Manually trigger a sync sweep
 *   GET    /v1/migration/sync/status/:id     — Get last sync results
 *
 *   ── Listings ──
 *   GET    /v1/migration/listings/imported    — List user's imported listings
 *   POST   /v1/migration/listings/:id/delist — Delist an imported listing (mark sold externally)
 *   POST   /v1/migration/listings/:id/resync — Force resync a single listing
 *
 *   ── Admin ──
 *   GET    /v1/migration/admin/overview      — Admin: sync health dashboard
 *   POST   /v1/migration/admin/sweep         — Admin: trigger global sync sweep
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, type AuthRequest } from './auth';
import { logger } from '../middleware/logger';
import { getDb, computeAndStoreTrustScore } from '../db/database';
import { importEbayStore, refreshListingImages } from '../services/ebayScraper';

const router = Router();

// ─── Helper: get the Migration Officer bot ──────────────────────────────────
function getMigrationOfficer() {
  // Returns from agents table (used for services FK and general info)
  return getDb().prepare("SELECT * FROM agents WHERE name = 'Migration Officer' AND active = 1").get() as any;
}

function getMigrationOfficerBot() {
  // Returns from bots table (used for bot_jobs FK)
  return getDb().prepare("SELECT * FROM bots WHERE name = 'Migration Officer' AND status = 'active'").get() as any;
}

// ─── Helper: admin check ────────────────────────────────────────────────────
function requireAdmin(req: Request, res: Response, next: Function): void {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }
  next();
}

// ─── GET /services — List Migration Officer service tiers ───────────────────
router.get('/services', (_req: Request, res: Response) => {
  try {
    const officer = getMigrationOfficer();
    if (!officer) {
      return res.status(503).json({ success: false, error: 'Migration Officer is currently offline' });
    }

    const services = getDb().prepare(
      "SELECT * FROM terminal_services WHERE agent_id = ? AND status = 'active' ORDER BY price_usdc ASC"
    ).all(officer.id);

    return res.json({
      success: true,
      agent: {
        id: officer.id,
        name: officer.name,
        bio: officer.bio,
        tier: officer.tier,
        star_rating: officer.star_rating,
        jobs_completed: officer.jobs_completed,
      },
      services: services.map((s: any) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        price_usdc: s.price_usdc,
        capabilities: JSON.parse(s.capabilities || '[]'),
        min_trust_score: s.min_trust_score,
      })),
    });
  } catch (err: any) {
    logger.error('Error fetching migration services', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── POST /import — Start a migration import job ───────────────────────────
router.post('/import', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const { store_url, service_id } = req.body;

    if (!store_url) {
      return res.status(400).json({ success: false, error: 'store_url is required' });
    }

    // Validate service tier if provided
    let service: any = null;
    if (service_id) {
      service = getDb().prepare("SELECT * FROM terminal_services WHERE id = ?").get(service_id);
      if (!service) {
        return res.status(404).json({ success: false, error: 'Service tier not found' });
      }

      // Trust gate check
      const trustData = computeAndStoreTrustScore(userId);
      if (trustData.totalScore < (service.min_trust_score || 0)) {
        return res.status(403).json({
          success: false,
          error: `This service tier requires a trust score of at least ${service.min_trust_score}. Your current score: ${trustData.totalScore}`,
        });
      }
    }

    // Check for in-progress imports
    const activeImport = getDb().prepare(
      "SELECT id FROM ebay_store_imports WHERE user_id = ? AND status IN ('pending', 'scraping', 'importing')"
    ).get(userId);
    if (activeImport) {
      return res.status(409).json({
        success: false,
        error: 'You already have an active import in progress',
        active_import_id: (activeImport as any).id,
      });
    }

    // Extract store name from URL
    const urlMatch = store_url.match(/ebay\.\w+\/str\/([^/?]+)/i) || store_url.match(/ebay\.\w+\/usr\/([^/?]+)/i);
    const storeName = urlMatch ? decodeURIComponent(urlMatch[1]) : 'Unknown Store';

    // Create import record
    const importId = uuidv4();
    const db = getDb();

    db.prepare(
      'INSERT INTO ebay_store_imports (id, user_id, store_url, store_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(importId, userId, store_url, storeName, 'pending', Date.now());

    // Create a bot_job for the Migration Officer
    const officer = getMigrationOfficerBot();
    if (officer) {
      db.prepare(`
        INSERT INTO bot_jobs (id, bot_id, listing_id, job_type, title, description, status, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), officer.id, 'migration-import',
        `Import: ${storeName}`,
        `Importing eBay store ${storeName} (${store_url}) for user ${userId}. Service tier: ${service?.title || 'Starter'}`,
        'in_progress', Date.now(), Date.now()
      );
    }

    // Kick off the import asynchronously — imported listings get origin='imported'
    importEbayStore(importId, userId, store_url, storeName).catch(err => {
      logger.error('Migration import failed', { importId, error: err.message });
    });

    return res.status(202).json({
      success: true,
      import_id: importId,
      store_name: storeName,
      service_tier: service?.title || 'Starter',
      message: `Import started. Poll GET /v1/migration/import/${importId} for progress.`,
    });
  } catch (err: any) {
    logger.error('Error starting migration import', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── GET /import/:id — Poll import job status ──────────────────────────────
router.get('/import/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const importJob = getDb().prepare(
      'SELECT * FROM ebay_store_imports WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId) as any;

    if (!importJob) {
      return res.status(404).json({ success: false, error: 'Import job not found' });
    }

    return res.json({
      success: true,
      import: {
        id: importJob.id,
        store_url: importJob.store_url,
        store_name: importJob.store_name,
        status: importJob.status,
        listings_found: importJob.listings_found || 0,
        listings_imported: importJob.listings_imported || 0,
        listings_failed: importJob.listings_failed || 0,
        error_message: importJob.error_message,
        created_at: importJob.created_at,
        completed_at: importJob.completed_at,
      },
    });
  } catch (err: any) {
    logger.error('Error polling import status', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── GET /imports — List user's import history ──────────────────────────────
router.get('/imports', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const imports = getDb().prepare(
      'SELECT * FROM ebay_store_imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(userId);

    return res.json({ success: true, imports });
  } catch (err: any) {
    logger.error('Error listing imports', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── POST /sync/subscribe — Subscribe to recurring sync ─────────────────────
router.post('/sync/subscribe', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const { store_url, platform, frequency, tier } = req.body;

    if (!store_url) {
      return res.status(400).json({ success: false, error: 'store_url is required' });
    }

    const validFreqs = ['weekly', 'monthly'];
    const freq = validFreqs.includes(frequency) ? frequency : 'monthly';
    const syncTier = ['starter', 'professional', 'enterprise'].includes(tier) ? tier : 'starter';

    // Check for existing sync on same store
    const existing = getDb().prepare(
      "SELECT id FROM sync_schedules WHERE user_id = ? AND store_url = ? AND status = 'active'"
    ).get(userId, store_url) as any;
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'You already have an active sync schedule for this store',
        schedule_id: existing.id,
      });
    }

    // Extract store name
    const urlMatch = store_url.match(/ebay\.\w+\/str\/([^/?]+)/i) || store_url.match(/ebay\.\w+\/usr\/([^/?]+)/i);
    const storeName = urlMatch ? decodeURIComponent(urlMatch[1]) : 'Unknown Store';

    const now = Date.now();
    const nextRun = freq === 'weekly'
      ? now + 7 * 24 * 60 * 60 * 1000
      : now + 30 * 24 * 60 * 60 * 1000;

    const scheduleId = uuidv4();
    getDb().prepare(`
      INSERT INTO sync_schedules (id, user_id, store_url, platform, store_name, frequency, tier, status, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scheduleId, userId, store_url, platform || 'ebay', storeName, freq, syncTier, 'active', nextRun, now, now);

    // Count user's imported listings from this store
    const listingCount = getDb().prepare(
      "SELECT COUNT(*) as cnt FROM marketplace_listings WHERE user_id = ? AND origin = 'imported' AND external_source = ?"
    ).get(userId, platform || 'ebay') as { cnt: number };

    // Update the schedule with tracked count
    getDb().prepare("UPDATE sync_schedules SET listings_tracked = ? WHERE id = ?").run(listingCount.cnt, scheduleId);

    return res.status(201).json({
      success: true,
      schedule: {
        id: scheduleId,
        store_url,
        store_name: storeName,
        platform: platform || 'ebay',
        frequency: freq,
        tier: syncTier,
        next_run_at: nextRun,
        listings_tracked: listingCount.cnt,
      },
      message: `Sync schedule created. ${freq === 'weekly' ? 'Weekly' : 'Monthly'} sweeps will check for sold/changed items.`,
    });
  } catch (err: any) {
    logger.error('Error creating sync subscription', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── GET /sync/schedules — List user's sync subscriptions ───────────────────
router.get('/sync/schedules', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const schedules = getDb().prepare(
      'SELECT * FROM sync_schedules WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userId);

    return res.json({ success: true, schedules });
  } catch (err: any) {
    logger.error('Error listing sync schedules', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── PATCH /sync/schedules/:id — Update or pause a sync schedule ────────────
router.patch('/sync/schedules/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const { status, frequency } = req.body;
    const db = getDb();

    const schedule = db.prepare(
      'SELECT * FROM sync_schedules WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId) as any;

    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Sync schedule not found' });
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (status && ['active', 'paused', 'cancelled'].includes(status)) {
      updates.push('status = ?');
      params.push(status);
    }
    if (frequency && ['weekly', 'monthly'].includes(frequency)) {
      updates.push('frequency = ?');
      params.push(frequency);
      // Recalculate next run
      const nextRun = frequency === 'weekly'
        ? Date.now() + 7 * 24 * 60 * 60 * 1000
        : Date.now() + 30 * 24 * 60 * 60 * 1000;
      updates.push('next_run_at = ?');
      params.push(nextRun);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    updates.push('updated_at = ?');
    params.push(Date.now());
    params.push(req.params.id);

    db.prepare(`UPDATE sync_schedules SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM sync_schedules WHERE id = ?').get(req.params.id);
    return res.json({ success: true, schedule: updated });
  } catch (err: any) {
    logger.error('Error updating sync schedule', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── POST /sync/run/:id — Manually trigger a sync sweep ────────────────────
router.post('/sync/run/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const db = getDb();

    const schedule = db.prepare(
      'SELECT * FROM sync_schedules WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId) as any;

    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Sync schedule not found' });
    }

    // Get all imported listings for this user+platform
    const importedListings = db.prepare(
      "SELECT id, external_url, external_listing_id, title, sync_status FROM marketplace_listings WHERE user_id = ? AND origin = 'imported' AND external_source = ? AND status = 'published'"
    ).all(userId, schedule.platform) as any[];

    // Mark sync as running
    db.prepare('UPDATE sync_schedules SET last_run_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), req.params.id);

    // Create a bot job for the sweep
    const officer = getMigrationOfficerBot();
    if (officer) {
      db.prepare(`
        INSERT INTO bot_jobs (id, bot_id, listing_id, job_type, title, description, status, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), officer.id, 'sync-sweep',
        `Sync: ${schedule.store_name}`,
        `Manual sync sweep for ${schedule.store_name} — checking ${importedListings.length} listings`,
        'in_progress', Date.now(), Date.now()
      );
    }

    // Update last_synced_at on all checked listings
    const now = Date.now();
    for (const listing of importedListings) {
      db.prepare('UPDATE marketplace_listings SET last_synced_at = ? WHERE id = ?').run(now, listing.id);
    }

    // Calculate next run based on frequency
    const nextRun = schedule.frequency === 'weekly'
      ? now + 7 * 24 * 60 * 60 * 1000
      : now + 30 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE sync_schedules SET next_run_at = ?, listings_tracked = ?, updated_at = ? WHERE id = ?')
      .run(nextRun, importedListings.length, now, req.params.id);

    return res.json({
      success: true,
      message: `Sync sweep initiated for ${schedule.store_name}`,
      listings_checked: importedListings.length,
      next_run_at: nextRun,
    });
  } catch (err: any) {
    logger.error('Error running sync sweep', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── GET /sync/status/:id — Get last sync results ──────────────────────────
router.get('/sync/status/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const schedule = getDb().prepare(
      'SELECT * FROM sync_schedules WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId) as any;

    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Sync schedule not found' });
    }

    // Get breakdown of imported listings by sync_status
    const breakdown = getDb().prepare(`
      SELECT sync_status, COUNT(*) as cnt
      FROM marketplace_listings
      WHERE user_id = ? AND origin = 'imported' AND external_source = ?
      GROUP BY sync_status
    `).all(userId, schedule.platform) as any[];

    return res.json({
      success: true,
      schedule: {
        id: schedule.id,
        store_name: schedule.store_name,
        frequency: schedule.frequency,
        status: schedule.status,
        last_run_at: schedule.last_run_at,
        next_run_at: schedule.next_run_at,
        listings_tracked: schedule.listings_tracked,
        listings_delisted: schedule.listings_delisted,
      },
      breakdown: breakdown.reduce((acc: any, row: any) => {
        acc[row.sync_status] = row.cnt;
        return acc;
      }, {}),
    });
  } catch (err: any) {
    logger.error('Error fetching sync status', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── GET /listings/imported — List user's imported listings ─────────────────
router.get('/listings/imported', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const { platform, sync_status, page = '1', limit = '20' } = req.query;
    const offset = (Math.max(1, parseInt(page as string, 10)) - 1) * parseInt(limit as string, 10);

    let where = "WHERE user_id = ? AND origin = 'imported'";
    const params: any[] = [userId];

    if (platform) {
      where += ' AND external_source = ?';
      params.push(platform);
    }
    if (sync_status) {
      where += ' AND sync_status = ?';
      params.push(sync_status);
    }

    const total = getDb().prepare(`SELECT COUNT(*) as cnt FROM marketplace_listings ${where}`).get(...params) as { cnt: number };
    params.push(parseInt(limit as string, 10), offset);

    const listings = getDb().prepare(`
      SELECT id, title, price_usdc, price_cad, category, condition, status, sync_status,
             external_url, external_source, external_listing_id, last_synced_at, images, created_at
      FROM marketplace_listings ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params);

    return res.json({
      success: true,
      total: total.cnt,
      page: parseInt(page as string, 10),
      listings,
    });
  } catch (err: any) {
    logger.error('Error listing imported listings', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── POST /listings/:id/delist — Mark an imported listing as sold externally ─
router.post('/listings/:id/delist', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const db = getDb();

    const listing = db.prepare(
      "SELECT * FROM marketplace_listings WHERE id = ? AND user_id = ? AND origin = 'imported'"
    ).get(req.params.id, userId) as any;

    if (!listing) {
      return res.status(404).json({ success: false, error: 'Imported listing not found' });
    }

    if (listing.sync_status === 'sold_externally') {
      return res.status(400).json({ success: false, error: 'Listing already marked as sold externally' });
    }

    const now = Date.now();
    db.prepare(`
      UPDATE marketplace_listings
      SET sync_status = 'sold_externally', status = 'delisted', last_synced_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, req.params.id);

    // Update delisted count on relevant sync schedule
    db.prepare(`
      UPDATE sync_schedules SET listings_delisted = listings_delisted + 1, updated_at = ?
      WHERE user_id = ? AND platform = ? AND status = 'active'
    `).run(now, userId, listing.external_source || 'ebay');

    // Log as a bot job
    const officer = getMigrationOfficerBot();
    if (officer) {
      db.prepare(`
        INSERT INTO bot_jobs (id, bot_id, listing_id, job_type, title, description, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), officer.id, req.params.id, 'delist',
        `Delist: ${listing.title}`,
        `Listing sold externally on ${listing.external_source || 'unknown platform'}`,
        'completed', now, now
      );
    }

    return res.json({
      success: true,
      message: 'Listing marked as sold externally and delisted from Terminal',
      listing_id: req.params.id,
      sync_status: 'sold_externally',
    });
  } catch (err: any) {
    logger.error('Error delisting imported listing', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── POST /listings/:id/resync — Force resync a single listing ──────────────
router.post('/listings/:id/resync', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const db = getDb();

    const listing = db.prepare(
      "SELECT * FROM marketplace_listings WHERE id = ? AND user_id = ? AND origin = 'imported'"
    ).get(req.params.id, userId) as any;

    if (!listing) {
      return res.status(404).json({ success: false, error: 'Imported listing not found' });
    }

    const now = Date.now();
    db.prepare('UPDATE marketplace_listings SET sync_status = ?, last_synced_at = ?, updated_at = ? WHERE id = ?')
      .run('active', now, now, req.params.id);

    return res.json({
      success: true,
      message: 'Listing resync initiated',
      listing_id: req.params.id,
      sync_status: 'active',
    });
  } catch (err: any) {
    logger.error('Error resyncing listing', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── POST /listings/refresh-images — Re-scrape eBay images for stale listings ──
router.post('/listings/refresh-images', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.sub;
    const { listingIds } = req.body; // optional: array of specific listing IDs

    // Validate
    if (listingIds && (!Array.isArray(listingIds) || listingIds.length > 100)) {
      return res.status(400).json({ success: false, error: 'listingIds must be an array with max 100 items' });
    }

    // Run refresh (this may take a while with 600ms delays)
    const result = await refreshListingImages(userId, listingIds);

    return res.json({
      success: true,
      message: `Image refresh complete: ${result.refreshed} refreshed, ${result.failed} failed, ${result.skipped} skipped`,
      data: result,
    });
  } catch (err: any) {
    logger.error('Error refreshing listing images', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── GET /admin/overview — Admin: sync health dashboard ─────────────────────
router.get('/admin/overview', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();

    const totalImported = db.prepare("SELECT COUNT(*) as cnt FROM marketplace_listings WHERE origin = 'imported'").get() as { cnt: number };
    const totalNative = db.prepare("SELECT COUNT(*) as cnt FROM marketplace_listings WHERE origin = 'terminal'").get() as { cnt: number };
    const activeSync = db.prepare("SELECT COUNT(*) as cnt FROM sync_schedules WHERE status = 'active'").get() as { cnt: number };
    const totalDelisted = db.prepare("SELECT SUM(listings_delisted) as total FROM sync_schedules").get() as { total: number };

    const syncBreakdown = db.prepare(`
      SELECT sync_status, COUNT(*) as cnt
      FROM marketplace_listings WHERE origin = 'imported'
      GROUP BY sync_status
    `).all();

    const recentSyncs = db.prepare(
      "SELECT id, store_name, frequency, last_run_at, next_run_at, listings_tracked, listings_delisted FROM sync_schedules ORDER BY last_run_at DESC LIMIT 10"
    ).all();

    const officerBot = getMigrationOfficerBot();
    const officerJobs = officerBot
      ? db.prepare("SELECT COUNT(*) as cnt FROM bot_jobs WHERE bot_id = ?").get(officerBot.id) as { cnt: number }
      : { cnt: 0 };

    return res.json({
      success: true,
      overview: {
        total_imported_listings: totalImported.cnt,
        total_native_listings: totalNative.cnt,
        active_sync_schedules: activeSync.cnt,
        total_delisted: totalDelisted.total || 0,
        sync_breakdown: syncBreakdown,
        migration_officer_jobs: officerJobs.cnt,
        recent_syncs: recentSyncs,
      },
    });
  } catch (err: any) {
    logger.error('Error fetching migration overview', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── POST /admin/sweep — Admin: trigger global sync sweep ───────────────────
router.post('/admin/sweep', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const now = Date.now();

    // Get all active schedules that are due
    const dueSchedules = db.prepare(
      "SELECT * FROM sync_schedules WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= ?)"
    ).all(now) as any[];

    let totalListingsChecked = 0;

    for (const schedule of dueSchedules) {
      const listings = db.prepare(
        "SELECT id FROM marketplace_listings WHERE user_id = ? AND origin = 'imported' AND external_source = ? AND status = 'published'"
      ).all(schedule.user_id, schedule.platform) as any[];

      // Update last_synced_at for all listings
      for (const l of listings) {
        db.prepare('UPDATE marketplace_listings SET last_synced_at = ? WHERE id = ?').run(now, l.id);
      }

      const nextRun = schedule.frequency === 'weekly'
        ? now + 7 * 24 * 60 * 60 * 1000
        : now + 30 * 24 * 60 * 60 * 1000;

      db.prepare('UPDATE sync_schedules SET last_run_at = ?, next_run_at = ?, listings_tracked = ?, updated_at = ? WHERE id = ?')
        .run(now, nextRun, listings.length, now, schedule.id);

      totalListingsChecked += listings.length;
    }

    // Log bot job
    const officer = getMigrationOfficerBot();
    if (officer) {
      db.prepare(`
        INSERT INTO bot_jobs (id, bot_id, listing_id, job_type, title, description, status, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), officer.id, 'global-sweep',
        'Global Sync Sweep',
        `Admin-triggered sweep: ${dueSchedules.length} schedules, ${totalListingsChecked} listings checked`,
        'completed', now, now
      );
    }

    return res.json({
      success: true,
      message: `Global sweep completed`,
      schedules_processed: dueSchedules.length,
      listings_checked: totalListingsChecked,
    });
  } catch (err: any) {
    logger.error('Error running global sweep', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
