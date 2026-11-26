import { afterEach, describe, expect, it } from 'vitest';
import { getSecretKey, sessionSecretDiagnostics } from './auth-constants';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

describe('session secret', () => {
  it('no longer falls back to JWT_SECRET, with or without the retired opt-in', () => {
    delete process.env['SESSION_SECRET'];
    process.env['JWT_SECRET'] = 'legacy-secret';
    process.env['ALLOW_LEGACY_SESSION_SECRET'] = 'true';
    expect(sessionSecretDiagnostics()).toEqual({ configured: false, source: 'missing' });
    expect(() => getSecretKey()).toThrow('JWT_SECRET session fallback was removed');
  });

  it('signs with the dedicated SESSION_SECRET', () => {
    process.env['SESSION_SECRET'] = 'dedicated-session-secret';
    expect(sessionSecretDiagnostics()).toEqual({ configured: true, source: 'dedicated' });
    expect(new TextDecoder().decode(getSecretKey())).toBe('dedicated-session-secret');
  });
});
