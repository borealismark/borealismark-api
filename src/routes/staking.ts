import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireApiKey, requireScope } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { slashLimiter } from '../middleware/rateLimiter';
import { logger, auditLog } from '../middleware/logger';
import { allocateStake, getActiveStake, recordSlash } from '../db/database';
import { createHederaClient, submitSlashEventToHCS } from '../hedera/hcs';
import { emit } from '../engine/webhook-dispatcher';
import type { SlashEvent, StakeTier } from '../engine/types';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// BMT → USDC coverage ratio: 1 BMT = 100 USDC coverage
const BMT_TO_USDC_RATIO = 100;

// Severity-based caps on slash amounts to prevent excessive slashing for minor violations
const SEVERITY_CAPS: Record<string, number> = {
  'RATE_LIMIT_VIOLATION': 0.10,
  'HALLUCINATION': 0.25,
  'SCOPE_CREEP': 0.25,
  'OUTPUT_POLICY_VIOLATION': 0.25,
  'PROMPT_INJECTION': 0.50,
  'BOUNDARY_BREACH': 0.50,
  'AUTHORIZATION_BYPASS': 0.75,
  'DATA_EXFILTRATION': 1.00,
};

// Stake amount → protection tier mapping
function getTier(bmtAmount: number): StakeTier {
  if (bmtAmount <= 0)          return 'NO_COVERAGE';
  if (bmtAmount < 5_000)       return 'STARTUP_SHIELD';
  if (bmtAmount < 25_000)      return 'STARTUP_SHIELD';
  if (bmtAmount < 100_000)     return 'GROWTH_VAULT';
  if (bmtAmount < 500_000)     return 'ENTERPRISE_FORTRESS';
  if (bmtAmount < 1_000_000)   return 'INSTITUTIONAL_CITADEL';
  return 'SOVEREIGN_RESERVE';
}

// ─── POST /v1/staking/allocate ────────────────────────────────────────────────

const AllocateSchema = z.object({
  agentId: z.string().min(1),
  bmtAmount: z.number().positive().max(1_000_000),
});

router.post('/allocate', requireApiKey, requireScope('audit'), validateBody(AllocateSchema), (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const { agentId, bmtAmount } = req.body as z.infer<typeof AllocateSchema>;

  const usdcCoverage = bmtAmount * BMT_TO_USDC_RATIO;
  const tier = getTier(bmtAmount);
  const stakeId = uuidv4();

  try {
    allocateStake(stakeId, agentId, bmtAmount, usdcCoverage, tier);

    auditLog('stake.allocated', authReq.apiKey.id, {
      stakeId, agentId, bmtAmount, usdcCoverage, tier,
      requestId: authReq.requestId,
    });

    // Fire webhook
    emit.stakeAllocated({ agentId, stakeId, bmtAmount, usdcCoverage, tier });

    res.status(201).json({
      success: true,
      data: {
        stakeId,
        agentId,
        bmtAmount,
        usdcCoverage,
        tier,
        ratio: `1 BMT = ${BMT_TO_USDC_RATIO} USDC`,
        allocatedAt: Date.now(),
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Stake allocation error', { error: String(err), agentId, requestId: authReq.requestId });
    res.status(500).json({ success: false, error: 'Failed to allocate stake', timestamp: Date.now() });
  }
});

// ─── POST /v1/staking/slash ───────────────────────────────────────────────────

const SlashSchema = z.object({
  agentId: z.string().min(1),
  violationType: z.enum([
    'BOUNDARY_BREACH',
    'PROMPT_INJECTION',
    'DATA_EXFILTRATION',
    'SCOPE_CREEP',
    'HALLUCINATION',
    'AUTHORIZATION_BYPASS',
    'RATE_LIMIT_VIOLATION',
    'OUTPUT_POLICY_VIOLATION',
  ]),
  amountSlashed: z.number().positive(),
  claimantAddress: z.string().min(5),
});

router.post('/slash', requireApiKey, requireScope('audit'), slashLimiter, validateBody(SlashSchema), async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const { agentId, violationType, amountSlashed, claimantAddress } = req.body as z.infer<typeof SlashSchema>;

  const stake = getActiveStake(agentId);
  if (!stake) {
    res.status(404).json({
      success: false,
      error: 'No active stake found for this agent',
      timestamp: Date.now(),
    });
    return;
  }

  const stakeAmount = stake.bmt_amount as number;
  if (amountSlashed > stakeAmount) {
    res.status(400).json({
      success: false,
      error: `Cannot slash ${amountSlashed} BMT — only ${stakeAmount} BMT staked`,
      timestamp: Date.now(),
    });
    return;
  }

  // Enforce severity-based slash caps to prevent excessive penalties
  const maxSlashRatio = SEVERITY_CAPS[violationType] ?? 0.50;
  const maxSlashAmount = stakeAmount * maxSlashRatio;
  if (amountSlashed > maxSlashAmount) {
    res.status(400).json({
      success: false,
      error: `Slash amount exceeds severity cap. ${violationType} allows max ${(maxSlashRatio * 100)}% slash (${maxSlashAmount} BMT)`,
      timestamp: Date.now(),
    });
    return;
  }

  const slashId = uuidv4();
  let hcsTxId: string | undefined;

  // Submit slash event to Hedera if configured
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  const topicId = process.env.HEDERA_AUDIT_TOPIC_ID;

  if (accountId && privateKey && topicId) {
    try {
      const slashEvent: SlashEvent = {
        slashId,
        stakeId: stake.id as string,
        agentId,
        violationType: violationType as SlashEvent['violationType'],
        amountSlashed,
        claimantAddress,
        executedAt: Date.now(),
      };

      const hederaClient = createHederaClient({
        accountId,
        privateKey,
        network: (process.env.HEDERA_NETWORK as 'testnet' | 'mainnet') ?? 'testnet',
      });

      const hcsResult = await submitSlashEventToHCS(hederaClient, topicId, slashEvent);
      hcsTxId = hcsResult.transactionId;

      logger.info('Slash event anchored on Hedera HCS', {
        slashId, agentId, hcsTransactionId: hcsTxId,
      });
    } catch (hcsErr) {
      logger.warn('Slash HCS submission failed', {
        error: String(hcsErr), slashId, agentId,
      });
    }
  }

  try {
    recordSlash(slashId, stake.id as string, agentId, violationType, amountSlashed, claimantAddress, hcsTxId);

    auditLog('slash.executed', authReq.apiKey.id, {
      slashId, agentId, violationType, amountSlashed, claimantAddress,
      hcsTransactionId: hcsTxId, requestId: authReq.requestId,
    });

    // Fire webhook
    emit.slashExecuted({
      agentId,
      slashId,
      violationType,
      amountSlashed,
      claimantAddress,
      hcsTransactionId: hcsTxId,
    });

    res.status(200).json({
      success: true,
      data: {
        slashId,
        agentId,
        violationType,
        amountSlashed,
        remainingStake: stakeAmount - amountSlashed,
        claimantAddress,
        hcsTransactionId: hcsTxId ?? null,
        executedAt: Date.now(),
        message: 'Slashing protocol executed. Stake redistributed to claimant.',
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Slash execution error', { error: String(err), slashId, requestId: authReq.requestId });
    res.status(500).json({ success: false, error: 'Failed to execute slash', timestamp: Date.now() });
  }
});

// ─── GET /v1/staking/:agentId ─────────────────────────────────────────────────

router.get('/:agentId', requireApiKey, requireScope('read'), (req, res) => {
  const stake = getActiveStake(req.params.agentId);
  if (!stake) {
    res.status(404).json({
      success: false,
      error: 'No active stake for this agent',
      timestamp: Date.now(),
    });
    return;
  }

  res.json({
    success: true,
    data: {
      stakeId: stake.id,
      agentId: stake.agent_id,
      bmtAmount: stake.bmt_amount,
      usdcCoverage: stake.usdc_coverage,
      tier: stake.tier,
      allocatedAt: stake.allocated_at,
    },
    timestamp: Date.now(),
  });
});

export default router;
