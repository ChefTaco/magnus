import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSecretKey, sessionSecretDiagnostics } from './auth-constants';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  vi.restoreAllMocks();
});

describe('session secret migration', () => {
  it('requires an explicit flag before reusing JWT_SECRET', () => {
    delete process.env['SESSION_SECRET'];
    process.env['JWT_SECRET'] = 'legacy-secret';
    delete process.env['ALLOW_LEGACY_SESSION_SECRET'];
    expect(() => getSecretKey()).toThrow('requires ALLOW_LEGACY_SESSION_SECRET=true');
  });

  it('reports opt-in legacy reuse as active before the migration deadline', () => {
    const beforeDeadline = Date.parse('2026-09-01T00:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(beforeDeadline);
    delete process.env['SESSION_SECRET'];
    process.env['JWT_SECRET'] = 'legacy-secret';
    process.env['ALLOW_LEGACY_SESSION_SECRET'] = 'true';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(sessionSecretDiagnostics()).toMatchObject({ source: 'legacy_jwt_secret', legacyFallbackActive: true });
    expect(new TextDecoder().decode(getSecretKey())).toBe('legacy-secret');
  });

  it.each(['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'])('rejects legacy reuse at %s', (instant) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(instant));
    delete process.env['SESSION_SECRET'];
    process.env['JWT_SECRET'] = 'legacy-secret';
    process.env['ALLOW_LEGACY_SESSION_SECRET'] = 'true';
    expect(sessionSecretDiagnostics()).toMatchObject({ source: 'missing', configured: false });
    expect(() => getSecretKey()).toThrow('legacy fallback expires');
  });
});
