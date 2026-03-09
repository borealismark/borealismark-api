/**
 * BorealisMark — Hedera Configuration Health Check
 *
 * Validates Hedera environment configuration on startup.
 * Checks credentials, network settings, and topic/token IDs.
 * Provides clear diagnostic information about what's configured vs missing.
 */

import { logger } from '../middleware/logger';
import { validateTreasuryAccounts } from './treasury';

export interface HealthCheckResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Validates Hedera configuration and returns detailed status.
 * Checks:
 *   - HEDERA_ACCOUNT_ID format (0.0.XXXXX)
 *   - HEDERA_PRIVATE_KEY presence and format
 *   - HEDERA_NETWORK is 'testnet' or 'mainnet'
 *   - HEDERA_AUDIT_TOPIC_ID format (if set)
 *   - HEDERA_USDC_TOKEN_ID format (if set)
 */
export function validateHederaConfig(): HealthCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check HEDERA_ACCOUNT_ID
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  if (!accountId) {
    warnings.push('HEDERA_ACCOUNT_ID not set — HCS anchoring disabled');
  } else {
    const accountIdRegex = /^0\.0\.\d+$/;
    if (!accountIdRegex.test(accountId)) {
      errors.push(`HEDERA_ACCOUNT_ID format invalid: "${accountId}" should be "0.0.XXXXX" (shard.realm.account)`);
    } else {
      logger.info('✓ HEDERA_ACCOUNT_ID configured', { accountId });
    }
  }

  // Check HEDERA_PRIVATE_KEY
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  if (!privateKey) {
    if (accountId) {
      errors.push('HEDERA_ACCOUNT_ID is set but HEDERA_PRIVATE_KEY is missing — cannot sign transactions');
    } else {
      warnings.push('HEDERA_PRIVATE_KEY not set — HCS anchoring disabled');
    }
  } else {
    const keyLength = privateKey.replace(/^0x/, '').trim().length;
    if (keyLength < 64) {
      errors.push(`HEDERA_PRIVATE_KEY format invalid: too short (${keyLength} chars, expected 64+ for hex or DER-encoded)`);
    } else {
      logger.info('✓ HEDERA_PRIVATE_KEY configured (length: ' + keyLength + ')');
    }
  }

  // Check HEDERA_NETWORK
  const network = process.env.HEDERA_NETWORK;
  if (!network) {
    if (accountId || privateKey) {
      errors.push('HEDERA_NETWORK not set — must be "testnet" or "mainnet" to use HCS');
    } else {
      warnings.push('HEDERA_NETWORK not set — HCS disabled');
    }
  } else {
    if (!['testnet', 'mainnet'].includes(network)) {
      errors.push(`HEDERA_NETWORK invalid: "${network}" must be "testnet" or "mainnet"`);
    } else {
      logger.info('✓ HEDERA_NETWORK configured', { network });
    }
  }

  // Check HEDERA_AUDIT_TOPIC_ID (optional but if set, validate format)
  const auditTopicId = process.env.HEDERA_AUDIT_TOPIC_ID;
  if (auditTopicId) {
    const topicIdRegex = /^0\.0\.\d+$/;
    if (!topicIdRegex.test(auditTopicId)) {
      errors.push(`HEDERA_AUDIT_TOPIC_ID format invalid: "${auditTopicId}" should be "0.0.XXXXX"`);
    } else {
      logger.info('✓ HEDERA_AUDIT_TOPIC_ID configured', { topicId: auditTopicId });
    }
  } else {
    if (accountId && privateKey) {
      warnings.push('HEDERA_AUDIT_TOPIC_ID not set — will be auto-created on first certificate submission');
    }
  }

  // Check HEDERA_USDC_TOKEN_ID (optional but if set, validate format)
  const usdcTokenId = process.env.HEDERA_USDC_TOKEN_ID;
  if (usdcTokenId) {
    const tokenIdRegex = /^0\.0\.\d+$/;
    if (!tokenIdRegex.test(usdcTokenId)) {
      errors.push(`HEDERA_USDC_TOKEN_ID format invalid: "${usdcTokenId}" should be "0.0.XXXXX"`);
    } else {
      logger.info('✓ HEDERA_USDC_TOKEN_ID configured', { tokenId: usdcTokenId });
    }
  }

  // Treasury account validation
  const treasury = validateTreasuryAccounts();
  treasury.errors.forEach(e => errors.push(e));
  treasury.warnings.forEach(w => warnings.push(w));

  // Summary
  const configured = accountId && privateKey && network;
  if (configured) {
    logger.info('✓ Hedera HCS integration configured and ready', { network, accountId });
  } else if (warnings.length > 0 && errors.length === 0) {
    logger.info('⚠ Hedera HCS integration disabled (optional)', { warnings });
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * Log health check results at startup.
 * Exits process with code 1 if there are critical errors.
 */
export function logHealthCheckResults(result: HealthCheckResult): void {
  if (result.warnings.length > 0) {
    logger.warn('Hedera health check warnings:', { count: result.warnings.length });
    result.warnings.forEach(w => logger.warn(`  ⚠ ${w}`));
  }

  if (result.errors.length > 0) {
    logger.error('Hedera health check errors:', { count: result.errors.length });
    result.errors.forEach(e => logger.error(`  ✗ ${e}`));
    logger.error('FATAL: Cannot start server with Hedera configuration errors');
    process.exit(1);
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    logger.info('✓ Hedera configuration valid');
  }
}
