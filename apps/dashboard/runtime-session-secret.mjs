export const LEGACY_SESSION_SECRET_MIGRATION_DEADLINE = '2026-10-01T00:00:00.000Z';
let warned = false;

export function sessionSecretDiagnostics(env = process.env, now = Date.now()) {
  const dedicated = Boolean(env['SESSION_SECRET']);
  const legacyAvailable = Boolean(env['JWT_SECRET']);
  const legacyOptIn = env['ALLOW_LEGACY_SESSION_SECRET'] === 'true';
  const deadlinePassed = now >= Date.parse(LEGACY_SESSION_SECRET_MIGRATION_DEADLINE);
  return {
    configured: dedicated || (legacyAvailable && legacyOptIn && !deadlinePassed),
    source: dedicated ? 'dedicated' : legacyAvailable && legacyOptIn && !deadlinePassed ? 'legacy_jwt_secret' : 'missing',
    legacyFallbackActive: !dedicated && legacyAvailable && legacyOptIn && !deadlinePassed,
    legacyFallbackAllowed: legacyOptIn && !deadlinePassed,
    migrationDeadline: LEGACY_SESSION_SECRET_MIGRATION_DEADLINE,
  };
}

export function resolveSessionSecret(env = process.env, now = Date.now()) {
  if (env['SESSION_SECRET']) return env['SESSION_SECRET'];
  const diagnostics = sessionSecretDiagnostics(env, now);
  if (diagnostics.legacyFallbackActive) {
    if (!warned) {
      warned = true;
      console.error(`[SECURITY:HIGH] ALLOW_LEGACY_SESSION_SECRET=true is reusing JWT_SECRET for dashboard sessions; migrate before ${LEGACY_SESSION_SECRET_MIGRATION_DEADLINE}`);
    }
    return env['JWT_SECRET'];
  }
  if (env['JWT_SECRET'] && env['ALLOW_LEGACY_SESSION_SECRET'] !== 'true') {
    throw new Error('SESSION_SECRET is required; JWT_SECRET fallback requires ALLOW_LEGACY_SESSION_SECRET=true');
  }
  if (env['JWT_SECRET']) throw new Error(`Legacy JWT_SECRET session fallback expired on ${LEGACY_SESSION_SECRET_MIGRATION_DEADLINE}`);
  throw new Error('SESSION_SECRET is required');
}
