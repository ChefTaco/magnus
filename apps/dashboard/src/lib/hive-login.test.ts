import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ values: new Map<string, string>(), verify: vi.fn() }));
vi.mock('ioredis', () => ({
  Redis: class {
    status = 'ready';
    on() {
      return this;
    }
    async set(k: string, v: string) {
      mocks.values.set(k, v);
    }
    async get(k: string) {
      return mocks.values.get(k);
    }
    async getdel(k: string) {
      const v = mocks.values.get(k);
      mocks.values.delete(k);
      return v;
    }
    async del(k: string) {
      mocks.values.delete(k);
    }
  },
}));
vi.mock('jose', () => ({ createRemoteJWKSet: vi.fn(), jwtVerify: mocks.verify }));
vi.mock('./auth-constants', () => ({
  getSecretKey: () => new TextEncoder().encode('dedicated-test-session-encryption-key'),
}));
import {
  beginHiveLogin,
  finishHiveLogin,
  hiveCredential,
  HiveClientRejected,
  revokeHiveSession,
} from './hive-login';
const doc = {
  issuer: 'https://iam.invalid',
  authorization_endpoint: 'https://iam.invalid/authorize',
  token_endpoint: 'https://iam.invalid/token',
  jwks_uri: 'https://iam.invalid/jwks',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.values.clear();
  for (const [key, value] of Object.entries({
    HIVE_OAUTH_DISCOVERY_URL: 'https://iam.invalid/discovery',
    HIVE_OAUTH_CLIENT_ID: 'magnus',
    HIVE_OAUTH_ISSUER: 'https://iam.invalid',
    HIVE_OAUTH_API_AUDIENCE: 'magnus-api',
    DASHBOARD_PUBLIC_ORIGIN: 'https://magnus.invalid',
    CONTROL_API_URL: 'https://api.invalid',
  }))
    vi.stubEnv(key, value);
  mocks.verify.mockResolvedValue({
    payload: { sub: 'named-user', roles: ['OPERATOR'], exp: Math.floor(Date.now() / 1000) + 300 },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith('/token') ? { access_token: 'private-delegated-token' } : doc,
          ),
        ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('named Hive delegation', () => {
  it('uses one-use PKCE state, encrypted server storage and exact target delegation', async () => {
    const flow = await beginHiveLogin();
    expect(new URL(flow.url).searchParams.get('code_challenge_method')).toBe('S256');
    const session = await finishHiveLogin(flow.state, 'code');
    expect(session.userId).toBe('named-user');
    expect(session.role).toBe('OPERATOR');
    expect(mocks.verify.mock.calls[0]?.[2]).toMatchObject({
      issuer: 'https://iam.invalid',
      audience: 'magnus-api',
      algorithms: ['RS256'],
    });
    expect(JSON.stringify([...mocks.values.values()])).not.toContain('private-delegated-token');
    expect(await hiveCredential(session, 'https://api.invalid')).toBe('private-delegated-token');
    await expect(hiveCredential(session, 'https://other.invalid')).rejects.toThrow('canonical');
    await expect(finishHiveLogin(flow.state, 'code')).rejects.toThrow('consumed');
    await revokeHiveSession(session);
    await expect(hiveCredential(session, 'https://api.invalid')).rejects.toThrow('expired');
  });
  it('always sends the PKCE verifier, and the client secret when one is configured', async () => {
    const exchanged = async () => {
      const flow = await beginHiveLogin();
      await finishHiveLogin(flow.state, 'code');
      const call = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith('/token'))
        .at(-1)!;
      return new URLSearchParams(String((call[1] as RequestInit).body));
    };
    const publicClient = await exchanged();
    expect(publicClient.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(publicClient.has('client_secret')).toBe(false);
    vi.stubEnv('HIVE_OAUTH_CLIENT_SECRET', 'obviously-fake-client-secret');
    const confidential = await exchanged();
    expect(confidential.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(confidential.get('client_secret')).toBe('obviously-fake-client-secret');
  });
  it('names the missing client secret when the identity service refuses the client', async () => {
    const refuse = (status: number, body: string) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url.endsWith('/token')
            ? new Response(body, { status })
            : new Response(JSON.stringify(doc)),
        ),
      );
    refuse(401, JSON.stringify({ error: 'invalid_client', error_description: 'private detail' }));
    let flow = await beginHiveLogin();
    const refusal = await finishHiveLogin(flow.state, 'code').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HiveClientRejected);
    expect((refusal as Error).message).toContain('HIVE_OAUTH_CLIENT_SECRET');
    expect((refusal as Error).message).not.toContain('private detail');
    // Any other refusal stays generic.
    for (const [status, body] of [
      [400, JSON.stringify({ error: 'invalid_grant' })],
      [401, 'not json'],
      [500, JSON.stringify({ error: 'invalid_client' })],
    ] as const) {
      refuse(status, body);
      flow = await beginHiveLogin();
      const other = await finishHiveLogin(flow.state, 'code').catch((error: unknown) => error);
      expect(other).not.toBeInstanceOf(HiveClientRejected);
      expect((other as Error).message).toBe('Hive identity request failed');
    }
  });
  it('rejects issuer, audience, expiry and service-account verification failures without fallback', async () => {
    for (const failure of ['issuer', 'audience', 'expired']) {
      const flow = await beginHiveLogin();
      mocks.verify.mockRejectedValueOnce(new Error(failure));
      await expect(finishHiveLogin(flow.state, 'code')).rejects.toThrow(failure);
    }
    const flow = await beginHiveLogin();
    mocks.verify.mockResolvedValueOnce({
      payload: { sub: 'bot', exp: 9999999999, actorType: 'SERVICE_ACCOUNT' },
    });
    await expect(finishHiveLogin(flow.state, 'code')).rejects.toThrow('Named');
  });
});
