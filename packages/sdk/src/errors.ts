/**
 * BorealisMark Protocol SDK — Error Classes
 */

export class BorealisMarkError extends Error {
  public readonly statusCode: number;
  public readonly response: unknown;

  constructor(message: string, statusCode: number, response?: unknown) {
    super(message);
    this.name = 'BorealisMarkError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

export class AuthenticationError extends BorealisMarkError {
  constructor(message = 'Invalid or missing API key') {
    super(message, 401);
    this.name = 'AuthenticationError';
  }
}

export class PermissionError extends BorealisMarkError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403);
    this.name = 'PermissionError';
  }
}

export class NotFoundError extends BorealisMarkError {
  constructor(message = 'Resource not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends BorealisMarkError {
  public readonly limit: number;
  public readonly remaining: number;
  public readonly resetsAt: string;

  constructor(
    message = 'Rate limit exceeded',
    limit = 0,
    remaining = 0,
    resetsAt = '',
  ) {
    super(message, 429);
    this.name = 'RateLimitError';
    this.limit = limit;
    this.remaining = remaining;
    this.resetsAt = resetsAt;
  }
}

export class ValidationError extends BorealisMarkError {
  public readonly details: Record<string, unknown>;

  constructor(message = 'Validation failed', details: Record<string, unknown> = {}) {
    super(message, 400);
    this.name = 'ValidationError';
    this.details = details;
  }
}
