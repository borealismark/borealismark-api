// ─── Constraint System ────────────────────────────────────────────────────────

export type ConstraintSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type ViolationType =
  | 'BOUNDARY_BREACH'
  | 'PROMPT_INJECTION'
  | 'DATA_EXFILTRATION'
  | 'SCOPE_CREEP'
  | 'HALLUCINATION'
  | 'AUTHORIZATION_BYPASS'
  | 'RATE_LIMIT_VIOLATION'
  | 'OUTPUT_POLICY_VIOLATION';

export interface ConstraintCheck {
  constraintId: string;
  constraintName: string;
  severity: ConstraintSeverity;
  passed: boolean;
  violationType?: ViolationType;
  metadata?: Record<string, unknown>;
}

// ─── Decision Logs ────────────────────────────────────────────────────────────

export interface DecisionLog {
  decisionId: string;
  timestamp: number;
  inputHash: string;
  outputHash: string;
  hasReasoningChain: boolean;
  reasoningDepth: number; // 0–5, where 5 = full traceable chain
  confidence: number;     // 0–1
  wasOverridden: boolean;
}

// ─── Behavior Samples ─────────────────────────────────────────────────────────

export interface BehaviorSample {
  inputClass: string;
  sampleCount: number;
  outputVariance: number;     // 0–1, where 0 = perfectly consistent
  deterministicRate: number;  // 0–1, where 1 = fully deterministic
}

// ─── Audit Input ──────────────────────────────────────────────────────────────

export interface AuditInput {
  agentId: string;
  agentVersion: string;
  auditPeriodStart: number; // Unix ms
  auditPeriodEnd: number;   // Unix ms
  constraints: ConstraintCheck[];
  decisions: DecisionLog[];
  behaviorSamples: BehaviorSample[];
  totalActions: number;
  anomalyCount: number;
  expectedLogEntries: number;
  actualLogEntries: number;
  auditorId?: string;
}

// ─── Score ────────────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  constraintAdherence: number; // max 350
  decisionTransparency: number; // max 200
  behavioralConsistency: number; // max 200
  anomalyRate: number;           // max 150
  auditCompleteness: number;     // max 100
  total: number;                 // max 1000
}

export type CreditRating =
  | 'AAA+'
  | 'AAA'
  | 'AA+'
  | 'AA'
  | 'A+'
  | 'A'
  | 'BBB+'
  | 'BBB'
  | 'UNRATED'
  | 'FLAGGED';

// ─── Certificate ──────────────────────────────────────────────────────────────

export interface AuditCertificate {
  certificateId: string;
  agentId: string;
  agentVersion: string;
  auditId: string;
  issuedAt: number;
  auditPeriodStart: number;
  auditPeriodEnd: number;
  score: ScoreBreakdown;
  creditRating: CreditRating;
  inputHash: string;
  certificateHash: string;
  issuer: 'BorealisMark Protocol v1.0.0';
  hcsTopicId?: string;
  hcsTransactionId?: string;
  hcsSequenceNumber?: number;
  hcsConsensusTimestamp?: string;
  revoked: boolean;
}

// ─── Trust Deposits ─────────────────────────────────────────────────────────

export type TrustTier =
  | 'UNVERIFIED'
  | 'STARTER_TRUST'
  | 'GROWTH_TRUST'
  | 'ENTERPRISE_TRUST'
  | 'INSTITUTIONAL_TRUST'
  | 'SOVEREIGN_TRUST';

export interface TrustDeposit {
  depositId: string;
  agentId: string;
  usdcAmount: number;
  tier: TrustTier;
  depositedAt: number;
  active: boolean;
}

export interface PenaltyEvent {
  penaltyId: string;
  depositId: string;
  agentId: string;
  violationType: ViolationType;
  amountForfeited: number;
  executedAt: number;
  hcsTransactionId?: string;
}

// ─── Backward Compatibility (Deprecated) ──────────────────────────────────────

/**
 * @deprecated Use PenaltyEvent instead
 */
export type StakeTier =
  | 'NO_COVERAGE'
  | 'STARTUP_SHIELD'
  | 'GROWTH_VAULT'
  | 'ENTERPRISE_FORTRESS'
  | 'INSTITUTIONAL_CITADEL'
  | 'SOVEREIGN_RESERVE';

/**
 * @deprecated Use TrustDeposit instead
 */
export interface StakeAllocation {
  stakeId: string;
  agentId: string;
  bmtAmount: number;
  usdcCoverage: number;
  tier: StakeTier;
  allocatedAt: number;
  active: boolean;
}

/**
 * @deprecated Use PenaltyEvent instead
 */
export interface SlashEvent {
  slashId: string;
  stakeId: string;
  agentId: string;
  violationType: ViolationType;
  amountSlashed: number;
  claimantAddress: string;
  executedAt: number;
  hcsTransactionId?: string;
}

// ─── API Responses ────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}
