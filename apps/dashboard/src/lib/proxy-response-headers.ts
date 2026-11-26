/**
 * Response headers relayed from the Control API. The upstream's content
 * isolation headers must survive the hop: agent-produced artifact bytes are
 * served with `Content-Security-Policy: default-src 'none'; sandbox` and
 * `Content-Disposition: attachment`, and dropping them would let that content
 * render as a page of the console origin.
 */
export const PROXIED_RESPONSE_HEADERS = [
  'content-security-policy',
  'content-disposition',
  'x-content-type-options',
  'cache-control',
  'content-range',
  'accept-ranges',
  'etag',
  'repr-digest',
  'x-content-sha256',
] as const;

export function proxiedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers({
    'content-type': upstream.get('content-type') ?? 'application/json',
    'x-content-type-options': 'nosniff',
  });
  for (const key of PROXIED_RESPONSE_HEADERS) {
    const value = upstream.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
}
