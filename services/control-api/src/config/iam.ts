/**
 * Hive IAM is the RS256 trust anchor when `IAM_CORE_URL` is set: Magnus fetches the key that signs
 * every access token from it, so the URL must be HTTPS. Cleartext is accepted only for a loopback
 * host, or anywhere when the development-only `ALLOW_INSECURE_HTTP` is on (refused in production).
 */

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Why `raw` is not an acceptable `IAM_CORE_URL`, or null when it is. */
export function iamCoreUrlProblem(raw: string, allowInsecureHttp: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'IAM_CORE_URL must be a URL';
  }
  if (url.username || url.password) return 'IAM_CORE_URL must not contain credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && (allowInsecureHttp || isLoopbackHostname(url.hostname))) return null;
  return 'IAM_CORE_URL must use HTTPS (HTTP is accepted only for a loopback host or with ALLOW_INSECURE_HTTP=true in development)';
}
