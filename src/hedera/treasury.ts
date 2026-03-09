/**
 * Hedera Treasury Management — 3-Account Structure
 *
 * CORE PRINCIPLE: BorealisMark is the data layer, not the risk layer.
 *
 * Account 1: OPERATIONS_TREASURY — Platform revenue (fees, subscriptions)
 * Account 2: TRUST_ESCROW — Agent trust deposits (segregated from operations)
 * Account 3: GAS_WALLET — HBAR for HCS transaction fees
 *
 * This segregation is required for:
 * - CRA compliance (customer funds vs operating revenue)
 * - Audit trail (which funds belong to whom)
 * - Security (compromise of gas wallet doesn't expose treasury)
 *
 * Env vars:
 *   HEDERA_OPS_ACCOUNT_ID, HEDERA_OPS_PRIVATE_KEY
 *   HEDERA_ESCROW_ACCOUNT_ID, HEDERA_ESCROW_PRIVATE_KEY
 *   HEDERA_GAS_ACCOUNT_ID, HEDERA_GAS_PRIVATE_KEY (defaults to HEDERA_ACCOUNT_ID)
 */

import { logger } from '../middleware/logger';

export interface TreasuryConfig {
  operations: { accountId: string; configured: boolean };
  escrow: { accountId: string; configured: boolean };
  gas: { accountId: string; configured: boolean };
}

export function getTreasuryConfig(): TreasuryConfig {
  return {
    operations: {
      accountId: process.env.HEDERA_OPS_ACCOUNT_ID || 'NOT_CONFIGURED',
      configured: !!(process.env.HEDERA_OPS_ACCOUNT_ID && process.env.HEDERA_OPS_PRIVATE_KEY),
    },
    escrow: {
      accountId: process.env.HEDERA_ESCROW_ACCOUNT_ID || 'NOT_CONFIGURED',
      configured: !!(process.env.HEDERA_ESCROW_ACCOUNT_ID && process.env.HEDERA_ESCROW_PRIVATE_KEY),
    },
    gas: {
      accountId: process.env.HEDERA_GAS_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID || 'NOT_CONFIGURED',
      configured: !!(process.env.HEDERA_GAS_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID),
    },
  };
}

/**
 * Validate that all treasury accounts are configured.
 * In development, only the gas wallet is required.
 * In production, all three are required.
 */
export function validateTreasuryAccounts(): { valid: boolean; errors: string[]; warnings: string[] } {
  const config = getTreasuryConfig();
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProd = process.env.NODE_ENV === 'production';

  if (!config.gas.configured) {
    errors.push('Gas wallet not configured (HEDERA_GAS_ACCOUNT_ID or HEDERA_ACCOUNT_ID required)');
  }

  if (isProd) {
    if (!config.operations.configured) {
      errors.push('Operations treasury not configured (HEDERA_OPS_ACCOUNT_ID + HEDERA_OPS_PRIVATE_KEY required in production)');
    }
    if (!config.escrow.configured) {
      errors.push('Trust escrow not configured (HEDERA_ESCROW_ACCOUNT_ID + HEDERA_ESCROW_PRIVATE_KEY required in production)');
    }
  } else {
    if (!config.operations.configured) {
      warnings.push('Operations treasury not configured — using gas wallet as fallback (dev only)');
    }
    if (!config.escrow.configured) {
      warnings.push('Trust escrow not configured — trust deposits will not be segregated (dev only)');
    }
  }

  // Security check: ensure accounts are different in production
  if (isProd && config.operations.accountId === config.escrow.accountId) {
    errors.push('CRITICAL: Operations and Escrow accounts must be different in production (fund segregation requirement)');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Get the appropriate account for a given operation type.
 */
export function getAccountForOperation(operation: 'platform_fee' | 'trust_deposit' | 'trust_penalty' | 'hcs_anchor' | 'certificate_fee'): { accountId: string; privateKey: string } | null {
  switch (operation) {
    case 'platform_fee':
    case 'certificate_fee':
    case 'trust_penalty':
      // Revenue goes to operations treasury
      return {
        accountId: process.env.HEDERA_OPS_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID || '',
        privateKey: process.env.HEDERA_OPS_PRIVATE_KEY || process.env.HEDERA_PRIVATE_KEY || '',
      };

    case 'trust_deposit':
      // Deposits go to escrow (segregated)
      return {
        accountId: process.env.HEDERA_ESCROW_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID || '',
        privateKey: process.env.HEDERA_ESCROW_PRIVATE_KEY || process.env.HEDERA_PRIVATE_KEY || '',
      };

    case 'hcs_anchor':
      // HCS operations use gas wallet
      return {
        accountId: process.env.HEDERA_GAS_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID || '',
        privateKey: process.env.HEDERA_GAS_PRIVATE_KEY || process.env.HEDERA_PRIVATE_KEY || '',
      };

    default:
      return null;
  }
}
