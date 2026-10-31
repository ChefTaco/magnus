import { describe, expect, it, vi } from 'vitest';
import * as jose from 'jose';
import type { Context, Next } from 'hono';

vi.mock('../utils/env.js', () => ({
  JWT_SECRET: '', API_SECRET: 'test-api-secret-for-unit-tests-at-least-32',
  IAM_CORE_URL: 'https://iam.example.test', IAM_TOKEN_ISSUER: 'hive-iam', IAM_TOKEN_AUDIENCE: 'magnus',
  MAGNUS_COLLECTOR_TOKEN_SHA256: '', MAGNUS_PLUGIN_API_ENABLED: true, MAGNUS_APPROVAL_BRIDGE_CONSUMER: '', MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: '{}',
  MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: '', MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: '',
  MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON: '{}', MAGNUS_FLEET_CHECK_TOKEN_SHA256: '',
}));
vi.mock('../services/credential-rotation-service.js', () => ({ verifyWithRotation: () => false }));

const { authMiddleware } = await import('./auth.js');

function context(token: string): Context {
  const store = new Map<string, unknown>();
  return {
    req: { header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined),
      method: 'GET', path: '/api/v1/nodes', url: 'https://magnus.test/api/v1/nodes' },
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
    var: new Proxy({}, { get: (_target, prop: string) => store.get(prop) }),
  } as unknown as Context;
}

describe('IAM public-key refresh', () => {
  it('does not refetch the key for every failed verification', async () => {
    const { publicKey } = await jose.generateKeyPair('RS256');
    const pem = await jose.exportSPKI(publicKey);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ publicKey: pem }), { status: 200 }));
    const next = vi.fn() as unknown as Next;
    for (let index = 0; index < 5; index++) {
      await expect(authMiddleware(context(`forged.token.${index}`), next)).rejects.toThrow(/Invalid or expired IAM token/);
    }
    // One initial fetch plus at most one rate-limited rotation refresh.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2);
    fetchSpy.mockRestore();
  });
});
