/**
 * Request body / query parsing with Zod schemas.
 *
 * Usage:
 *   const body = await parseBody(c, mySchema);
 *   // body is fully typed & validated
 */

import type { Context } from 'hono';
import type { ZodTypeAny, ZodError } from 'zod';
import { HttpError } from '../middleware/error-handler.js';

/** Format Zod issues into a human-readable string. */
function formatZodError(error: ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length ? `${i.path.join('.')}: ` : '';
      return `${path}${i.message}`;
    })
    .join('; ');
}

/**
 * Parse and validate the JSON request body against a Zod schema.
 * Throws HttpError 400 with a machine-readable VALIDATION_ERROR code.
 */
export async function parseBody<S extends ZodTypeAny>(c: Context, schema: S): Promise<S['_output']> {
  const raw = await c.req.json();
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(400, 'VALIDATION_ERROR', formatZodError(result.error));
  }
  return result.data;
}

/**
 * Parse and validate an arbitrary value (e.g. upstream response) against a Zod schema.
 * Returns `{ success: true, data }` or `{ success: false, error }`.
 */
export function safeParse<S extends ZodTypeAny>(
  value: unknown,
  schema: S,
): { success: true; data: S['_output'] } | { success: false; error: string } {
  const result = schema.safeParse(value);
  if (!result.success) {
    return { success: false, error: formatZodError(result.error) };
  }
  return { success: true, data: result.data };
}
