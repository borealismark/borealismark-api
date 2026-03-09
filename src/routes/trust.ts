import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireApiKey, requireScope } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { slashLimiter } from '../middleware/rateLimiter';
import { logger, auditLog } from '../middleware/logger';
import { createTrustDeposit, getActiveTrustDeposit, recordPenalty } from '../db/database';
import { createHederaClient, submitPenaltyEventToHCS } from '../hedera/hcs';
import { emit } from '../engine/webhook-dispatcher';
import type { PenaltyEvent, TrustTier } from '../engine/types';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Severity-based caps on penalty amounts to prevent excessive penalties for minor violations
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

// USDC deposit amount → trust tier mapping
function getTier(usdcAmount: number): TrustTier {
  if (usdcAmount <= 0)          return 'UNVERIFIED';
  if (usdcAmount < 5_000)       return 'STARTER_TRUST';
  if (usdcAmount < 25_000)      return 'GROWTH_TRUST';
  if (usdcAmount < 100_000)     return 'ENTERPRISE_TRUST';
  if (usdcAmount < 500_000)     return 'INSTITUTIONAL_TRUST';
  return 'SOVEREIGN_TRUST';
}

// ─── POST /v1/trust/deposit ───────────────────────────────────────────────

const DepositSchema = z.object({
  agentId: z.string().min(1),
  usdcAmount: z.number().positive().max(1_000_000),
});

router.post('/deposit', requireApiKey, requireScope('audit'), validateBody(DepositSchema), (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const { agentId, usdcAmount } = req.body as z.infer<typeof DepositSchema>;

  const tier = getTier(usdcAmount);
  const depositId = uuidv4();

  try {
    createTrustDeposit(depositId, agentId, usdcAmount, tier);

    auditLog('trust.deposited', authReq.apiKey.id, {
      depositId, agentId, usdcAmount, tier,
      requestId: authReq.requestId,
    });

    // Fire webhook
    emit.trustDeposited({ agentId, depositId, usdcAmount, tier });

    res.status(201).json({
      success: true,
      data: {
        depositId,
        agentId,
        usdcAmount,
        tier,
        depositedAt: Date.now(),
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Trust deposit error', { error: String(err), agentId, requestId: authReq.requestId });
    res.status(500).json({ success: false, error: 'Failed to create trust deposit', timestamp: Date.now() });
  }
});

// ─── POST /v1/trust/penalize ──────────────────────────────────────────────

const PenalizeSchema = z.object({
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
  amountForfeited: z.number().positive(),
});

router.post('/penalize', requireApiKey, requireScope('audit'), slashLimiter, validateBody(PenalizeSchema), async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const { agentId, violationType, amountForfeited } = req.body as z.infer<typeof PenalizeSchema>;

  const deposit = getActiveTrustDeposit(agentId);
  if (!deposit) {
    res.status(404).json({
      success: false,
      error: 'No active trust deposit found for this agent',
      timestamp: Date.now(),
    });
    return;
  }

  const depositAmount = deposit.usdc_amount as number;
  if (amountForfeited > depositAmount) {
    res.status(400).json({
      success: false,
      error: `Cannot forfeit ${amountForfeited} USDC — only ${depositAmount} USDC deposited`,
      timestamp: Date.now(),
    });
    return;
  }

  // Verify deposit has sufficient balance remaining after penalty
  const remainingBalance = depositAmount - amountForfeited;
  if (remainingBalance < 0) {
    res.status(400).json({
      success: false,
      error: `Forfeiture amount exceeds available balance. ${depositAmount} USDC deposited, cannot forfeit ${amountForfeited} USDC`,
      timestamp: Date.now(),
    });
    return;
  }

  // Cooldown: prevent multiple penalties within 24 hours on same agent
  // TODO: Query penalty_events table for agent_id with executed_at > now - 24h
  // For now, this is documented but requires database query implementation

  // Enforce severity-based penalty caps to prevent excessive penalties
  const maxPenaltyRatio = SEVERITY_CAPS[violationType] ?? 0.50;
  const maxPenaltyAmount = depositAmount * maxPenaltyRatio;
  if (amountForfeited > maxPenaltyAmount) {
    res.status(400).json({
      success: false,
      error: `Forfeiture amount exceeds severity cap. ${violationType} allows max ${(maxPenaltyRatio * 100)}% penalty (${maxPenaltyAmount} USDC)`,
      timestamp: Date.now(),
    });
    return;
  }

  // Track total forfeited: don't allow total forfeited to exceed original deposit amount
  // This prevents infinite penalties and ensures proportional enforcement
  // TODO: Query penalty_events table for agent_id and sum amount_forfeited
  // Validate: sum(amount_forfeited) + amountForfeited <= depositAmount

  const penaltyId = uuidv4();
  let hcsTxId: string | undefined;

  // Submit penalty event to Hedera if configured
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  const topicId = process.env.HEDERA_AUDIT_TOPIC_ID;

  if (accountId && privateKey && topicId) {
    try {
      const penaltyEvent: PenaltyEvent = {
        penaltyId,
        depositId: deposit.id as string,
        agentId,
        violationType: violationType as PenaltyEvent['violationType'],
        amountForfeited,
        executedAt: Date.now(),
      };

      const networkEnv = process.env.HEDERA_NETWORK;
      if (!networkEnv || !['testnet', 'mainnet'].includes(networkEnv)) {
        throw new Error(`HEDERA_NETWORK must be 'testnet' or 'mainnet', got: ${networkEnv}`);
      }

      const hederaClient = await createHederaClient({
        accountId,
        privateKey,
        network: networkEnv as 'testnet' | 'mainnet',
      });

      const hcsResult = await submitPenaltyEventToHCS(hederaClient, topicId, penaltyEvent);
      hcsTxId = hcsResult.transactionId;

      logger.info('Penalty event anchored on Hedera HCS', {
        penaltyId, agentId, hcsTransactionId: hcsTxId,
      });
    } catch (hcsErr) {
      logger.warn('Penalty HCS submission failed', {
        error: String(hcsErr), penaltyId, agentId,
      });
    }
  }

  try {
    recordPenalty(penaltyId, deposit.id as string, agentId, violationType, amountForfeited, hcsTxId);

    auditLog('penalty.executed', authReq.apiKey.id, {
      penaltyId, agentId, violationType, amountForfeited,
      hcsTransactionId: hcsTxId, requestId: authReq.requestId,
    });

    // Fire webhook
    emit.penaltyExecuted({
      agentId,
      penaltyId,
      violationType,
      amountForfeited,
      hcsTransactionId: hcsTxId,
    });

    res.status(200).json({
      success: true,
      data: {
        penaltyId,
        agentId,
        violationType,
        amountForfeited,
        remainingDeposit: depositAmount - amountForfeited,
        hcsTransactionId: hcsTxId ?? null,
        executedAt: Date.now(),
        message: 'Trust deposit penalty executed. Forfeited amount returned to protocol treasury.',
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Penalty execution error', { error: String(err), penaltyId, requestId: authReq.requestId });
    res.status(500).json({ success: false, error: 'Failed to execute penalty', timestamp: Date.now() });
  }
});

// ─── GET /v1/trust/:agentId ───────────────────────────────────────────────

router.get('/:agentId', requireApiKey, requireScope('read'), (req, res) => {
  const deposit = getActiveTrustDeposit(req.params.agentId);
  if (!deposit) {
    res.status(404).json({
      success: false,
      error: 'No active trust deposit for this agent',
      timestamp: Date.now(),
    });
    return;
  }

  res.json({
    success: true,
    data: {
      depositId: deposit.id,
      agentId: deposit.agent_id,
      usdcAmount: deposit.usdc_amount,
      tier: deposit.tier,
      depositedAt: deposit.allocated_at,
    },
    timestamp: Date.now(),
  });
});

export default router;
