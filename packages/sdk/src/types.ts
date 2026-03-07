/**
 * BorealisMark Protocol SDK — Type Definitions
 *
 * All TypeScript interfaces for API request/response types.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

export interface BorealisMarkConfig {
  /** API key for authentication (starts with 'bm_live_' or 'bm_test_') */
  apiKey: string;
  /** Base URL override (default: https://borealismark-api.onrender.com) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Custom headers to include with every request */
  headers?: Record<string, string>;
}

// ─── API Response Wrapper ─────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  timestamp?: number;
}

export interface ApiError {
  success: false;
  error: string;
  details?: Record<string, unknown>;
  timestamp?: number;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  tier: 'standard' | 'pro' | 'elite';
  role: 'user' | 'admin';
  createdAt: number;
  lastLoginAt: number | null;
}

// ─── Agents ───────────────────────────────────────────────────────────────────

export type AgentType = 'llm' | 'image' | 'audio' | 'code' | 'other';

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  version: string;
  agent_type: AgentType;
  registered_at: number;
  active: number;
  public_listing: number;
  owner_user_id: string | null;
}

export interface RegisterAgentInput {
  name: string;
  description?: string;
  version: string;
  agentType?: AgentType;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  version?: string;
  agent_type?: AgentType;
}

export interface PublicAgent extends Agent {
  score_total: number | null;
  credit_rating: string | null;
  certificate_id: string | null;
  last_audit_at: number | null;
}

// ─── Certificates & Audits ────────────────────────────────────────────────────

export interface Certificate {
  certificate_id: string;
  agent_id: string;
  agent_version: string;
  audit_id: string;
  issued_at: number;
  audit_period_start: number;
  audit_period_end: number;
  score_total: number;
  score_json: string;
  credit_rating: CreditRating;
  input_hash: string;
  certificate_hash: string;
  hcs_topic_id: string | null;
  hcs_transaction_id: string | null;
  hcs_sequence_number: number | null;
  hcs_consensus_timestamp: string | null;
  revoked: number;
}

export type CreditRating = 'AAA+' | 'AAA' | 'AA' | 'A' | 'B+' | 'B' | 'C' | 'D' | 'F' | 'FLAGGED';

export interface ScoreBreakdown {
  constraintAdherence: { score: number; max: 350; details: string };
  decisionTransparency: { score: number; max: 200; details: string };
  behavioralConsistency: { score: number; max: 200; details: string };
  anomalyRate: { score: number; max: 150; details: string };
  auditCompleteness: { score: number; max: 100; details: string };
}

export interface AuditConstraint {
  name: string;
  description?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  passed: boolean;
}

export interface AuditInput {
  agentId: string;
  auditPeriod: { start: number; end: number };
  constraints: AuditConstraint[];
  behaviorStats?: {
    totalActions: number;
    anomalyCount: number;
  };
  logEntries?: Array<{
    timestamp: number;
    action: string;
    details?: string;
  }>;
}

// ─── Staking ──────────────────────────────────────────────────────────────────

export interface Stake {
  id: string;
  agent_id: string;
  bmt_amount: number;
  usdc_coverage: number;
  tier: string;
  allocated_at: number;
  active: number;
}

export interface StakeInput {
  agentId: string;
  bmtAmount: number;
  usdcCoverage?: number;
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export type WebhookEvent =
  | 'audit.completed'
  | 'audit.anchored'
  | 'score.degraded'
  | 'score.improved'
  | 'stake.allocated'
  | 'slash.executed'
  | 'agent.registered'
  | 'key.revoked'
  | 'webhook.test';

export interface Webhook {
  id: string;
  url: string;
  events: string;
  active: number;
  created_at: number;
  last_delivery_at: number | null;
  failure_count: number;
}

export interface RegisterWebhookInput {
  url: string;
  events: WebhookEvent[];
}

export interface WebhookWithSecret extends Webhook {
  secret: string;
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

export type ApiKeyScope = 'audit' | 'read' | 'webhook' | 'admin';

export interface ApiKey {
  id: string;
  name: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  usage_count: number;
  expires_at: number | null;
  revoked: number;
}

export interface CreateKeyInput {
  name: string;
  scopes?: ApiKeyScope[];
  expiresIn?: string;
}

export interface CreatedKey extends ApiKey {
  rawKey: string;
}

// ─── Network ──────────────────────────────────────────────────────────────────

export interface NetworkStats {
  totalAgents: number;
  totalCertificates: number;
  totalStaked: number;
  averageScore: number;
  networkTier: string;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface SearchAgentsInput {
  query?: string;
  minScore?: number;
  maxScore?: number;
  agentType?: AgentType;
  limit?: number;
  offset?: number;
}

// ─── API Tiers ────────────────────────────────────────────────────────────────

export interface ApiTier {
  name: string;
  displayName: string;
  monthlyRequestLimit: number;
  maxAgents: number | 'Unlimited';
  maxWebhooks: number | 'Unlimited';
  rateLimitPerMin: number;
  priceMonthly: number;
  stripePriceId: string | null;
}
