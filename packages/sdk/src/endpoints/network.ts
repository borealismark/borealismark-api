/**
 * Network statistics endpoints.
 */

import type { HttpClient } from '../client';
import type { NetworkStats } from '../types';

export class NetworkEndpoint {
  constructor(private readonly client: HttpClient) {}

  /** Get network consensus statistics. */
  async consensus(): Promise<NetworkStats> {
    return this.client.get('/v1/network/consensus');
  }

  /** Get network topology. */
  async topology(): Promise<unknown> {
    return this.client.get('/v1/network/topology');
  }
}
