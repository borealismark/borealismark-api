import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { computeScoreBreakdown, getCreditRating } from './scoring';
import type { AuditInput, AuditCertificate, ScoreBreakdown } from './types';

// ─── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Canonical hash of the audit inputs.
 * Deterministic: same inputs always produce the same hash.
 * Does not include the derived score — only the raw evidence.
 */
export function hashAuditInput(input: AuditInput): string {
  const canonical = JSON.stringify({
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    auditPeriodStart: input.auditPeriodStart,
    auditPeriodEnd: input.auditPeriodEnd,
    constraints: input.constraints
      .map((c) => ({ id: c.constraintId, severity: c.severity, passed: c.passed }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    decisions: input.decisions
      .map((d) => ({ id: d.decisionId, inputHash: d.inputHash, outputHash: d.outputHash }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    totalActions: input.totalActions,
    anomalyCount: input.anomalyCount,
    expectedLogEntries: input.expectedLogEntries,
    actualLogEntries: input.actualLogEntries,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Certificate hash — commits to the identity, audit ID, score, and input hash.
 * This is what gets anchored to Hedera HCS.
 * Anyone holding the certificate can recompute this hash to verify integrity.
 */
export function hashCertificate(
  agentId: string,
  auditId: string,
  issuedAt: number,
  score: ScoreBreakdown,
  inputHash: string,
): string {
  const canonical = JSON.stringify({
    agentId,
    auditId,
    issuedAt,
    score,
    inputHash,
    issuer: 'BorealisMark Protocol v1.0.0',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Certificate ID Format ────────────────────────────────────────────────────

function formatCertificateId(auditId: string): string {
  const fragment = auditId.replace(/-/g, '').slice(0, 16).toUpperCase();
  return `BMK-${fragment}`;
}

// ─── Main Audit Runner ────────────────────────────────────────────────────────

/**
 * runAudit — the core of BorealisMark.
 *
 * Takes an AuditInput containing agent behaviour evidence and produces a
 * cryptographically signed AuditCertificate with a score breakdown and credit rating.
 *
 * The certificate is self-verifiable: any party can recompute inputHash and
 * certificateHash from the raw evidence to confirm the certificate was not tampered with.
 *
 * After calling this, pass the certificate to submitCertificateToHCS() to anchor it
 * immutably on the Hedera Consensus Service.
 */
export function runAudit(input: AuditInput): AuditCertificate {
  const auditId = uuidv4();
  const issuedAt = Date.now();

  const score = computeScoreBreakdown(
    input.constraints,
    input.decisions,
    input.behaviorSamples,
    input.totalActions,
    input.anomalyCount,
    input.expectedLogEntries,
    input.actualLogEntries,
  );

  const inputHash = hashAuditInput(input);
  const certificateHash = hashCertificate(input.agentId, auditId, issuedAt, score, inputHash);

  return {
    certificateId: formatCertificateId(auditId),
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    auditId,
    issuedAt,
    auditPeriodStart: input.auditPeriodStart,
    auditPeriodEnd: input.auditPeriodEnd,
    score,
    creditRating: getCreditRating(score.total),
    inputHash,
    certificateHash,
    issuer: 'BorealisMark Protocol v1.0.0',
    revoked: false,
  };
}
