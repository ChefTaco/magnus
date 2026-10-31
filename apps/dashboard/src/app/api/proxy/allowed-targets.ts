/**
 * Proxy target allowlist — validates that x-proxy-target URLs match a known
 * control node or the default local API.
 *
 * Prevents SSRF by ensuring the dashboard proxy only forwards requests to
 * configured control-node URLs.
 */

import { resolveControlNodeTarget } from '@/lib/control-node-server';

/** Blocked IP patterns (metadata services, link-local). */
const BLOCKED_PATTERNS = [
  /^169\.254\./,       // AWS/Azure metadata link-local
  /^127\./,            // Loopback — only allowed explicitly via localhost
  /^0\./,              // Non-routable
  /^10\.0\.0\.1$/,     // Common gateway
  /^metadata\./i,      // Cloud metadata hostnames
  /^instance-data\./i, // Cloud metadata hostnames
];

/** Check if a hostname is a cloud metadata / dangerous target. */
function isBlockedHost(hostname: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(hostname));
}

/**
 * Validate a proxy target URL against the allowlist.
 *
 * Returns server-only credential headers for an exact configured origin.
 * or `{ allowed: false, reason: string }`.
 */
export async function validateProxyTarget(
  targetBase: string,
): Promise<
  | { allowed: true; baseUrl: string; credentialHeaders: Record<string, string> }
  | { allowed: false; reason: string }
> {
  // 1. Must be a valid URL
  let parsed: URL;
  try {
    parsed = new URL(targetBase);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  // 2. Must use HTTPS (unless explicitly localhost for dev)
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')
  ) {
    return { allowed: false, reason: 'Only HTTPS targets are allowed' };
  }

  // 3. Block cloud metadata / dangerous IPs
  if (isBlockedHost(parsed.hostname)) {
    return { allowed: false, reason: 'Target host is blocked' };
  }

  // 4. Must match the canonical CONTROL_API_URL origin or a configured node
  // with its own server-side credential. Resolution occurs before any fetch.
  try {
    const resolved = await resolveControlNodeTarget(targetBase);
    return {
      allowed: true,
      baseUrl: resolved.baseUrl,
      credentialHeaders: resolved.credentialHeaders,
    };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : 'Target is unavailable' };
  }
}
