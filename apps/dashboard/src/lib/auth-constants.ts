/**
 * Auth constants shared between Next.js middleware and server-side auth utilities.
 *
 * Kept in a separate module so that the Edge-runtime middleware can import
 * without pulling in Node.js-only code from `lib/auth.ts`.
 */
import { readDashboardEnvironment } from '../../runtime-environment.mjs';

export const COOKIE_NAME = 'magnus_session';
export const SESSION_DURATION = 24 * 60 * 60; // 24 hours in seconds
export const SESSION_ALGORITHMS = ['HS256'] as const;
export const SESSION_ISSUER = readDashboardEnvironment('SESSION_ISSUER') as string;
export const SESSION_AUDIENCE = readDashboardEnvironment('SESSION_AUDIENCE') as string;

/** The JWT_SECRET session fallback expired on 2026-10-01 and is gone: SESSION_SECRET is required. */
export function sessionSecretDiagnostics(): { configured: boolean; source: 'dedicated' | 'missing' } {
  const dedicated = Boolean(process.env['SESSION_SECRET']);
  return { configured: dedicated, source: dedicated ? 'dedicated' : 'missing' };
}

/** Derive the HS256 signing key from the dedicated dashboard secret. */
export function getSecretKey(): Uint8Array {
  const secret = process.env['SESSION_SECRET'];
  if (!secret) {
    throw new Error(process.env['JWT_SECRET']
      ? 'SESSION_SECRET is required; the JWT_SECRET session fallback was removed after it expired on 2026-10-01.'
      : 'SESSION_SECRET is required.');
  }
  return new TextEncoder().encode(secret);
}

export function sessionVerificationOptions(): {
  algorithms: ['HS256'];
  issuer: string;
  audience: string;
} {
  return {
    algorithms: ['HS256'],
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  };
}
