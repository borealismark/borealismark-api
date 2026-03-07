/**
 * BorealisMark Protocol SDK — HTTP Client
 *
 * Core client class that handles authentication, request/response processing,
 * and error handling. Uses native fetch (Node 18+) — zero dependencies.
 */

import type { BorealisMarkConfig, ApiResponse } from './types';
import {
  BorealisMarkError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from './errors';

const DEFAULT_BASE_URL = 'https://borealismark-api.onrender.com';
const DEFAULT_TIMEOUT = 30_000;
const SDK_VERSION = '1.0.0';

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly customHeaders: Record<string, string>;

  constructor(config: BorealisMarkConfig) {
    if (!config.apiKey) {
      throw new Error('BorealisMark SDK: apiKey is required');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.customHeaders = config.headers ?? {};
  }

  /**
   * Make an authenticated HTTP request to the BorealisMark API.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | undefined>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    // Append query parameters
    if (queryParams) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      'X-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      'User-Agent': `@borealismark/sdk/${SDK_VERSION}`,
      ...this.customHeaders,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseBody = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        parsed = { success: false, error: responseBody };
      }

      if (!response.ok) {
        this.handleError(response.status, parsed, response.headers);
      }

      return (parsed as ApiResponse<T>).data;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof BorealisMarkError) throw err;

      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort')) {
        throw new BorealisMarkError(`Request timed out after ${this.timeout}ms`, 408);
      }
      throw new BorealisMarkError(`Network error: ${message}`, 0);
    }
  }

  private handleError(status: number, body: unknown, headers: Headers): never {
    const errorMessage = (body as { error?: string })?.error ?? 'Unknown error';
    const details = (body as { details?: Record<string, unknown> })?.details;

    switch (status) {
      case 400:
        throw new ValidationError(errorMessage, details ?? {});
      case 401:
        throw new AuthenticationError(errorMessage);
      case 403:
        throw new PermissionError(errorMessage);
      case 404:
        throw new NotFoundError(errorMessage);
      case 429: {
        const limit = parseInt(headers.get('X-RateLimit-Limit') ?? '0', 10);
        const remaining = parseInt(headers.get('X-RateLimit-Remaining') ?? '0', 10);
        const resetsAt = headers.get('X-RateLimit-Reset') ?? '';
        throw new RateLimitError(errorMessage, limit, remaining, resetsAt);
      }
      default:
        throw new BorealisMarkError(errorMessage, status, body);
    }
  }

  /** GET request */
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', path, undefined, params);
  }

  /** POST request */
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** PATCH request */
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  /** DELETE request */
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
