import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireApiKey, requireScope } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { auditLimiter } from '../middleware/rateLimiter';
import { logger, auditLog } from '../middleware/logger';
import {
  registerAgent,
  getAgent,
  saveCertificate,
  getLatestCertificate,
  getCertificateById,
  updateCertificateHCS,
} from '../db/database';
import { runAudit } from '../engine/audit-engine';
import { createHederaClient, submitCertificateToHCS, createAuditTopic } from '../hedera/hcs';
import { emit } from '../engine/webhook-dispatcher';
import type { AuditInput } from '../engine/types';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const RegisterAgentSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional().default(''),
  version: z.string().default('1.0.0'),
});

const ConstraintCheckSchema = z.object({
  constraintId: z.string(),
  constraintName: z.string(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  passed: z.boolean(),
  violationType: z.enum([
    'BOUNDARY_BREACH',
    'PROMPT_INJECTION',
    'DATA_EXFILTRATION',
    'SCOPE_CREEP',
    'HALLUCINATION',
    'AUTHORIZATION_BYPASS',
    'RATE_LIMIT_VIOLATION',
    'OUTPUT_POLICY_VIOLATION',
  ]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const DecisionLogSchema = z.object({
  decisionId: z.string(),
  timestamp: z.number().int().positive(),
  inputHash: z.string(),
  outputHash: z.string(),
  hasReasoningChain: z.boolean(),
  reasoningDepth: z.number().min(0).max(5),
  confidence: z.number().min(0).max(1),
  wasOverridden: z.boolean(),
});

const BehaviorSampleSchema = z.object({
  inputClass: z.string(),
  sampleCount: z.number().int().positive(),
  outputVariance: z.number().min(0).max(1),
  deterministicRate: z.number().min(0).max(1),
});

const AuditSchema = z.object({
  agentVersion: z.string().default('1.0.0'),
  auditPeriodStart: z.number().int().positive(),
  auditPeriodEnd: z.number().int().positive(),
  constraints: z.array(ConstraintCheckSchema).min(1),
  decisions: z.array(DecisionLogSchema).min(1),
  behaviorSamples: z.array(BehaviorSampleSchema).min(1),
  totalActions: z.number().int().nonnegative(),
  anomalyCount: z.number().int().nonnegative(),
  expectedLogEntries: z.number().int().nonnegative(),
  actualLogEntries: z.number().int().nonnegative(),
  auditorId: z.string().optional(),
});

// ─── POST /v1/agents/register ─────────────────────────────────────────────────

router.post('/register', requireApiKey, requireScope('audit'), validateBody(RegisterAgentSchema), (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { name, description, version } = req.body as z.infer<typeof RegisterAgentSchema>;
    const id = `agent_${uuidv4().replace(/-/g, '').slice(0, 20)}`;

    registerAgent(id, name, description ?? '', version, authReq.apiKey.id);

    auditLog('agent.registered', authReq.apiKey.id, {
      agentId: id, name, version, requestId: authReq.requestId,
    });

    // Fire webhook
    emit.agentRegistered({ agentId: id, name, version });

    res.status(201).json({
      success: true,
      data: { agentId: id, name, version, registeredAt: Date.now() },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Register agent error', { error: String(err), requestId: authReq.requestId });
    res.status(500).json({ success: false, error: 'Failed to register agent', timestamp: Date.now() });
  }
});

// ─── POST /v1/agents/audit ────────────────────────────────────────────────────

router.post('/audit', requireApiKey, requireScope('audit'), auditLimiter, validateBody(AuditSchema), async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const agentId = req.query.agentId as string;

  if (!agentId) {
    res.status(400).json({ success: false, error: 'agentId query parameter required', timestamp: Date.now() });
    return;
  }

  const agent = getAgent(agentId);
  if (!agent) {
    res.status(404).json({ success: false, error: 'Agent not found', timestamp: Date.now() });
    return;
  }

  // Fetch previous score for degradation/improvement detection
  const previousCert = getLatestCertificate(agentId);
  const previousScore = previousCert ? (previousCert.score_total as number) : null;
  const previousRating = previousCert ? (previousCert.credit_rating as string) : null;

  try {
    const body = req.body as z.infer<typeof AuditSchema>;
    const auditInput: AuditInput = { agentId, ...body };

    // ── Run the audit engine ───────────────────────────────────────────────────
    const certificate = runAudit(auditInput);

    // ── Persist certificate ────────────────────────────────────────────────────
    saveCertificate({
      certificateId: certificate.certificateId,
      agentId: certificate.agentId,
      agentVersion: certificate.agentVersion,
      auditId: certificate.auditId,
      issuedAt: certificate.issuedAt,
      auditPeriodStart: certificate.auditPeriodStart,
      auditPeriodEnd: certificate.auditPeriodEnd,
      scoreTotal: certificate.score.total,
      scoreJson: JSON.stringify(certificate.score),
      creditRating: certificate.creditRating,
      inputHash: certificate.inputHash,
      certificateHash: certificate.certificateHash,
    });

    logger.info('Audit certificate issued', {
      certificateId: certificate.certificateId,
      agentId,
      score: certificate.score.total,
      rating: certificate.creditRating,
      requestId: authReq.requestId,
    });

    auditLog('audit.completed', authReq.apiKey.id, {
      certificateId: certificate.certificateId,
      agentId,
      score: certificate.score.total,
      rating: certificate.creditRating,
      requestId: authReq.requestId,
    });

    // ── Attempt Hedera HCS submission ─────────────────────────────────────────
    const accountId = process.env.HEDERA_ACCOUNT_ID;
    const privateKey = process.env.HEDERA_PRIVATE_KEY;
    let topicId = process.env.HEDERA_AUDIT_TOPIC_ID;

    if (accountId && privateKey) {
      try {
        const hederaClient = createHederaClient({
          accountId,
          privateKey,
          network: (process.env.HEDERA_NETWORK as 'testnet' | 'mainnet') ?? 'testnet',
        });

        if (!topicId) {
          topicId = await createAuditTopic(hederaClient);
          logger.info(`Created new HCS audit topic: ${topicId}. Set HEDERA_AUDIT_TOPIC_ID=${topicId} in .env`);
        }

        const hcsResult = await submitCertificateToHCS(hederaClient, topicId, certificate);

        updateCertificateHCS(
          certificate.auditId,
          hcsResult.topicId,
          hcsResult.transactionId,
          hcsResult.sequenceNumber,
          hcsResult.consensusTimestamp,
        );

        certificate.hcsTopicId = hcsResult.topicId;
        certificate.hcsTransactionId = hcsResult.transactionId;
        certificate.hcsSequenceNumber = hcsResult.sequenceNumber;
        certificate.hcsConsensusTimestamp = hcsResult.consensusTimestamp;

        logger.info('Certificate anchored on Hedera HCS', {
          certificateId: certificate.certificateId,
          hcsTransactionId: hcsResult.transactionId,
          hcsSequenceNumber: hcsResult.sequenceNumber,
        });

        // Fire HCS-anchored webhook
        emit.auditAnchored({
          certificateId: certificate.certificateId,
          agentId,
          hcsTransactionId: hcsResult.transactionId,
          hcsSequenceNumber: hcsResult.sequenceNumber,
          hcsConsensusTimestamp: hcsResult.consensusTimestamp,
        });

      } catch (hcsErr) {
        logger.warn('HCS submission failed (certificate still valid)', {
          error: String(hcsErr),
          certificateId: certificate.certificateId,
        });
      }
    }

    // ── Fire audit.completed webhook ──────────────────────────────────────────
    emit.auditCompleted({
      certificateId: certificate.certificateId,
      agentId,
      score: certificate.score.total,
      creditRating: certificate.creditRating,
      hcsAnchored: !!certificate.hcsTransactionId,
    });

    // ── Score change detection (degraded / improved) ───────────────────────────
    if (previousScore !== null && previousRating !== null) {
      const delta = certificate.score.total - previousScore;
      if (delta <= -50) {
        emit.scoreDegraded({
          agentId,
          previousScore,
          newScore: certificate.score.total,
          previousRating,
          newRating: certificate.creditRating,
          delta,
        });
        logger.warn('Agent score significantly degraded', {
          agentId, previousScore, newScore: certificate.score.total, delta,
        });
      } else if (delta >= 50) {
        emit.scoreImproved({
          agentId,
          previousScore,
          newScore: certificate.score.total,
          previousRating,
          newRating: certificate.creditRating,
          delta,
        });
      }
    }

    res.status(200).json({
      success: true,
      data: certificate,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Audit engine error', { error: String(err), agentId, requestId: authReq.requestId });
    res.status(500).json({ success: false, error: 'Audit failed', timestamp: Date.now() });
  }
});

// ─── GET /v1/agents/:id/score ─────────────────────────────────────────────────

router.get('/:id/score', requireApiKey, requireScope('read'), (req, res) => {
  const cert = getLatestCertificate(req.params.id);
  if (!cert) {
    res.status(404).json({
      success: false,
      error: 'No audit certificate found for this agent',
      timestamp: Date.now(),
    });
    return;
  }

  const score = JSON.parse(cert.score_json as string);
  res.json({
    success: true,
    data: {
      agentId: cert.agent_id,
      score,
      creditRating: cert.credit_rating,
      certificateId: cert.certificate_id,
      issuedAt: cert.issued_at,
      hcsAnchored: cert.hcs_transaction_id !== null,
      hcsTransactionId: cert.hcs_transaction_id,
    },
    timestamp: Date.now(),
  });
});

// ─── GET /v1/agents/:id/certificate ───────────────────────────────────────────

router.get('/:id/certificate', requireApiKey, requireScope('read'), (req, res) => {
  const { id } = req.params;
  const cert = id.startsWith('BMK-') ? getCertificateById(id) : getLatestCertificate(id);

  if (!cert) {
    res.status(404).json({
      success: false,
      error: 'Certificate not found',
      timestamp: Date.now(),
    });
    return;
  }

  if (cert.revoked) {
    res.status(410).json({
      success: false,
      error: 'Certificate has been revoked',
      data: { certificateId: cert.certificate_id, revokedAt: cert.revoked },
      timestamp: Date.now(),
    });
    return;
  }

  res.json({
    success: true,
    data: {
      certificateId: cert.certificate_id,
      agentId: cert.agent_id,
      agentVersion: cert.agent_version,
      auditId: cert.audit_id,
      issuedAt: cert.issued_at,
      auditPeriodStart: cert.audit_period_start,
      auditPeriodEnd: cert.audit_period_end,
      score: JSON.parse(cert.score_json as string),
      creditRating: cert.credit_rating,
      inputHash: cert.input_hash,
      certificateHash: cert.certificate_hash,
      issuer: 'BorealisMark Protocol v1.0.0',
      hcsTopicId: cert.hcs_topic_id,
      hcsTransactionId: cert.hcs_transaction_id,
      hcsSequenceNumber: cert.hcs_sequence_number,
      hcsConsensusTimestamp: cert.hcs_consensus_timestamp,
      revoked: false,
    },
    timestamp: Date.now(),
  });
});

export default router;
