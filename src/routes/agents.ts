import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireApiKey, requireScope } from '../middleware/auth';
import { requireAuth } from './auth';
import type { AuthRequest } from './auth';
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
  getAgentsByUserId,
  getAgentByIdAndOwner,
  updateAgent,
  softDeleteAgent,
  getCertificatesByAgentId,
  getCertificatesByUserId,
  toggleAgentPublicListing,
  getPublicAgents,
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
        const hederaClient = await createHederaClient({
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

// ═══════════════════════════════════════════════════════════════════════════════
// JWT-AUTHENTICATED DASHBOARD ENDPOINTS (user-owned agents)
// ═══════════════════════════════════════════════════════════════════════════════

const DashboardRegisterSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional().default(''),
  version: z.string().default('1.0.0'),
  agent_type: z.enum(['llm', 'image', 'audio', 'code', 'other']).default('other'),
});

const DashboardUpdateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  version: z.string().optional(),
  agent_type: z.enum(['llm', 'image', 'audio', 'code', 'other']).optional(),
});

// ─── GET /v1/agents/my ────────────────────────────────────────────────────────
router.get('/my', requireAuth, (req, res) => {
  const user = (req as AuthRequest).user!;
  try {
    const agents = getAgentsByUserId(user.sub);
    // Enrich with latest certificate data
    const enriched = agents.map((agent: any) => {
      const cert = getLatestCertificate(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        version: agent.version,
        agent_type: agent.agent_type || 'other',
        registered_at: agent.registered_at,
        active: agent.active,
        public_listing: agent.public_listing || 0,
        score: cert ? (cert.score_total as number) : null,
        credit_rating: cert ? (cert.credit_rating as string) : null,
        score_json: cert ? JSON.parse(cert.score_json as string) : null,
        certificate_id: cert ? (cert.certificate_id as string) : null,
        last_audit_at: cert ? (cert.issued_at as number) : null,
        hcs_anchored: cert ? !!(cert.hcs_transaction_id) : false,
      };
    });
    res.json({ success: true, data: enriched, timestamp: Date.now() });
  } catch (err) {
    logger.error('List user agents error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Failed to list agents', timestamp: Date.now() });
  }
});

// ─── POST /v1/agents/my/register ──────────────────────────────────────────────
router.post('/my/register', requireAuth, (req, res) => {
  const user = (req as AuthRequest).user!;
  try {
    const parsed = DashboardRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors, timestamp: Date.now() });
      return;
    }
    const { name, description, version, agent_type } = parsed.data;
    const id = `agent_${uuidv4().replace(/-/g, '').slice(0, 20)}`;

    registerAgent(id, name, description ?? '', version, 'dashboard', user.sub, agent_type);

    emit.agentRegistered({ agentId: id, name, version });

    res.status(201).json({
      success: true,
      data: {
        id, name, description, version, agent_type,
        registered_at: Date.now(), active: 1, public_listing: 0,
        score: null, credit_rating: null, certificate_id: null, last_audit_at: null,
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Dashboard register agent error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Failed to register agent', timestamp: Date.now() });
  }
});

// ─── PATCH /v1/agents/my/:id ──────────────────────────────────────────────────
router.patch('/my/:id', requireAuth, (req, res) => {
  const user = (req as AuthRequest).user!;
  try {
    const parsed = DashboardUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors, timestamp: Date.now() });
      return;
    }
    const updated = updateAgent(req.params.id, user.sub, parsed.data);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Agent not found or not owned by you', timestamp: Date.now() });
      return;
    }
    const agent = getAgentByIdAndOwner(req.params.id, user.sub);
    res.json({ success: true, data: agent, timestamp: Date.now() });
  } catch (err) {
    logger.error('Dashboard update agent error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Failed to update agent', timestamp: Date.now() });
  }
});

// ─── DELETE /v1/agents/my/:id ─────────────────────────────────────────────────
router.delete('/my/:id', requireAuth, (req, res) => {
  const user = (req as AuthRequest).user!;
  try {
    const deleted = softDeleteAgent(req.params.id, user.sub);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Agent not found or not owned by you', timestamp: Date.now() });
      return;
    }
    res.json({ success: true, data: { message: 'Agent deleted' }, timestamp: Date.now() });
  } catch (err) {
    logger.error('Dashboard delete agent error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Failed to delete agent', timestamp: Date.now() });
  }
});

// ─── GET /v1/agents/my/:id/certificates ───────────────────────────────────────
router.get('/my/:id/certificates', requireAuth, (req, res) => {
  const user = (req as AuthRequest).user!;
  try {
    const agent = getAgentByIdAndOwner(req.params.id, user.sub);
    if (!agent) {
      res.status(404).json({ success: false, error: 'Agent not found', timestamp: Date.now() });
      return;
    }
    const certs = getCertificatesByAgentId(req.params.id);
    const enriched = certs.map((c: any) => ({
      certificate_id: c.certificate_id,
      agent_id: c.agent_id,
      agent_version: c.agent_version,
      issued_at: c.issued_at,
      score_total: c.score_total,
      score_json: JSON.parse(c.score_json),
      credit_rating: c.credit_rating,
      certificate_hash: c.certificate_hash,
      hcs_topic_id: c.hcs_topic_id,
      hcs_transaction_id: c.hcs_transaction_id,
      hcs_sequence_number: c.hcs_sequence_number,
      revoked: !!c.revoked,
    }));
    res.json({ success: true, data: enriched, timestamp: Date.now() });
  } catch (err) {
    logger.error('Get agent certificates error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Failed to get certificates', timestamp: Date.now() });
  }
});

// ─── GET /v1/agents/my/certificates/all ───────────────────────────────────────
router.get('/my/certificates/all', requireAuth, (req, res) => {
  const user = (req as AuthRequest).user!;
  try {
    const certs = getCertificatesByUserId(user.sub);
    const enriched = certs.map((c: any) => ({
      certificate_id: c.certificate_id,
      agent_id: c.agent_id,
      agent_version: c.agent_version,
      issued_at: c.issued_at,
      score_total: c.score_total,
      score_json: JSON.parse(c.score_json),
      credit_rating: c.credit_rating,
      certificate_hash: c.certificate_hash,
      hcs_topic_id: c.hcs_topic_id,
      hcs_transaction_id: c.hcs_transaction_id,
      revoked: !!c.revoked,
    }));
    res.json({ success: true, data: enriched, timestamp: Date.now() });
  } catch (err) {
    logger.error('Get all user certificates error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Failed to get certificates', timestamp: Date.now() });
  }
});

// ─── POST /v1/agents/my/:id/audit ─────────────────────────────────────────────
// Simplified audit for dashboard users (Quick or Advanced)
router.post('/my/:id/audit', requireAuth, auditLimiter, async (req, res) => {
  const user = (req as AuthRequest).user!;
  const agent = getAgentByIdAndOwner(req.params.id, user.sub);
  if (!agent) {
    res.status(404).json({ success: false, error: 'Agent not found', timestamp: Date.now() });
    return;
  }

  try {
    const isQuick = req.body.mode === 'quick';
    const now = Date.now();
    const dayMs = 86400000;

    let auditInput: AuditInput;

    if (isQuick) {
      // Quick Audit: auto-generate baseline data
      auditInput = {
        agentId: req.params.id,
        agentVersion: (agent.version as string) || '1.0.0',
        auditPeriodStart: now - 30 * dayMs,
        auditPeriodEnd: now,
        constraints: [
          { constraintId: 'c1', constraintName: 'Input Boundary Check', severity: 'MEDIUM' as any, passed: true },
          { constraintId: 'c2', constraintName: 'Output Policy Compliance', severity: 'HIGH' as any, passed: true },
          { constraintId: 'c3', constraintName: 'Data Handling Protocol', severity: 'CRITICAL' as any, passed: true },
        ],
        decisions: [
          { decisionId: 'd1', timestamp: now - dayMs, inputHash: 'auto', outputHash: 'auto', hasReasoningChain: true, reasoningDepth: 3, confidence: 0.85, wasOverridden: false },
        ],
        behaviorSamples: [
          { inputClass: 'general', sampleCount: 100, outputVariance: 0.15, deterministicRate: 0.85 },
        ],
        totalActions: 100,
        anomalyCount: 2,
        expectedLogEntries: 100,
        actualLogEntries: 98,
      };
    } else {
      // Advanced Audit: user provides data
      const parsed = AuditSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Invalid audit data', details: parsed.error.flatten().fieldErrors, timestamp: Date.now() });
        return;
      }
      auditInput = { agentId: req.params.id, ...parsed.data };
    }

    // Run the audit engine
    const certificate = runAudit(auditInput);

    // Persist
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

    // Try HCS anchoring
    const accountId = process.env.HEDERA_ACCOUNT_ID;
    const privateKey = process.env.HEDERA_PRIVATE_KEY;
    let topicId = process.env.HEDERA_AUDIT_TOPIC_ID;

    if (accountId && privateKey) {
      try {
        const hederaClient = await createHederaClient({ accountId, privateKey, network: (process.env.HEDERA_NETWORK as 'testnet' | 'mainnet') ?? 'testnet' });
        if (!topicId) topicId = await createAuditTopic(hederaClient);
        const hcsResult = await submitCertificateToHCS(hederaClient, topicId, certificate);
        updateCertificateHCS(certificate.auditId, hcsResult.topicId, hcsResult.transactionId, hcsResult.sequenceNumber, hcsResult.consensusTimestamp);
        certificate.hcsTopicId = hcsResult.topicId;
        certificate.hcsTransactionId = hcsResult.transactionId;
        certificate.hcsSequenceNumber = hcsResult.sequenceNumber;
        certificate.hcsConsensusTimestamp = hcsResult.consensusTimestamp;
      } catch (hcsErr) {
        logger.warn('Dashboard audit HCS submission failed', { error: String(hcsErr) });
      }
    }

    emit.auditCompleted({
      certificateId: certificate.certificateId,
      agentId: req.params.id,
      score: certificate.score.total,
      creditRating: certificate.creditRating,
      hcsAnchored: !!certificate.hcsTransactionId,
    });

    res.json({ success: true, data: certificate, timestamp: Date.now() });
  } catch (err) {
    logger.error('Dashboard audit error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Audit failed', timestamp: Date.now() });
  }
});

// ─── PATCH /v1/agents/my/:id/listing ──────────────────────────────────────────
router.patch('/my/:id/listing', requireAuth, (req, res) => {
  const user = (req as AuthRequest).user!;
  try {
    const { public_listing } = req.body;
    if (typeof public_listing !== 'boolean') {
      res.status(400).json({ success: false, error: 'public_listing must be a boolean', timestamp: Date.now() });
      return;
    }
    const updated = toggleAgentPublicListing(req.params.id, user.sub, public_listing);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Agent not found', timestamp: Date.now() });
      return;
    }
    res.json({ success: true, data: { public_listing }, timestamp: Date.now() });
  } catch (err) {
    logger.error('Toggle listing error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Failed to update listing', timestamp: Date.now() });
  }
});

// ─── GET /v1/agents/public ────────────────────────────────────────────────────
// Public endpoint for Borealis Terminal marketplace
router.get('/public', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const agents = getPublicAgents(limit, offset);
    res.json({ success: true, data: agents, timestamp: Date.now() });
  } catch (err) {
    logger.error('Get public agents error', { error: String(err) });
    res.status(500).json({ success: false, error: 'Failed to get public agents', timestamp: Date.now() });
  }
});

export default router;
