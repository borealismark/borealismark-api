/**
 * Borealis Agent Worker Service
 *
 * Autonomous background worker that picks up listings and performs
 * marketing tasks: generates campaigns with tracking links for each
 * platform, updates task status in real-time so the frontend can
 * show live agent activity badges on listing cards.
 *
 * Task lifecycle:
 *   queued → picked_up → generating → posting → completed (or failed)
 *
 * The agent uses the existing marketing_campaigns + referral_clicks
 * infrastructure so all clicks/conversions are properly tracked.
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database';
import { logger } from '../middleware/logger';

const AGENT_NAMES = [
  'Aurora',      // Northern lights themed
  'Polaris',     // North star
  'Zenith',      // Peak
  'Vega',        // Star
  'Cascade',     // Flow
];

// Pick a deterministic agent name from listing ID
function agentNameFor(listingId: string): string {
  let hash = 0;
  for (let i = 0; i < listingId.length; i++) {
    hash = ((hash << 5) - hash) + listingId.charCodeAt(i);
    hash |= 0;
  }
  return AGENT_NAMES[Math.abs(hash) % AGENT_NAMES.length];
}

const PLATFORMS = ['x', 'instagram', 'general'] as const;

/**
 * Queue marketing tasks for a listing across all platforms.
 * Called when a listing is published or when a seller requests AI promotion.
 */
export function queueMarketingTasks(listingId: string, userId: string): string[] {
  const db = getDb();
  const taskIds: string[] = [];
  const agentName = agentNameFor(listingId);

  for (const platform of PLATFORMS) {
    // Check if there's already an active task for this listing+platform
    const existing = db.prepare(
      "SELECT id FROM agent_tasks WHERE listing_id = ? AND platform = ? AND status NOT IN ('completed', 'failed')"
    ).get(listingId, platform) as any;

    if (existing) {
      taskIds.push(existing.id);
      continue;
    }

    // Also skip if a campaign already exists for this listing+platform
    const existingCampaign = db.prepare(
      "SELECT id FROM marketing_campaigns WHERE listing_id = ? AND platform = ? AND user_id = ?"
    ).get(listingId, platform, userId) as any;

    if (existingCampaign) {
      continue; // Already has a campaign, no need to queue
    }

    const taskId = uuid();
    db.prepare(`
      INSERT INTO agent_tasks (id, listing_id, user_id, agent_name, task_type, platform, status, status_message)
      VALUES (?, ?, ?, ?, 'marketing', ?, 'queued', ?)
    `).run(
      taskId, listingId, userId, agentName,
      platform,
      `Queued for ${platform === 'x' ? 'X/Twitter' : platform === 'instagram' ? 'Instagram' : 'Facebook/General'} promotion`
    );
    taskIds.push(taskId);
  }

  return taskIds;
}

/**
 * Process a single agent task — generates a marketing campaign
 * with tracking links and updates status throughout.
 */
export async function processAgentTask(taskId: string): Promise<void> {
  const db = getDb();

  const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId) as any;
  if (!task) return;

  const agentName = task.agent_name;

  try {
    // Mark as picked up
    db.prepare(
      "UPDATE agent_tasks SET status = 'picked_up', status_message = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(`${agentName} is analyzing listing...`, taskId);

    // Small delay to simulate agent processing (also prevents hammering)
    await sleep(800);

    // Get listing details
    const listing = db.prepare(
      'SELECT id, title, description, price_cad, images, category, condition FROM marketplace_listings WHERE id = ?'
    ).get(task.listing_id) as any;

    if (!listing) {
      db.prepare(
        "UPDATE agent_tasks SET status = 'failed', status_message = 'Listing not found', updated_at = datetime('now'), completed_at = datetime('now') WHERE id = ?"
      ).run(taskId);
      return;
    }

    // Mark as generating
    const platformLabel = task.platform === 'x' ? 'X/Twitter' : task.platform === 'instagram' ? 'Instagram' : 'Facebook/General';
    db.prepare(
      "UPDATE agent_tasks SET status = 'generating', status_message = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(`${agentName} is crafting ${platformLabel} campaign copy...`, taskId);

    await sleep(600);

    // Generate tracking code and campaign copy
    const trackingCode = uuid().replace(/-/g, '').substring(0, 8);
    const trackingUrl = `https://borealismark-api.onrender.com/v1/marketplace/r/${trackingCode}`;

    const price = listing.price_cad ? `$${listing.price_cad.toFixed(2)} CAD` : 'Contact for price';
    const title = listing.title || 'Great product';
    const desc = listing.description || title;
    const condition = listing.condition || '';
    let images: string[] = [];
    try { images = JSON.parse(listing.images || '[]'); } catch (e) { images = []; }

    let campaignCopy = '';
    let hashtags: string[] = [];

    if (task.platform === 'x') {
      hashtags = ['#BorealisTerminal', '#TrustGated'];
      if (listing.category) hashtags.push('#' + listing.category.replace(/-/g, ''));
      const hashStr = hashtags.join(' ');
      const maxTitleLen = 280 - price.length - hashStr.length - trackingUrl.length - 10;
      const shortTitle = title.length > maxTitleLen ? title.substring(0, maxTitleLen - 3) + '...' : title;
      campaignCopy = `${shortTitle}\n${price}\n\n${hashStr}\n${trackingUrl}`;
    } else if (task.platform === 'instagram') {
      hashtags = ['#BorealisTerminal', '#TrustGated', '#OnlineShopping', '#VerifiedSeller'];
      if (listing.category) hashtags.push('#' + listing.category.replace(/-/g, ''));
      if (condition) hashtags.push('#' + condition.replace(/\s+/g, ''));
      campaignCopy = `${title}\n\n${desc.substring(0, 300)}\n\n${price}\n\nShop securely on Borealis Terminal.\nLink in bio\n\n${hashtags.join(' ')}`;
    } else {
      hashtags = ['#BorealisTerminal', '#TrustGated'];
      campaignCopy = `${title}\n\n${desc.substring(0, 500)}\n\nPrice: ${price}${condition ? ' | Condition: ' + condition : ''}\n\nShop with confidence on Borealis Terminal:\n${trackingUrl}\n\n${hashtags.join(' ')}`;
    }

    // Mark as posting (creating the campaign record)
    db.prepare(
      "UPDATE agent_tasks SET status = 'posting', status_message = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(`${agentName} is deploying ${platformLabel} campaign with tracking link...`, taskId);

    await sleep(500);

    // Create the actual marketing campaign
    const campaignId = uuid();
    db.prepare(`
      INSERT INTO marketing_campaigns (id, listing_id, user_id, platform, status, campaign_copy, hashtags, image_urls, tracking_code, tracking_url)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      campaignId, task.listing_id, task.user_id, task.platform,
      campaignCopy, JSON.stringify(hashtags), JSON.stringify(images.slice(0, 4)),
      trackingCode, trackingUrl
    );

    // Mark task completed
    db.prepare(`
      UPDATE agent_tasks SET
        status = 'completed',
        status_message = ?,
        campaign_id = ?,
        tracking_code = ?,
        result_data = ?,
        updated_at = datetime('now'),
        completed_at = datetime('now')
      WHERE id = ?
    `).run(
      `${agentName} deployed ${platformLabel} campaign — tracking via ${trackingCode}`,
      campaignId, trackingCode,
      JSON.stringify({ campaignId, trackingCode, trackingUrl, platform: task.platform }),
      taskId
    );

    logger.info(`[Agent ${agentName}] Completed ${task.platform} campaign for listing ${task.listing_id} → ${trackingCode}`);

  } catch (err: any) {
    logger.error(`[Agent ${agentName}] Task ${taskId} failed: ${err.message}`);
    db.prepare(
      "UPDATE agent_tasks SET status = 'failed', status_message = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE id = ?"
    ).run(`${agentName} encountered an error: ${err.message}`, taskId);
  }
}

/**
 * Process all queued agent tasks. Called periodically or on-demand.
 */
export async function processQueuedTasks(): Promise<number> {
  const db = getDb();
  const queuedTasks = db.prepare(
    "SELECT id FROM agent_tasks WHERE status = 'queued' ORDER BY started_at ASC LIMIT 10"
  ).all() as any[];

  let processed = 0;
  for (const task of queuedTasks) {
    await processAgentTask(task.id);
    processed++;
  }
  return processed;
}

/**
 * Get active agent tasks for a listing (for frontend badges).
 */
export function getListingAgentStatus(listingId: string): any[] {
  const db = getDb();
  return db.prepare(
    "SELECT id, agent_name, task_type, platform, status, status_message, tracking_code, updated_at FROM agent_tasks WHERE listing_id = ? ORDER BY updated_at DESC"
  ).all(listingId) as any[];
}

/**
 * Get active agent tasks across all listings for a user.
 */
export function getUserAgentTasks(userId: string): any[] {
  const db = getDb();
  return db.prepare(`
    SELECT at.*, ml.title as listing_title
    FROM agent_tasks at
    LEFT JOIN marketplace_listings ml ON at.listing_id = ml.id
    WHERE at.user_id = ?
    ORDER BY at.updated_at DESC
    LIMIT 50
  `).all(userId) as any[];
}

/**
 * Get summary counts for agent activity (for dashboard widgets).
 */
export function getAgentSummary(userId: string): { active: number; completed: number; totalCampaigns: number; totalClicks: number } {
  const db = getDb();

  const active = (db.prepare(
    "SELECT COUNT(*) as cnt FROM agent_tasks WHERE user_id = ? AND status NOT IN ('completed', 'failed')"
  ).get(userId) as any).cnt;

  const completed = (db.prepare(
    "SELECT COUNT(*) as cnt FROM agent_tasks WHERE user_id = ? AND status = 'completed'"
  ).get(userId) as any).cnt;

  const totalCampaigns = (db.prepare(
    "SELECT COUNT(*) as cnt FROM marketing_campaigns WHERE user_id = ?"
  ).get(userId) as any).cnt;

  const totalClicks = (db.prepare(
    "SELECT COUNT(*) as cnt FROM referral_clicks rc JOIN marketing_campaigns mc ON rc.campaign_id = mc.id WHERE mc.user_id = ?"
  ).get(userId) as any).cnt;

  return { active, completed, totalCampaigns, totalClicks };
}

/**
 * Log an AI agent activity to the agent_tasks table.
 * Called by any service (import, marketing, sync, etc.) to record what the agent did.
 * Returns the activity log ID.
 */
export function logListingActivity(params: {
  listingId: string;
  userId: string;
  agentName: string;
  taskType: string;  // 'migration_import' | 'migration_sync' | 'marketing' | 'price_update' | etc.
  platform?: string;
  status: string;
  statusMessage: string;
  metadata?: Record<string, any>;
}): string {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_tasks (id, listing_id, user_id, agent_name, task_type, platform, status, status_message, result_data, started_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, params.listingId, params.userId, params.agentName,
    params.taskType, params.platform || null,
    params.status, params.statusMessage,
    JSON.stringify(params.metadata || {}),
    now, now,
    params.status === 'completed' ? now : null
  );

  return id;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
