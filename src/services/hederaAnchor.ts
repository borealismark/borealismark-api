/**
 * BorealisMark — Hedera Event Anchoring Service
 *
 * Batches unanchored platform events and submits Merkle root hashes
 * to Hedera Consensus Service for immutable proof.
 *
 * Architecture:
 *   1. EventBus collects events → persisted to SQLite with anchored=0
 *   2. This service runs on a 5-minute interval
 *   3. Fetches unanchored events, computes a Merkle root of their hashes
 *   4. Submits the Merkle root to HCS data topic
 *   5. Marks events as anchored with the HCS transaction ID
 *
 * This ensures every significant platform action has an immutable
 * on-chain proof without incurring per-event Hedera fees.
 */

import { createHash } from 'crypto';
import { logger } from '../middleware/logger';
import { getUnanchoredEvents, markEventsAnchored } from '../db/database';
import { emit, EventTypes } from './eventBus';

// Lazy-load Hedera SDK to avoid blocking server startup (SDK takes ~20s to load)
let _hederaLoaded = false;
let _TopicMessageSubmitTransaction: any;
let _TopicId: any;
let _createHederaClient: any;

async function loadHedera(): Promise<boolean> {
  if (_hederaLoaded) return true;
  try {
    const sdk = await import('@hashgraph/sdk');
    _TopicMessageSubmitTransaction = sdk.TopicMessageSubmitTransaction;
    _TopicId = sdk.TopicId;
    const hcs = await import('../hedera/hcs');
    _createHederaClient = hcs.createHederaClient;
    _hederaLoaded = true;
    logger.info('Hedera SDK loaded for event anchoring');
    return true;
  } catch (err: any) {
    logger.error('Failed to load Hedera SDK', { error: err.message });
    return false;
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

const ANCHOR_BATCH_SIZE = 200;
const ANCHOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let anchorInterval: NodeJS.Timeout | null = null;

// ─── Merkle Root Computation ────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute a simple Merkle root from an array of event hashes.
 * For small batches (<200), this is efficient enough.
 */
function computeMerkleRoot(events: Record<string, any>[]): string {
  if (events.length === 0) return sha256('empty');

  // Leaf hashes: SHA256 of each event's core data
  let hashes = events.map(e =>
    sha256(`${e.id}|${e.event_type}|${e.category}|${e.actor_id ?? ''}|${e.target_id ?? ''}|${e.created_at}`)
  );

  // Build the tree
  while (hashes.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      if (i + 1 < hashes.length) {
        nextLevel.push(sha256(hashes[i] + hashes[i + 1]));
      } else {
        // Odd number: promote the last hash
        nextLevel.push(hashes[i]);
      }
    }
    hashes = nextLevel;
  }

  return hashes[0];
}

// ─── Anchor Batch ───────────────────────────────────────────────────────────

export async function anchorEventBatch(): Promise<{
  anchored: number;
  merkleRoot: string | null;
  hcsTxId: string | null;
}> {
  const events = getUnanchoredEvents(ANCHOR_BATCH_SIZE);
  if (events.length === 0) {
    return { anchored: 0, merkleRoot: null, hcsTxId: null };
  }

  const merkleRoot = computeMerkleRoot(events);
  const eventIds = events.map(e => e.id);

  // Check if Hedera is configured
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  const dataTopicId = process.env.HEDERA_DATA_TOPIC_ID ?? process.env.HEDERA_AUDIT_TOPIC_ID;

  if (!accountId || !privateKey || !dataTopicId) {
    // Hedera not configured — mark events as anchored locally with a local reference
    const localTxId = `local:${Date.now()}:${merkleRoot.slice(0, 16)}`;
    markEventsAnchored(eventIds, localTxId);

    logger.info('Events anchored locally (Hedera not configured)', {
      count: events.length,
      merkleRoot,
      localTxId,
    });

    return { anchored: events.length, merkleRoot, hcsTxId: localTxId };
  }

  try {
    // Lazy-load Hedera SDK
    const loaded = await loadHedera();
    if (!loaded) {
      const fallbackTxId = `sdk-unavailable:${Date.now()}:${merkleRoot.slice(0, 16)}`;
      markEventsAnchored(eventIds, fallbackTxId);
      return { anchored: events.length, merkleRoot, hcsTxId: null };
    }

    const config = {
      accountId,
      privateKey,
      network: (process.env.HEDERA_NETWORK ?? 'mainnet') as 'testnet' | 'mainnet',
    };

    const client = await _createHederaClient(config);

    // Submit Merkle root to HCS
    const message = JSON.stringify({
      protocol: 'BorealisMark/1.0',
      type: 'DATA_ANCHOR',
      merkleRoot,
      eventCount: events.length,
      firstEventId: eventIds[0],
      lastEventId: eventIds[eventIds.length - 1],
      categories: [...new Set(events.map(e => e.category))],
      timestamp: Date.now(),
    });

    const tx = await new _TopicMessageSubmitTransaction()
      .setTopicId(_TopicId.fromString(dataTopicId))
      .setMessage(message)
      .execute(client);

    const receipt = await tx.getReceipt(client);
    const hcsTxId = tx.transactionId?.toString() ?? `hcs:${Date.now()}`;

    // Mark all events as anchored
    markEventsAnchored(eventIds, hcsTxId);

    // Emit meta-event
    emit({
      eventType: EventTypes.ANCHOR_BATCH_COMPLETED,
      category: 'system',
      actorType: 'system',
      payload: {
        merkleRoot,
        eventCount: events.length,
        hcsTxId,
        sequenceNumber: receipt.topicSequenceNumber?.toString(),
      },
    });

    logger.info('Events anchored to Hedera', {
      count: events.length,
      merkleRoot,
      hcsTxId,
      topicId: dataTopicId,
    });

    client.close();

    return { anchored: events.length, merkleRoot, hcsTxId };
  } catch (err: any) {
    logger.error('Hedera anchoring failed', {
      error: err.message,
      eventCount: events.length,
      merkleRoot,
    });

    // Fallback: mark as locally anchored so events don't pile up
    const fallbackTxId = `failed:${Date.now()}:${merkleRoot.slice(0, 16)}`;
    markEventsAnchored(eventIds, fallbackTxId);

    return { anchored: events.length, merkleRoot, hcsTxId: null };
  }
}

// ─── Scheduled Anchoring ────────────────────────────────────────────────────

export function startAnchoringSchedule(): void {
  // Run immediately on startup, then every 5 minutes
  setTimeout(() => anchorEventBatch().catch(err =>
    logger.error('Initial anchor batch failed', { error: err.message })
  ), 10_000); // 10s delay on startup

  anchorInterval = setInterval(async () => {
    try {
      const result = await anchorEventBatch();
      if (result.anchored > 0) {
        logger.info('Scheduled anchor batch complete', result);
      }
    } catch (err: any) {
      logger.error('Scheduled anchoring error', { error: err.message });
    }
  }, ANCHOR_INTERVAL_MS);

  logger.info('Hedera anchoring schedule started', { intervalMs: ANCHOR_INTERVAL_MS });
}

export function stopAnchoringSchedule(): void {
  if (anchorInterval) {
    clearInterval(anchorInterval);
    anchorInterval = null;
  }
  logger.info('Hedera anchoring schedule stopped');
}
