import { describe, expect, it, vi } from 'vitest';
import * as jose from 'jose';
import type { Context, Next } from 'hono';

// IAM_CORE_URL is still present in the environment: 4.0.0 must neither honour it nor fetch a key.
vi.mock('../utils/env.js', () => ({
  JWT_SECRET: 'fixture-jwt-secret-for-unit-tests-at-least-32', API_SECRET: 'fixture-api-secret-for-unit-tests-at-least-32',
  IAM_CORE_URL: 'https://iam.example.test', IAM_TOKEN_ISSUER: 'iam', IAM_TOKEN_AUDIENCE: 'magnus',
  MAGNUS_COLLECTOR_TOKEN_SHA256: '', MAGNUS_PLUGIN_API_ENABLED: false, MAGNUS_APPROVAL_BRIDGE_CONSUMER: '', MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: '{}',
  MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: '', MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: '',
  MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON: '{}', MAGNUS_FLEET_CHECK_TOKEN_SHA256: '',
}));
vi.mock('../services/credential-rotation-service.js', () => ({ verifyWithRotation: () => false }));
vi.mock('./user-status.js', () => ({ getCurrentUserStatus: vi.fn(async () => ({ active: true, role: 'ADMIN' })), invalidateUserStatus: vi.fn() }));

const auth = await import('./auth.js');

function context(token: string): Context {
  const store = new Map<string, unknown>();
  return {
    req: { header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined),
      method: 'GET', path: '/api/v1/nodes', url: 'https://magnus.example.com/api/v1/nodes' },
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
    var: new Proxy({}, { get: (_target, prop: string) => store.get(prop) }),
  } as unknown as Context;
}

describe('removed external IAM mode', () => {
  it('refuses an RS256 IAM-style access token without fetching any key', async () => {
    const { privateKey } = await jose.generateKeyPair('RS256');
    const token = await new jose.SignJWT({ roles: ['SUPER_ADMIN'], email: 'alice@example.com' })
      .setProtectedHeader({ alg: 'RS256' }).setSubject('user-1').setIssuer('iam').setAudience('magnus')
      .setJti('jti-1').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const next = vi.fn() as unknown as Next;
    await expect(auth.authMiddleware(context(token), next)).rejects.toThrow(/Invalid or expired token/);
    expect(next).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('no longer exports the IAM role mapping', () => {
    expect('mapIamRoles' in auth).toBe(false);
  });
});
