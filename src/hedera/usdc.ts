/**
 * BorealisMark — Hedera USDC Payment Module
 *
 * Handles USDC stablecoin payments on Hedera for agent plans and API tiers.
 * USDC on Hedera (HTS token 0.0.456858) has 6 decimal places.
 *
 * Flow:
 *   1. Client requests a payment invoice → gets a unique memo + treasury address
 *   2. Client sends USDC to the treasury with the memo
 *   3. Backend polls Hedera Mirror Node to verify the transfer
 *   4. On confirmation → activate subscription, anchor receipt on HCS
 *
 * Advantages over card payments:
 *   - Near-zero fees (~$0.001 per tx vs 3.4% Stripe)
 *   - Instant settlement (3-5 second consensus)
 *   - Native to the BorealisMark blockchain ecosystem
 *   - No chargebacks
 */

import { v4 as uuid } from 'uuid';
import { createHederaClient, type HCSConfig } from './hcs';
import { logger } from '../middleware/logger';
import {
  saveUsdcInvoice,
  getUsdcInvoice,
  updateUsdcInvoiceStatus,
  confirmUsdcInvoice as dbConfirmInvoice,
  cleanupExpiredUsdcInvoices,
  type UsdcInvoiceRecord,
} from '../db/database';

// ─── USDC Token Configuration ────────────────────────────────────────────────

// USDC on Hedera (issued by Circle)
// Testnet: use a test HTS token that mimics USDC
// Mainnet: 0.0.456858 (official USDC on Hedera)
export const USDC_TOKEN_ID = process.env.HEDERA_USDC_TOKEN_ID ?? '0.0.456858';
export const USDC_DECIMALS = 6;

// Treasury account that receives payments
// Falls back to the operator account; crashes clearly if neither is set
export const TREASURY_ACCOUNT_ID: string = (() => {
  const id = process.env.HEDERA_TREASURY_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID;
  if (!id || id === '0.0.0') {
    // Don't fail at import time — the module is loaded even when USDC is unused.
    // verifyUsdcPayment() and createUsdcInvoice() will check at call time.
    return '';
  }
  return id;
})();

// Mirror node base URL
const MIRROR_NODE_BASE = process.env.HEDERA_MIRROR_NODE_URL ?? (() => {
  const network = process.env.HEDERA_NETWORK;
  if (network === 'mainnet') return 'https://mainnet.mirrornode.hedera.com';
  if (network === 'testnet') return 'https://testnet.mirrornode.hedera.com';
  throw new Error(`HEDERA_NETWORK must be 'testnet' or 'mainnet', got: ${network}`);
})();

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PaymentInvoice {
  invoiceId: string;
  planId: string;
  amountUsd: number;
  amountUsdc: string;       // USDC amount as string (6 decimals)
  treasuryAccountId: string;
  tokenId: string;
  memo: string;             // unique memo for this payment
  expiresAt: number;        // unix timestamp — invoice expires in 30 min
  createdAt: number;
  status: 'pending' | 'confirmed' | 'expired' | 'failed';
}

export interface PaymentConfirmation {
  invoiceId: string;
  transactionId: string;
  consensusTimestamp: string;
  fromAccount: string;
  amount: string;
  status: 'confirmed';
}

export interface MirrorNodeTransaction {
  transaction_id: string;
  consensus_timestamp: string;
  transfers: Array<{
    account: string;
    amount: number;
    token_id?: string;
  }>;
  memo_base64?: string;
  result: string;
}

// ─── Database-Backed Invoice Store ──────────────────────────────────────────

// ─── Invoice Creation ────────────────────────────────────────────────────────

/**
 * Create a USDC payment invoice.
 * The client must send exactly the specified USDC amount to the treasury
 * account with the provided memo within the expiry window.
 * Invoices are persisted to SQLite — survives server restarts.
 */
export function createUsdcInvoice(
  planId: string,
  amountUsd: number,
  email?: string,
  agentId?: string,
): PaymentInvoice {
  if (!TREASURY_ACCOUNT_ID) {
    throw new Error(
      'HEDERA_TREASURY_ACCOUNT_ID (or HEDERA_ACCOUNT_ID) must be set for USDC payments',
    );
  }

  const invoiceId = `inv_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const memo = `BM:${invoiceId}`;

  // USDC is 1:1 with USD, 6 decimal places
  const amountUsdc = amountUsd.toFixed(USDC_DECIMALS);
  const expiresAt = Date.now() + 30 * 60 * 1000; // 30 minutes

  const invoice: PaymentInvoice = {
    invoiceId,
    planId,
    amountUsd,
    amountUsdc,
    treasuryAccountId: TREASURY_ACCOUNT_ID,
    tokenId: USDC_TOKEN_ID,
    memo,
    expiresAt,
    createdAt: Date.now(),
    status: 'pending',
  };

  // Persist to database
  saveUsdcInvoice({
    invoiceId,
    planId,
    email,
    agentId,
    amountUsd,
    amountUsdc,
    treasuryAccountId: TREASURY_ACCOUNT_ID,
    tokenId: USDC_TOKEN_ID,
    memo,
    expiresAt,
  });

  logger.info('USDC invoice created (persistent)', {
    invoiceId,
    planId,
    amountUsd,
    amountUsdc,
    email,
    agentId,
  });

  return invoice;
}

// ─── Invoice Lookup ──────────────────────────────────────────────────────────

/**
 * Retrieve an invoice from the database.
 * Returns in the PaymentInvoice shape for backward compatibility.
 */
export function getInvoice(invoiceId: string): PaymentInvoice | undefined {
  const row = getUsdcInvoice(invoiceId);
  if (!row) return undefined;
  return {
    invoiceId: row.invoiceId,
    planId: row.planId,
    amountUsd: row.amountUsd,
    amountUsdc: row.amountUsdc,
    treasuryAccountId: row.treasuryAccountId,
    tokenId: row.tokenId,
    memo: row.memo,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    status: row.status,
  };
}

export function updateInvoiceStatus(
  invoiceId: string,
  status: PaymentInvoice['status'],
): void {
  updateUsdcInvoiceStatus(invoiceId, status);
}

// ─── Mirror Node Verification ────────────────────────────────────────────────

/**
 * Query Hedera Mirror Node for token transfers to the treasury matching
 * the invoice memo and amount.
 *
 * Mirror Node REST API:
 *   GET /api/v1/transactions?account.id={treasury}&transactiontype=CRYPTOTRANSFER&timestamp=gte:{since}
 *
 * We look for a HTS token transfer of USDC to the treasury with the
 * matching memo. Includes exponential backoff retry and indexing lag handling.
 *
 * Config:
 *   - Timeout window: 60 minutes (configurable via timeout parameter)
 *   - Retry with exponential backoff on Mirror Node API failures
 *   - Detects indexing lag: retries if no results in first 10 seconds
 */
export async function verifyUsdcPayment(
  invoiceId: string,
  timeoutWindowMs: number = 60 * 60 * 1000, // 60 minutes default
): Promise<PaymentConfirmation | null> {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    logger.warn('Invoice not found for verification', { invoiceId });
    return null;
  }

  if (invoice.status === 'confirmed') {
    logger.info('Invoice already confirmed', { invoiceId });
    return null; // already confirmed
  }

  if (Date.now() > invoice.expiresAt) {
    updateInvoiceStatus(invoiceId, 'expired');
    logger.info('Invoice expired', { invoiceId });
    return null;
  }

  // Calculate time window accounting for Mirror Node indexing lag
  // Only check transactions within the timeout window from invoice creation
  const sinceTimestamp = (invoice.createdAt / 1000).toFixed(9);
  const untilTimestamp = ((invoice.createdAt + timeoutWindowMs) / 1000).toFixed(9);

  const url = `${MIRROR_NODE_BASE}/api/v1/transactions`
    + `?account.id=${invoice.treasuryAccountId}`
    + `&transactiontype=CRYPTOTRANSFER`
    + `&timestamp=gte:${sinceTimestamp}`
    + `&timestamp=lte:${untilTimestamp}`
    + `&limit=50`
    + `&order=desc`;

  // Exponential backoff for retries
  const maxRetries = 3;
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        logger.error('Mirror node query failed', {
          status: response.status,
          invoiceId,
          attempt,
        });
        lastError = new Error(`HTTP ${response.status}`);

        // Exponential backoff: wait 2^attempt seconds before retry
        if (attempt < maxRetries - 1) {
          const delayMs = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        continue;
      }

      const data = await response.json() as {
        transactions: Array<{
          transaction_id: string;
          consensus_timestamp: string;
          memo_base64: string;
          result: string;
          token_transfers?: Array<{
            token_id: string;
            account: string;
            amount: number;
          }>;
        }>;
      };

      // Check for Mirror Node indexing lag: if no results in first 10 seconds, retry
      const now = Date.now();
      const timeSinceCreation = now - invoice.createdAt;
      if (data.transactions.length === 0 && timeSinceCreation < 10000) {
        logger.info('No transactions found yet (possible indexing lag), retrying...', {
          invoiceId,
          timeSinceCreationMs: timeSinceCreation,
          attempt,
        });
        lastError = new Error('Indexing lag detected');

        // Wait before retry
        if (attempt < maxRetries - 1) {
          const delayMs = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        continue;
      }

      // Search for a matching transaction
      for (const tx of data.transactions) {
        if (tx.result !== 'SUCCESS') continue;

        // Decode memo and check match
        const decodedMemo = Buffer.from(tx.memo_base64 ?? '', 'base64').toString('utf-8');
        if (decodedMemo !== invoice.memo) continue;

        // Check for USDC token transfer to treasury
        const tokenTransfers = tx.token_transfers ?? [];
        // Use integer comparison to avoid floating-point precision issues
        // USDC has 6 decimals: "49.000000" → 49_000_000 smallest units
        const expectedSmallestUnits = BigInt(
          invoice.amountUsdc.replace('.', '').replace(/^0+/, '') || '0',
        );
        const matchingTransfer = tokenTransfers.find(
          t =>
            t.token_id === invoice.tokenId &&
            t.account === invoice.treasuryAccountId &&
            BigInt(t.amount) >= expectedSmallestUnits,
        );

        if (matchingTransfer) {
          // Payment confirmed!
          updateInvoiceStatus(invoiceId, 'confirmed');

          const confirmation: PaymentConfirmation = {
            invoiceId,
            transactionId: tx.transaction_id,
            consensusTimestamp: tx.consensus_timestamp,
            fromAccount: tokenTransfers.find(
              t => t.token_id === invoice.tokenId && t.amount < 0,
            )?.account ?? 'unknown',
            amount: invoice.amountUsdc,
            status: 'confirmed',
          };

          logger.info('USDC payment confirmed', {
            invoiceId,
            transactionId: tx.transaction_id,
            amount: invoice.amountUsdc,
            retriesNeeded: attempt,
          });

          return confirmation;
        }
      }

      // No matching transaction found this attempt, but query succeeded
      return null;
    } catch (err: any) {
      lastError = err;
      logger.warn('Mirror node verification error', {
        invoiceId,
        error: err.message,
        attempt,
      });

      // Exponential backoff before retry
      if (attempt < maxRetries - 1) {
        const delayMs = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  logger.error('Mirror node verification failed after retries', {
    invoiceId,
    lastError: lastError?.message,
    maxRetries,
  });
  return null;
}

// ─── HCS Payment Receipt Anchoring ──────────────────────────────────────────

/**
 * After confirming a USDC payment, anchor the receipt on HCS
 * as an immutable proof of payment.
 */
export async function anchorPaymentReceiptOnHCS(
  confirmation: PaymentConfirmation,
  planId: string,
): Promise<{ topicId: string; sequenceNumber: number } | null> {
  try {
    const networkEnv = process.env.HEDERA_NETWORK;
    if (!networkEnv || !['testnet', 'mainnet'].includes(networkEnv)) {
      throw new Error(`HEDERA_NETWORK must be 'testnet' or 'mainnet', got: ${networkEnv}`);
    }

    const config: HCSConfig = {
      accountId: process.env.HEDERA_ACCOUNT_ID ?? '',
      privateKey: process.env.HEDERA_PRIVATE_KEY ?? '',
      network: networkEnv as 'testnet' | 'mainnet',
    };

    if (!config.accountId || !config.privateKey) {
      logger.warn('Hedera credentials not configured — skipping HCS anchoring');
      return null;
    }

    const topicId = process.env.HEDERA_AUDIT_TOPIC_ID;
    if (!topicId) {
      logger.warn('No audit topic configured — skipping HCS anchoring');
      return null;
    }

    const client = await createHederaClient(config);

    const { TopicMessageSubmitTransaction, TopicId } = await import('@hashgraph/sdk');

    const message = JSON.stringify({
      protocol: 'BorealisMark/1.0',
      type: 'PAYMENT_RECEIPT',
      invoiceId: confirmation.invoiceId,
      method: 'USDC_HEDERA',
      transactionId: confirmation.transactionId,
      consensusTimestamp: confirmation.consensusTimestamp,
      fromAccount: confirmation.fromAccount,
      amount: confirmation.amount,
      currency: 'USDC',
      planId,
      anchoredAt: new Date().toISOString(),
    });

    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(message)
      .execute(client);

    const receipt = await tx.getReceipt(client);

    logger.info('Payment receipt anchored on HCS', {
      invoiceId: confirmation.invoiceId,
      sequenceNumber: receipt.topicSequenceNumber?.toNumber(),
    });

    return {
      topicId,
      sequenceNumber: receipt.topicSequenceNumber?.toNumber() ?? 0,
    };
  } catch (err: any) {
    logger.error('HCS payment anchoring failed', { error: err.message });
    return null;
  }
}

// ─── Cleanup expired invoices (run periodically) ────────────────────────────

export function cleanupExpiredInvoices(): number {
  return cleanupExpiredUsdcInvoices();
}

/**
 * Get the full invoice record from the database (includes email, agentId, etc.)
 * Use this when you need fields beyond the PaymentInvoice interface.
 */
export function getInvoiceRecord(invoiceId: string): UsdcInvoiceRecord | null {
  return getUsdcInvoice(invoiceId);
}

/**
 * Persist confirmation details to the database after Mirror Node verification.
 */
export function persistConfirmation(
  invoiceId: string,
  transactionId: string,
  fromAccount: string,
  consensusTimestamp: string,
  hcsTopicId?: string,
  hcsSequenceNumber?: number,
): void {
  dbConfirmInvoice(invoiceId, transactionId, fromAccount, consensusTimestamp, hcsTopicId, hcsSequenceNumber);
}
