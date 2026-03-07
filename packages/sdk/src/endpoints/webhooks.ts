/**
 * Webhook management endpoints.
 */

import type { HttpClient } from '../client';
import type { Webhook, RegisterWebhookInput, WebhookWithSecret } from '../types';

export class WebhooksEndpoint {
  constructor(private readonly client: HttpClient) {}

  /** Register a new webhook endpoint. Secret is returned once. */
  async register(input: RegisterWebhookInput): Promise<WebhookWithSecret> {
    return this.client.post('/v1/webhooks', {
      url: input.url,
      events: input.events,
    });
  }

  /** List all registered webhooks. */
  async list(): Promise<Webhook[]> {
    return this.client.get('/v1/webhooks');
  }

  /** Send a test event to a webhook. */
  async test(webhookId: string): Promise<{ message: string }> {
    return this.client.post(`/v1/webhooks/${webhookId}/test`);
  }

  /** Delete a webhook. */
  async delete(webhookId: string): Promise<{ message: string }> {
    return this.client.delete(`/v1/webhooks/${webhookId}`);
  }
}
