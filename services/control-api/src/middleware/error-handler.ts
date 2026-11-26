import type { Context } from 'hono';
import type { ApiError } from '../types/index.js';
import { redactSecretText } from '../utils/redact.js';
import { containsDatabaseText, databaseFailure } from '../utils/safe-errors.js';

const GENERIC_MESSAGE = 'An unexpected error occurred';

/** Global error handler for Hono — returns structured ApiError JSON. */
export function errorHandler(err: Error, c: Context): Response {
  const database = databaseFailure(err);
  const status = database?.status ?? ('status' in err ? (err as { status: number }).status : 500);
  const code = database?.code ?? ('code' in err ? (err as { code: string }).code : 'INTERNAL_ERROR');

  // Log only the error message and code — never the full error object,
  // which may contain request bodies, tokens, or other secrets.
  const loggedCode = 'code' in err ? (err as { code: string }).code : code;
  console.error(`[ERROR] ${c.req.method} ${c.req.url} [${loggedCode}] ${redactSecretText(err.message)}`);

  // Only an HttpError or a client error (4xx) carries a message meant for the caller. Any other
  // failure can quote paths, addresses or internal state, so its text stays in the log.
  // Database text quotes queries, arguments and addresses, so it never leaves the log either.
  const intended = err instanceof HttpError || (status >= 400 && status < 500);
  const message = database?.message
    ?? (!intended || containsDatabaseText(err.message) ? GENERIC_MESSAGE : redactSecretText(err.message || GENERIC_MESSAGE));
  const details = err instanceof HttpError ? err.details : undefined;
  const body: ApiError = { success: false, error: { code: String(code), message, ...(details ? { details } : {}) } };

  return c.json(body, status as 400);
}

/** Throw an HTTP error with a code. */
export class HttpError extends Error {
  status: number;
  code: string;
  /** Structured, non-secret detail for the client (error.details), such as a preflight report. */
  details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
