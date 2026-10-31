/**
 * Body of a failed HTTP response, for error messages.
 *
 * Ky reads the body of a non-2xx response into `error.data` before it throws,
 * so `error.response.json()` no longer works there. Prefer `data`, and fall
 * back to reading an unconsumed response for errors raised by other code.
 */
export async function httpErrorBody(error: unknown): Promise<unknown> {
  if (!error || typeof error !== 'object') return null;
  if ('data' in error && error.data !== undefined) return error.data;
  if ('response' in error && error.response instanceof Response && !error.response.bodyUsed) {
    const text = await error.response.clone().text().catch(() => '');
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return null;
}

/** `error.message` from a Magnus API error body (`{ error: { message } }`), if present. */
export function apiErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('error' in body)) return undefined;
  const detail = (body as { error: unknown }).error;
  if (detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') return detail.message;
  return undefined;
}
