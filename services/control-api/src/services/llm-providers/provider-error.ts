import type { ProviderId } from './types.js';

export type LlmProviderErrorKind =
  | 'configuration'
  | 'authentication'
  | 'rate_limit'
  | 'connectivity'
  | 'server'
  | 'bad_request'
  | 'unsupported'
  | 'unknown';

export class LlmProviderError extends Error {
  constructor(
    public readonly providerId: ProviderId,
    public readonly kind: LlmProviderErrorKind,
    message: string,
    public readonly retryable = false,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export function normalizeProviderError(providerId: ProviderId, error: unknown): LlmProviderError {
  if (error instanceof LlmProviderError) {
    return error;
  }

  if (error instanceof Error) {
    return new LlmProviderError(providerId, 'unknown', error.message, false);
  }

  return new LlmProviderError(providerId, 'unknown', 'Unknown LLM provider error', false);
}

export function createHttpProviderError(
  providerId: ProviderId,
  status: number,
  message: string,
): LlmProviderError {
  if (status === 401 || status === 403) {
    return new LlmProviderError(providerId, 'authentication', message, false, status);
  }
  if (status === 429) {
    return new LlmProviderError(providerId, 'rate_limit', message, true, status);
  }
  if (status >= 500) {
    return new LlmProviderError(providerId, 'server', message, true, status);
  }
  return new LlmProviderError(providerId, 'bad_request', message, false, status);
}
