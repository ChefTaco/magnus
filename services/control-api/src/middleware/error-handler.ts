import type { Context } from 'hono';
import type { ApiError } from '../types/index.js';
import { redactSecretText } from '../utils/redact.js';
import { containsDatabaseText, databaseFailure } from '../utils/safe-errors.js';

/** Global error handler for Hono — returns structured ApiError JSON. */
export function errorHandler(err: Error, c: Context): Response {
  const database = databaseFailure(err);
  const status = database?.status ?? ('status' in err ? (err as { status: number }).status : 500);
  const code = database?.code ?? ('code' in err ? (err as { code: string }).code : 'INTERNAL_ERROR');

  // Log only the error message and code — never the full error object,
  // which may contain request bodies, tokens, or other secrets.
  const loggedCode = 'code' in err ? (err as { code: string }).code : code;
  console.error(`[ERROR] ${c.req.method} ${c.req.url} [${loggedCode}] ${redactSecretText(err.message)}`);

  // Database text quotes queries, arguments and addresses, so it stays in the log.
  const message = database?.message
    ?? (containsDatabaseText(err.message) ? 'An unexpected error occurred' : redactSecretText(err.message || 'An unexpected error occurred'));
  const body: ApiError = { success: false, error: { code: String(code), message } };

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
