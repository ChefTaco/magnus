import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';

const ROLES = ['VIEWER', 'OPERATOR', 'ADMIN'] as const;
const FINGERPRINT = 'fixture-key-fingerprint';

vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async (original) => ({ ...await original<object>(),
  JWT_SECRET: 'hermes-secrets-jwt-fixture-at-least-32-characters', API_SECRET: 'hermes-secrets-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '' }));
const profile = { id: 'profile-1', installationId: 'install-1', name: 'default', apiServerKeyFingerprint: FINGERPRINT };
vi.mock('../db/index.js', () => ({ getDb: () => ({ hermesProfile: { findUnique: async () => null } }) }));
vi.mock('../services/hermes-service.js', async (original) => {
  const actual = await original<typeof import('../services/hermes-service.js')>();
  return { ...actual,
    listHermesInstallations: async () => [{ id: 'install-1', profiles: [profile] }],
    getHermesInstallation: async () => ({ id: 'install-1', profiles: [profile] }),
    listHermesProfiles: async () => [profile],
    // Known profile from the fixture; any other id reaches the real lookup (the database has none).
    getHermesApiServerStatus: async (id: string) => id === 'profile-1'
      ? { profileId: 'profile-1', enabled: true, keyFingerprint: FINGERPRINT }
      : actual.getHermesApiServerStatus(id),
  };
});

const { hermesRouter } = await import('./hermes.js');
const { signUserToken } = await import('../middleware/auth.js');
const app = new Hono().onError(errorHandler).route('/hermes', hermesRouter);

const PATHS = ['/hermes/installations', '/hermes/installations/install-1', '/hermes/installations/install-1/profiles', '/hermes/profiles', '/hermes/profiles/profile-1/api-server/status'];

describe.each(ROLES)('Hermes API-server key fingerprints as %s', (role) => {
  it.each(PATHS)('%s', async (path) => {
    const token = await signUserToken({ userId: role, email: 'alice@example.com', role });
    const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.includes(FINGERPRINT)).toBe(role === 'ADMIN');
    expect(text).toMatch(/"(?:apiServerKeyConfigured|keyConfigured)":true/u);
  });
});

describe('Hermes API-server status for an unknown profile', () => {
  it('answers 404 NOT_FOUND, not 500', async () => {
    const token = await signUserToken({ userId: 'VIEWER', email: 'alice@example.com', role: 'VIEWER' });
    const response = await app.request('/hermes/profiles/no-such-profile/api-server/status', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Hermes profile not found' } });
  });
});
