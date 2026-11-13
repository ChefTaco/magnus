import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison to prevent timing attacks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to avoid leaking length information via timing
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Whether `token` is the credential whose SHA-256 digest (lowercase hex) is configured. An unset
 * digest or an empty token never matches, so a missing setting cannot open a route.
 */
export function matchesSha256Digest(token: string, expectedDigest: string | undefined): boolean {
  if (!expectedDigest || !token) return false;
  return safeEqual(createHash('sha256').update(token).digest('hex'), expectedDigest);
}
