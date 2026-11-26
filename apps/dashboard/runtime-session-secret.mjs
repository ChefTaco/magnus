/** The dashboard session signing secret. The JWT_SECRET fallback expired on 2026-10-01 and is gone. */
export function sessionSecretDiagnostics(env = process.env) {
  const dedicated = Boolean(env['SESSION_SECRET']);
  return { configured: dedicated, source: dedicated ? 'dedicated' : 'missing' };
}

export function resolveSessionSecret(env = process.env) {
  if (env['SESSION_SECRET']) return env['SESSION_SECRET'];
  throw new Error(env['JWT_SECRET']
    ? 'SESSION_SECRET is required; the JWT_SECRET session fallback was removed after it expired on 2026-10-01'
    : 'SESSION_SECRET is required');
}
