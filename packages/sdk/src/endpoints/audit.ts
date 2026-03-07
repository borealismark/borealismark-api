/**
 * Audit submission endpoint.
 */

import type { HttpClient } from '../client';
import type { AuditInput, Certificate } from '../types';

export class AuditEndpoint {
  constructor(private readonly client: HttpClient) {}

  /** Submit a full audit and receive a certificate. */
  async submit(input: AuditInput): Promise<Certificate> {
    return this.client.post('/v1/agents/audit', input);
  }
}
