/**
 * Agent search endpoints.
 */

import type { HttpClient } from '../client';
import type { PublicAgent, SearchAgentsInput } from '../types';

export class SearchEndpoint {
  constructor(private readonly client: HttpClient) {}

  /** Search for publicly listed agents. */
  async agents(input: SearchAgentsInput = {}): Promise<PublicAgent[]> {
    return this.client.get('/v1/agents/public', {
      query: input.query,
      min_score: input.minScore,
      max_score: input.maxScore,
      agent_type: input.agentType,
      limit: input.limit ?? 50,
      offset: input.offset ?? 0,
    });
  }
}
