/**
 * eBay Store Scraper Service
 *
 * Scrapes an eBay store page to find all listings, then scrapes each
 * listing page for images, price, condition, and shipping cost.
 * Creates marketplace_listings for each item.
 */

import https from 'https';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database';
import { logger } from '../middleware/logger';

const DELAY_MS = 600; // delay between eBay requests to be polite
const MAX_PAGES = 50; // max store pages to scrape (200 items/page = 10,000 max)

function fetchPage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 30000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchPage(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk: any) => data += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract all listing URLs from an eBay store page.
 * eBay store pages use pagination with _pgn parameter.
 */
export async function scrapeStoreListingUrls(storeUrl: string): Promise<string[]> {
  const allUrls: string[] = [];
  const seen = new Set<string>();

  // Normalize store URL — make sure it ends with the items path
  let baseUrl = storeUrl.replace(/\/+$/, '');
  if (!baseUrl.includes('/_i.html') && !baseUrl.includes('/i.html')) {
    // Try to load the main store page and find the items link
    // Common pattern: https://www.ebay.com/str/storename or https://www.ebay.ca/str/storename
  }

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = page === 1 ? baseUrl : `${baseUrl}?_pgn=${page}`;
    logger.info(`[eBay Scraper] Fetching store page ${page}: ${pageUrl}`);

    try {
      const html = await fetchPage(pageUrl);

      // Extract item URLs from the store page
      // Pattern: href="https://www.ebay.com/itm/..." or href="https://www.ebay.ca/itm/..."
      const itemPattern = /href="(https:\/\/www\.ebay\.(com|ca|co\.uk)\/itm\/[^"]+)"/g;
      let match;
      let newCount = 0;

      while ((match = itemPattern.exec(html)) !== null) {
        let itemUrl = match[1];
        // Clean up URL — remove query params after the item number
        const qIdx = itemUrl.indexOf('?');
        if (qIdx > -1) itemUrl = itemUrl.substring(0, qIdx);

        if (!seen.has(itemUrl)) {
          seen.add(itemUrl);
          allUrls.push(itemUrl);
          newCount++;
        }
      }

      logger.info(`[eBay Scraper] Page ${page}: found ${newCount} new items (total: ${allUrls.length})`);

      // If no new items found, we've reached the end
      if (newCount === 0) break;

      await sleep(DELAY_MS);
    } catch (err: any) {
      logger.error(`[eBay Scraper] Error fetching store page ${page}: ${err.message}`);
      break;
    }
  }

  return allUrls;
}

interface ScrapedListing {
  title: string;
  priceCad: number;
  condition: string;
  images: string[];
  shippingCostCad: number;
  description: string;
  ebayUrl: string;
}

/**
 * Scrape a single eBay listing page for details.
 */
export async function scrapeListingPage(itemUrl: string): Promise<ScrapedListing | null> {
  try {
    const html = await fetchPage(itemUrl);

    // Title: <title>...</title> or <h1 class="x-item-title__mainTitle">
    let title = '';
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].replace(/\s*\|\s*eBay$/, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    }

    // Try structured data for title
    const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (ogTitleMatch && ogTitleMatch[1].length > title.length) {
      title = ogTitleMatch[1].replace(/\s*\|\s*eBay$/, '').trim();
    }

    if (!title) return null;

    // Price: look for price in structured data
    let priceCad = 0;
    const priceMatch = html.match(/"price"\s*:\s*"?([\d.]+)"?/);
    if (priceMatch) {
      priceCad = parseFloat(priceMatch[1]);
    }
    // Also try the priceCurrency to adjust
    const currMatch = html.match(/"priceCurrency"\s*:\s*"(\w+)"/);
    const currency = currMatch ? currMatch[1] : 'CAD';
    if (currency === 'USD') {
      priceCad = Math.round(priceCad * 1.37 * 100) / 100; // approximate conversion
    }

    // Condition
    let condition = 'Used';
    const condMatch = html.match(/"conditionDisplayName"\s*:\s*"([^"]+)"/);
    if (condMatch) {
      condition = condMatch[1];
    } else {
      const condMatch2 = html.match(/itemprop="itemCondition"[^>]*content="([^"]+)"/i);
      if (condMatch2) {
        const cond = condMatch2[1].toLowerCase();
        if (cond.includes('new')) condition = 'New';
        else if (cond.includes('refurbished')) condition = 'Refurbished';
      }
    }

    // Images — high-res s-l1600.jpg
    const imagePattern = /https:\/\/i\.ebayimg\.com\/images\/g\/[A-Za-z0-9_~-]+\/s-l1600\.jpg/g;
    const imageSet = new Set<string>();
    let imgMatch;
    while ((imgMatch = imagePattern.exec(html)) !== null) {
      imageSet.add(imgMatch[0]);
    }
    const images = Array.from(imageSet);

    // Shipping cost
    let shippingCostCad = 0;
    const shipMatch = html.match(/"shippingCost"\s*:\s*\{[^}]*"amount"\s*:\s*(\d+\.?\d*)/);
    if (shipMatch) {
      shippingCostCad = parseFloat(shipMatch[1]);
    }

    // Description — use og:description or meta description
    let description = '';
    const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (descMatch) {
      description = descMatch[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    }
    if (!description) {
      description = title;
    }

    return {
      title,
      priceCad,
      condition,
      images,
      shippingCostCad,
      description,
      ebayUrl: itemUrl,
    };
  } catch (err: any) {
    logger.error(`[eBay Scraper] Failed to scrape ${itemUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Full import flow: scrape store, create storefront, import all listings.
 */
export async function importEbayStore(
  importId: string,
  userId: string,
  storeUrl: string,
  storeName: string
): Promise<void> {
  const db = getDb();

  try {
    // Update status to scraping
    db.prepare('UPDATE ebay_store_imports SET status = ? WHERE id = ?').run('scraping', importId);

    // Step 1: Scrape store for all item URLs
    logger.info(`[eBay Import ${importId}] Starting store scrape: ${storeUrl}`);
    const itemUrls = await scrapeStoreListingUrls(storeUrl);

    if (itemUrls.length === 0) {
      db.prepare('UPDATE ebay_store_imports SET status = ?, error_message = ? WHERE id = ?')
        .run('failed', 'No listings found on store page. Please check the store URL.', importId);
      return;
    }

    db.prepare('UPDATE ebay_store_imports SET listings_found = ?, status = ? WHERE id = ?')
      .run(itemUrls.length, 'importing', importId);

    // Step 2: Ensure user has a storefront
    let storefront = db.prepare('SELECT id, slug FROM seller_storefronts WHERE user_id = ?').get(userId) as any;
    if (!storefront) {
      // Create storefront from store name
      const slug = storeName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .substring(0, 30) || 'store-' + userId.substring(0, 8);

      const sfId = uuid();
      db.prepare(`
        INSERT INTO seller_storefronts (id, user_id, slug, name, description, banner_url, logo_url, created_at)
        VALUES (?, ?, ?, ?, ?, '', '', datetime('now'))
      `).run(sfId, userId, slug, storeName, `${storeName} — imported from eBay`);

      storefront = { id: sfId, slug };
      logger.info(`[eBay Import ${importId}] Created storefront: ${slug}`);
    }

    // Step 3: Import each listing
    let imported = 0;
    let failed = 0;

    for (let i = 0; i < itemUrls.length; i++) {
      try {
        const listing = await scrapeListingPage(itemUrls[i]);

        if (!listing || !listing.title) {
          failed++;
          db.prepare('UPDATE ebay_store_imports SET listings_failed = ? WHERE id = ?').run(failed, importId);
          continue;
        }

        // Check for duplicate by eBay URL
        const existing = db.prepare(
          "SELECT id FROM marketplace_listings WHERE external_url = ? AND user_id = ?"
        ).get(listing.ebayUrl, userId) as any;

        if (existing) {
          // Skip duplicate
          logger.info(`[eBay Import ${importId}] Skipping duplicate: ${listing.title.substring(0, 50)}`);
          imported++; // count as success since it already exists
          db.prepare('UPDATE ebay_store_imports SET listings_imported = ? WHERE id = ?').run(imported, importId);
          continue;
        }

        const listingId = uuid();
        const imagesJson = JSON.stringify(listing.images);

        // Calculate USDC price from CAD
        const priceUsdc = Math.round(listing.priceCad / 1.37 * 100) / 100;

        const now = Date.now();
        db.prepare(`
          INSERT INTO marketplace_listings
          (id, user_id, title, description, listing_type, category, condition, price_usdc, price_cad,
           shipping_cost_cad, images, status, external_url, external_source, platform, created_at, updated_at, published_at)
          VALUES (?, ?, ?, ?, 'sell', 'general', ?, ?, ?, ?, ?, 'published', ?, 'ebay', 'ebay', ?, ?, ?)
        `).run(
          listingId, userId,
          listing.title, listing.description,
          listing.condition, priceUsdc, listing.priceCad,
          listing.shippingCostCad, imagesJson,
          listing.ebayUrl, now, now, now
        );

        imported++;
        db.prepare('UPDATE ebay_store_imports SET listings_imported = ? WHERE id = ?').run(imported, importId);

        if ((i + 1) % 25 === 0) {
          logger.info(`[eBay Import ${importId}] Progress: ${i + 1}/${itemUrls.length} (imported: ${imported}, failed: ${failed})`);
        }
      } catch (err: any) {
        failed++;
        db.prepare('UPDATE ebay_store_imports SET listings_failed = ? WHERE id = ?').run(failed, importId);
        logger.error(`[eBay Import ${importId}] Failed item ${i + 1}: ${err.message}`);
      }

      // Rate limit
      await sleep(DELAY_MS);
    }

    // Step 4: Mark complete
    db.prepare(
      'UPDATE ebay_store_imports SET status = ?, listings_imported = ?, listings_failed = ?, completed_at = datetime(\'now\') WHERE id = ?'
    ).run('complete', imported, failed, importId);

    logger.info(`[eBay Import ${importId}] Complete: ${imported} imported, ${failed} failed out of ${itemUrls.length}`);

  } catch (err: any) {
    logger.error(`[eBay Import ${importId}] Fatal error: ${err.message}`);
    db.prepare('UPDATE ebay_store_imports SET status = ?, error_message = ? WHERE id = ?')
      .run('failed', err.message, importId);
  }
}
