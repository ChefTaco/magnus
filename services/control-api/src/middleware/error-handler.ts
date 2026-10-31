import type { Context } from 'hono';
import type { ApiError } from '../types/index.js';
import { redactSecretText } from '../utils/redact.js';

/** Global error handler for Hono — returns structured ApiError JSON. */
export function errorHandler(err: Error, c: Context): Response {
  const status = 'status' in err ? (err as { status: number }).status : 500;
  const code = 'code' in err ? (err as { code: string }).code : 'INTERNAL_ERROR';

  // Log only the error message and code — never the full error object,
  // which may contain request bodies, tokens, or other secrets.
  console.error(`[ERROR] ${c.req.method} ${c.req.url} [${code}] ${redactSecretText(err.message)}`);

  const body: ApiError = {
    success: false,
    error: {
      code: String(code),
      message: redactSecretText(err.message || 'An unexpected error occurred'),
    },
  };

  return c.json(body, status as 400);
}

/** Throw an HTTP error with a code. */
export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
