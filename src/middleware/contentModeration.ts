/**
 * BorealisMark — Content Moderation Engine
 *
 * Three-layer content scanning system:
 *   Layer 1: Prohibited keyword database matching (this module)
 *   Layer 2: AI pre-screening (future — Claude API integration)
 *   Layer 3: Human audit queue (existing audit system)
 *
 * Scans listing titles, descriptions, and tags against the prohibited_items
 * database. Returns a moderation verdict: PASS, FLAG, or BLOCK.
 *
 * Tier-based listing privileges determine whether a listing skips audit:
 *   Standard  — Full audit required. Max 5 active listings.
 *   Pro       — Light audit (auto-pass if keyword scan clean). Max 25 listings.
 *   Elite     — Light audit. Max 100 listings. Featured badge.
 *   Platinum  — Instant listing (no audit unless flagged). Unlimited.
 *   Sovereign — Instant listing. Unlimited. Can create categories.
 *
 * EXCEPTION: Regardless of tier, any listing matching a 'block' or 'flag'
 * keyword ALWAYS goes through mandatory human audit. Nobody is above the rules.
 */

import { getDb, getActiveProhibitedItems, logModeration, getUserActiveListingCount } from '../db/database';
import { v4 as uuid } from 'uuid';
import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModerationResult {
  verdict: 'pass' | 'flag' | 'block';
  matchedKeywords: Array<{
    keyword: string;
    category: string;
    severity: 'block' | 'flag' | 'warn';
    foundIn: 'title' | 'description' | 'tags';
  }>;
  reason: string;
  requiresAudit: boolean;
}

export interface TierPrivileges {
  maxActiveListings: number;
  requiresAudit: boolean;       // true = must go through audit queue
  auditType: 'full' | 'light' | 'none';  // full = human, light = auto if clean, none = instant
  canCreateCategories: boolean;
  badge: string | null;
}

// ─── Tier Privilege Map ──────────────────────────────────────────────────────

const TIER_PRIVILEGES: Record<string, TierPrivileges> = {
  standard: {
    maxActiveListings: 5,
    requiresAudit: true,
    auditType: 'full',
    canCreateCategories: false,
    badge: null,
  },
  pro: {
    maxActiveListings: 25,
    requiresAudit: true,
    auditType: 'light',       // Auto-approved if keyword scan is clean
    canCreateCategories: false,
    badge: null,
  },
  elite: {
    maxActiveListings: 100,
    requiresAudit: true,
    auditType: 'light',
    canCreateCategories: false,
    badge: 'featured',
  },
  platinum: {
    maxActiveListings: -1,    // Unlimited
    requiresAudit: false,     // Instant listing unless flagged
    auditType: 'none',
    canCreateCategories: false,
    badge: 'trusted-seller',
  },
  sovereign: {
    maxActiveListings: -1,    // Unlimited
    requiresAudit: false,
    auditType: 'none',
    canCreateCategories: true,
    badge: 'sovereign',
  },
};

export function getTierPrivileges(tier: string): TierPrivileges {
  return TIER_PRIVILEGES[tier] ?? TIER_PRIVILEGES.standard;
}

// ─── Keyword Scanning ────────────────────────────────────────────────────────

/**
 * Scans text content against the prohibited items database.
 * Uses case-insensitive matching with word boundary awareness.
 */
export function scanContent(
  title: string,
  description: string,
  tags: string[],
): ModerationResult {
  const prohibitedItems = getActiveProhibitedItems();

  if (prohibitedItems.length === 0) {
    return {
      verdict: 'pass',
      matchedKeywords: [],
      reason: 'No prohibited items in database',
      requiresAudit: false,
    };
  }

  const matches: ModerationResult['matchedKeywords'] = [];
  const titleLower = title.toLowerCase();
  const descLower = description.toLowerCase();
  const tagsLower = tags.map(t => t.toLowerCase());
  const tagsJoined = tagsLower.join(' ');

  for (const item of prohibitedItems) {
    const keyword = item.keyword.toLowerCase();

    // Build a word-boundary-aware regex for multi-word and single-word keywords
    // Escape regex special characters in the keyword
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let regex: RegExp;
    try {
      // Allow common suffixes (s, es, ed, ing, er, ers) so "explosive" also catches "explosives"
      regex = new RegExp(`\\b${escaped}(?:s|es|ed|ing|er|ers)?\\b`, 'i');
    } catch {
      // Fallback to simple includes if regex fails
      regex = new RegExp(escaped, 'i');
    }

    if (regex.test(titleLower)) {
      matches.push({
        keyword: item.keyword,
        category: item.category,
        severity: item.severity,
        foundIn: 'title',
      });
    }

    if (regex.test(descLower)) {
      matches.push({
        keyword: item.keyword,
        category: item.category,
        severity: item.severity,
        foundIn: 'description',
      });
    }

    if (regex.test(tagsJoined)) {
      matches.push({
        keyword: item.keyword,
        category: item.category,
        severity: item.severity,
        foundIn: 'tags',
      });
    }
  }

  // Determine overall verdict
  if (matches.length === 0) {
    return {
      verdict: 'pass',
      matchedKeywords: [],
      reason: 'Content passed keyword scan',
      requiresAudit: false,
    };
  }

  const hasBlock = matches.some(m => m.severity === 'block');
  const hasFlag = matches.some(m => m.severity === 'flag');

  if (hasBlock) {
    return {
      verdict: 'block',
      matchedKeywords: matches,
      reason: `Content contains prohibited items: ${matches.filter(m => m.severity === 'block').map(m => m.keyword).join(', ')}`,
      requiresAudit: true,  // Blocked items always require human review
    };
  }

  if (hasFlag) {
    return {
      verdict: 'flag',
      matchedKeywords: matches,
      reason: `Content flagged for review: ${matches.filter(m => m.severity === 'flag').map(m => m.keyword).join(', ')}`,
      requiresAudit: true,
    };
  }

  // Only warnings — pass but note them
  return {
    verdict: 'pass',
    matchedKeywords: matches,
    reason: `Content passed with warnings: ${matches.map(m => m.keyword).join(', ')}`,
    requiresAudit: false,
  };
}

// ─── Full Moderation Check ───────────────────────────────────────────────────

/**
 * Combined moderation check: keyword scan + tier privilege evaluation.
 *
 * Returns the final decision on whether a listing should be:
 *   - auto_published (clean scan + high tier)
 *   - pending_audit (needs human review)
 *   - blocked (prohibited content detected)
 */
export function moderateListing(
  userId: string,
  userTier: string,
  title: string,
  description: string,
  tags: string[],
): {
  status: 'auto_published' | 'pending_audit' | 'blocked';
  scanResult: ModerationResult;
  tierPrivileges: TierPrivileges;
  listingLimitReached: boolean;
  reason: string;
} {
  const privileges = getTierPrivileges(userTier);
  const scanResult = scanContent(title, description, tags);

  // Check listing limits
  const activeCount = getUserActiveListingCount(userId);
  const limitReached = privileges.maxActiveListings !== -1
    && activeCount >= privileges.maxActiveListings;

  if (limitReached) {
    return {
      status: 'blocked',
      scanResult,
      tierPrivileges: privileges,
      listingLimitReached: true,
      reason: `You have reached your listing limit (${privileges.maxActiveListings} active listings for ${userTier} tier). Upgrade your tier or remove existing listings.`,
    };
  }

  // RULE: Blocked content is ALWAYS rejected regardless of tier
  if (scanResult.verdict === 'block') {
    // Log the moderation action
    logModeration(
      uuid(), null, userId, 'block', scanResult.reason,
      scanResult.matchedKeywords.map(m => m.keyword), 'block', true,
    );

    logger.warn('Listing blocked by content moderation', {
      userId,
      matchedKeywords: scanResult.matchedKeywords.map(m => m.keyword),
    });

    return {
      status: 'blocked',
      scanResult,
      tierPrivileges: privileges,
      listingLimitReached: false,
      reason: 'Your listing contains prohibited content and cannot be published. Please remove the flagged items and try again.',
    };
  }

  // RULE: Flagged content ALWAYS goes to human audit regardless of tier
  if (scanResult.verdict === 'flag') {
    logModeration(
      uuid(), null, userId, 'flag', scanResult.reason,
      scanResult.matchedKeywords.map(m => m.keyword), 'flag', true,
    );

    return {
      status: 'pending_audit',
      scanResult,
      tierPrivileges: privileges,
      listingLimitReached: false,
      reason: 'Your listing has been flagged for review due to potentially restricted content. An auditor will review it shortly.',
    };
  }

  // Content is clean — apply tier-based audit rules
  if (privileges.auditType === 'none') {
    // Platinum/Sovereign: instant publish for clean content
    return {
      status: 'auto_published',
      scanResult,
      tierPrivileges: privileges,
      listingLimitReached: false,
      reason: 'Listing auto-published (trusted seller privilege).',
    };
  }

  if (privileges.auditType === 'light') {
    // Pro/Elite: auto-approve clean content
    return {
      status: 'auto_published',
      scanResult,
      tierPrivileges: privileges,
      listingLimitReached: false,
      reason: 'Listing auto-published (clean scan + elevated tier).',
    };
  }

  // Standard: always requires full human audit
  return {
    status: 'pending_audit',
    scanResult,
    tierPrivileges: privileges,
    listingLimitReached: false,
    reason: 'Your listing has been submitted for review. It will be published once approved.',
  };
}

// ─── Admin: Get Moderation Stats ─────────────────────────────────────────────

export function getModerationStats(): {
  totalProhibitedItems: number;
  totalBlocks: number;
  totalFlags: number;
  recentActions: any[];
} {
  const db = getDb();

  const totalProhibitedItems = (
    db.prepare('SELECT COUNT(*) as c FROM prohibited_items WHERE active = 1').get() as { c: number }
  ).c;

  const totalBlocks = (
    db.prepare("SELECT COUNT(*) as c FROM moderation_logs WHERE action = 'block'").get() as { c: number }
  ).c;

  const totalFlags = (
    db.prepare("SELECT COUNT(*) as c FROM moderation_logs WHERE action = 'flag'").get() as { c: number }
  ).c;

  const recentActions = db.prepare(
    'SELECT * FROM moderation_logs ORDER BY created_at DESC LIMIT 20'
  ).all();

  return { totalProhibitedItems, totalBlocks, totalFlags, recentActions };
}
