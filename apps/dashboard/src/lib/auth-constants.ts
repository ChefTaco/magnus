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

export const LEGACY_SESSION_SECRET_MIGRATION_DEADLINE = '2026-10-01T00:00:00.000Z';
let legacyWarningEmitted = false;

export function sessionSecretDiagnostics(now = Date.now()): {
  configured: boolean;
  source: 'dedicated' | 'legacy_jwt_secret' | 'missing';
  legacyFallbackActive: boolean;
  legacyFallbackAllowed: boolean;
  migrationDeadline: string;
} {
  const dedicated = Boolean(process.env['SESSION_SECRET']);
  const legacyAvailable = Boolean(process.env['JWT_SECRET']);
  const legacyOptIn = process.env['ALLOW_LEGACY_SESSION_SECRET'] === 'true';
  const deadlinePassed = now >= Date.parse(LEGACY_SESSION_SECRET_MIGRATION_DEADLINE);
  return {
    configured: dedicated || (legacyAvailable && legacyOptIn && !deadlinePassed),
    source: dedicated ? 'dedicated' : legacyAvailable && legacyOptIn && !deadlinePassed ? 'legacy_jwt_secret' : 'missing',
    legacyFallbackActive: !dedicated && legacyAvailable && legacyOptIn && !deadlinePassed,
    legacyFallbackAllowed: legacyOptIn && !deadlinePassed,
    migrationDeadline: LEGACY_SESSION_SECRET_MIGRATION_DEADLINE,
  };
}

/** Derive the HS256 signing key from the dedicated dashboard secret. */
export function getSecretKey(): Uint8Array {
  let secret = process.env['SESSION_SECRET'];
  const diagnostics = sessionSecretDiagnostics();
  if (!secret && diagnostics.legacyFallbackActive) {
    secret = process.env['JWT_SECRET'];
    if (!legacyWarningEmitted) {
      legacyWarningEmitted = true;
      console.error(`[SECURITY:HIGH] ALLOW_LEGACY_SESSION_SECRET=true is reusing JWT_SECRET for dashboard sessions; migrate before ${LEGACY_SESSION_SECRET_MIGRATION_DEADLINE}`);
    }
  }
  if (!secret) {
    if (process.env['JWT_SECRET'] && process.env['ALLOW_LEGACY_SESSION_SECRET'] !== 'true') {
      throw new Error('SESSION_SECRET is required; JWT_SECRET fallback requires ALLOW_LEGACY_SESSION_SECRET=true.');
    }
    throw new Error(`SESSION_SECRET is required; legacy fallback expires ${LEGACY_SESSION_SECRET_MIGRATION_DEADLINE}.`);
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
