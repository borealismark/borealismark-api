/**
 * @borealismark/sdk — Official TypeScript SDK
 *
 * Blockchain-Anchored AI Trust Infrastructure on Hedera Hashgraph.
 *
 * @example
 * ```typescript
 * import { BorealisMarkClient } from '@borealismark/sdk';
 *
 * const client = new BorealisMarkClient({ apiKey: 'bm_live_...' });
 *
 * // Register an AI agent
 * const agent = await client.agents.register({
 *   name: 'MyLLM',
 *   version: '1.0.0',
 *   agentType: 'llm',
 * });
 *
 * // Run an audit
 * const cert = await client.audit.submit({
 *   agentId: agent.agentId,
 *   auditPeriod: { start: Date.now() - 86400000, end: Date.now() },
 *   constraints: [
 *     { name: 'Safety Filter', severity: 'critical', passed: true },
 *   ],
 * });
 *
 * console.log(`Score: ${cert.score_total}/1000 — Rating: ${cert.credit_rating}`);
 * ```
 *
 * @packageDocumentation
 */

import type { BorealisMarkConfig } from './types';
import { HttpClient } from './client';
import { AgentsEndpoint } from './endpoints/agents';
import { AuditEndpoint } from './endpoints/audit';
import { KeysEndpoint } from './endpoints/keys';
import { WebhooksEndpoint } from './endpoints/webhooks';
import { NetworkEndpoint } from './endpoints/network';
import { SearchEndpoint } from './endpoints/search';

export class BorealisMarkClient {
  /** Agent registration and management */
  public readonly agents: AgentsEndpoint;
  /** Audit submission */
  public readonly audit: AuditEndpoint;
  /** API key management */
  public readonly keys: KeysEndpoint;
  /** Webhook registration and management */
  public readonly webhooks: WebhooksEndpoint;
  /** Network statistics */
  public readonly network: NetworkEndpoint;
  /** Agent search */
  public readonly search: SearchEndpoint;

  constructor(config: BorealisMarkConfig) {
    const client = new HttpClient(config);
    this.agents = new AgentsEndpoint(client);
    this.audit = new AuditEndpoint(client);
    this.keys = new KeysEndpoint(client);
    this.webhooks = new WebhooksEndpoint(client);
    this.network = new NetworkEndpoint(client);
    this.search = new SearchEndpoint(client);
  }
}

// Re-export everything
export * from './types';
export * from './errors';
export { HttpClient } from './client';
