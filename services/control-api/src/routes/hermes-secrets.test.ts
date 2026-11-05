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
vi.mock('../services/hermes-service.js', async (original) => ({ ...await original<object>(),
  listHermesInstallations: async () => [{ id: 'install-1', profiles: [profile] }],
  getHermesInstallation: async () => ({ id: 'install-1', profiles: [profile] }),
  listHermesProfiles: async () => [profile],
  getHermesApiServerStatus: async () => ({ profileId: 'profile-1', enabled: true, keyFingerprint: FINGERPRINT }),
}));

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
