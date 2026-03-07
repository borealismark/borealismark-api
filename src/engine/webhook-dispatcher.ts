import { createHmac } from 'crypto';
import { getWebhooksForEvent, recordWebhookDelivery, insertDeadLetter, updateWebhookDeliveryStatus } from '../db/database';
import { logger } from '../middleware/logger';

// ─── Event Type Registry ──────────────────────────────────────────────────────

/**
 * All possible event types that BorealisMark can emit.
 * Clients subscribe to one or more of these when registering a webhook.
 */
export const WEBHOOK_EVENTS = [
  'audit.completed',     // New certificate issued
  'audit.anchored',      // Certificate confirmed on Hedera HCS
  'score.degraded',      // Agent score dropped by ≥ 50 points
  'score.improved',      // Agent score improved by ≥ 50 points
  'stake.allocated',     // New BMT stake registered
  'slash.executed',      // Slashing event completed
  'agent.registered',    // New agent registered
  'key.revoked',         // API key was revoked
  'webhook.test',        // Test ping
] as const;

export type WebhookEvent = typeof WEBHOOK_EVENTS[number];

// ─── Payload Shape ────────────────────────────────────────────────────────────

export interface WebhookPayload {
  event: WebhookEvent;
  id: string;          // Unique delivery ID (idempotency key)
  timestamp: number;   // Epoch ms
  version: '1';
  data: Record<string, unknown>;
}

// ─── HMAC Signature ───────────────────────────────────────────────────────────

/**
 * Signs a payload with HMAC-SHA256 using the webhook's raw secret.
 *
 * The signature header format is: `sha256=<hex_digest>`
 * Clients should verify: HMAC(secret, rawBody) === signature header
 *
 * We sign the raw JSON string (not re-serialized) so the signature
 * is stable regardless of field ordering in the receiver's parser.
 */
function signPayload(rawBody: string, rawSecret: string): string {
  return 'sha256=' + createHmac('sha256', rawSecret).update(rawBody).digest('hex');
}

// ─── Single Delivery ──────────────────────────────────────────────────────────

const DELIVERY_TIMEOUT_MS = 10_000; // 10 seconds — firm ceiling per delivery
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 600_000, 3_600_000]; // 10s, 30s, 2min, 10min, 1hr

function getRetryDelay(attempt: number): number {
  const baseDelay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  // Add jitter: ±20% randomization to prevent thundering herd
  const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
  return Math.floor(baseDelay + jitter);
}

async function deliverToEndpoint(
  webhookId: string,
  url: string,
  rawSecret: string,
  payload: WebhookPayload,
): Promise<{ success: boolean; httpStatus?: number; error?: string }> {
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(rawBody, rawSecret);
  const startMs = Date.now();

  let httpStatus: number | undefined;
  let responseBody: string | undefined;
  let success = false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BorealisMark-Event': payload.event,
        'X-BorealisMark-Delivery': payload.id,
        'X-BorealisMark-Signature': signature,
        'User-Agent': 'BorealisMark-Webhooks/1.0',
      },
      body: rawBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    httpStatus = response.status;
    responseBody = await response.text().catch(() => '');
    success = response.ok;

    if (!success) {
      logger.warn(`Webhook delivery failed: HTTP ${httpStatus}`, {
        webhookId, event: payload.event, url, httpStatus,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('abort') || msg.includes('timeout');
    logger.warn(`Webhook delivery error: ${msg}`, {
      webhookId, event: payload.event, url, timeout: isTimeout,
    });
    responseBody = `delivery_error: ${msg}`;
  }

  recordWebhookDelivery(
    webhookId,
    payload.event,
    rawBody,
    success,
    httpStatus,
    responseBody?.slice(0, 1000), // cap stored response at 1KB
    Date.now() - startMs,
  );

  if (success) {
    return { success: true, httpStatus };
  } else {
    return {
      success: false,
      httpStatus,
      error: responseBody ?? 'Unknown error',
    };
  }
}

// ─── Retry Logic with Exponential Backoff ────────────────────────────────────

async function deliverWithRetry(
  webhookId: string,
  url: string,
  rawSecret: string,
  payload: WebhookPayload,
): Promise<void> {
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = getRetryDelay(attempt - 1);
      logger.info(`Webhook retry ${attempt}/${MAX_RETRY_ATTEMPTS} for ${payload.event} → ${url} (delay: ${Math.round(delay / 1000)}s)`, {
        webhookId, event: payload.event, attempt, delay,
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const result = await deliverToEndpoint(webhookId, url, rawSecret, payload);

    if (result.success) {
      if (attempt > 0) {
        logger.info(`Webhook delivery succeeded after ${attempt} retries`, {
          webhookId, event: payload.event, attempt,
        });
      }
      updateWebhookDeliveryStatus(webhookId, 'delivered');
      return;
    }

    lastError = result.error ?? `HTTP ${result.httpStatus}`;
  }

  // All retries exhausted — dead-letter it
  logger.error(`Webhook delivery permanently failed after ${MAX_RETRY_ATTEMPTS} retries → dead-lettered`, {
    webhookId, event: payload.event, lastError,
  });

  updateWebhookDeliveryStatus(webhookId, 'dead-lettered');
  insertDeadLetter(
    webhookId,
    payload.event,
    JSON.stringify(payload),
    lastError,
    MAX_RETRY_ATTEMPTS + 1,
  );
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * dispatch() — fire-and-forget webhook fan-out.
 *
 * Finds all active webhooks subscribed to the given event and delivers
 * the payload to each in parallel. Never throws — failures are logged
 * and persisted but don't affect the caller's response.
 *
 * Design decisions:
 * - Fire-and-forget: the HTTP response returns before deliveries complete.
 *   This is intentional — webhook consumers should be asynchronous.
 * - Parallel: all matching webhooks receive the event simultaneously.
 * - No retry on first attempt: retries require a job queue (future work).
 *   Clients should implement their own idempotency using payload.id.
 */
export function dispatch(event: WebhookEvent, data: Record<string, unknown>): void {
  const hooks = getWebhooksForEvent(event);
  if (hooks.length === 0) return;

  const payload: WebhookPayload = {
    event,
    id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: Date.now(),
    version: '1',
    data,
  };

  logger.info(`Dispatching webhook: ${event} → ${hooks.length} endpoint(s)`, {
    event,
    deliveryId: payload.id,
    targets: hooks.length,
  });

  // Fan out asynchronously — do not await
  Promise.allSettled(
    hooks.map(hook =>
      deliverWithRetry(hook.id, hook.url, hook.secret, payload),
    ),
  ).then(results => {
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    logger.info(`Webhook fan-out complete: ${event} ${succeeded}/${hooks.length} dispatched`, {
      event,
      deliveryId: payload.id,
    });
  });
}

// ─── Convenience Emitters ─────────────────────────────────────────────────────
// These are the canonical places to fire events — import and call from routes.

export const emit = {
  auditCompleted: (data: {
    certificateId: string;
    agentId: string;
    score: number;
    creditRating: string;
    hcsAnchored: boolean;
  }) => dispatch('audit.completed', data),

  auditAnchored: (data: {
    certificateId: string;
    agentId: string;
    hcsTransactionId: string;
    hcsSequenceNumber: number;
    hcsConsensusTimestamp: string;
  }) => dispatch('audit.anchored', data),

  scoreDegraded: (data: {
    agentId: string;
    previousScore: number;
    newScore: number;
    previousRating: string;
    newRating: string;
    delta: number;
  }) => dispatch('score.degraded', data),

  scoreImproved: (data: {
    agentId: string;
    previousScore: number;
    newScore: number;
    previousRating: string;
    newRating: string;
    delta: number;
  }) => dispatch('score.improved', data),

  stakeAllocated: (data: {
    agentId: string;
    stakeId: string;
    bmtAmount: number;
    usdcCoverage: number;
    tier: string;
  }) => dispatch('stake.allocated', data),

  slashExecuted: (data: {
    agentId: string;
    slashId: string;
    violationType: string;
    amountSlashed: number;
    claimantAddress: string;
    hcsTransactionId?: string;
  }) => dispatch('slash.executed', data),

  agentRegistered: (data: {
    agentId: string;
    name: string;
    version: string;
  }) => dispatch('agent.registered', data),

  webhookTest: (webhookId: string) => dispatch('webhook.test', {
    webhookId,
    message: 'BorealisMark webhook test — your endpoint is receiving events correctly.',
  }),
};
