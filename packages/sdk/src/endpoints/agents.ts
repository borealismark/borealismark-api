/**
 * Agent management endpoints.
 */

import type { HttpClient } from '../client';
import type {
  Agent,
  RegisterAgentInput,
  UpdateAgentInput,
  PublicAgent,
  Certificate,
} from '../types';

export class AgentsEndpoint {
  constructor(private readonly client: HttpClient) {}

  /** Register a new AI agent. */
  async register(input: RegisterAgentInput): Promise<{ agentId: string; agent: Agent }> {
    return this.client.post('/v1/agents/register', {
      name: input.name,
      description: input.description ?? '',
      version: input.version,
    });
  }

  /** Get agent details by ID. */
  async get(agentId: string): Promise<Agent> {
    return this.client.get(`/v1/agents/${agentId}/score`);
  }

  /** Get agent's latest certificate. */
  async getCertificate(agentId: string): Promise<Certificate> {
    return this.client.get(`/v1/agents/${agentId}/certificate`);
  }

  /** List publicly listed agents. */
  async listPublic(limit = 50, offset = 0): Promise<PublicAgent[]> {
    return this.client.get('/v1/agents/public', { limit, offset });
  }
}
