/**
 * API key management endpoints.
 */

import type { HttpClient } from '../client';
import type { ApiKey, CreateKeyInput, CreatedKey } from '../types';

export class KeysEndpoint {
  constructor(private readonly client: HttpClient) {}

  /** Create a new API key. Raw key is returned once. */
  async create(input: CreateKeyInput): Promise<CreatedKey> {
    return this.client.post('/v1/keys', input);
  }

  /** List all API keys (excluding raw values). */
  async list(): Promise<ApiKey[]> {
    return this.client.get('/v1/keys');
  }

  /** Revoke an API key. */
  async revoke(keyId: string, reason?: string): Promise<{ message: string }> {
    return this.client.delete(`/v1/keys/${keyId}`);
  }
}
