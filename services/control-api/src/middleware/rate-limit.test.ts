import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import type { AppVariables } from '../types/index.js';

const buckets = vi.hoisted(() => new Map<string, number>());

vi.mock('ioredis', () => ({
  Redis: class {
    connect = async () => undefined;
    pipeline() {
      let key = '';
      const chain = {
        zremrangebyscore: () => chain,
        zadd: (name: string) => { key = name; return chain; },
        zcard: () => chain,
        pexpire: () => chain,
        exec: async () => {
          buckets.set(key, (buckets.get(key) ?? 0) + 1);
          return [[null, 0], [null, 1], [null, buckets.get(key)], [null, 1]];
        },
      };
      return chain;
    }
  },
}));
vi.mock('../routes/metrics.js', () => ({ incMetric: vi.fn() }));

const { rateLimitMiddleware } = await import('./rate-limit.js');
const { resetOathweaveVerifier } = await import('./oathweave-verifier.js');

const ISSUER = 'https://identity.example.com';
const JWKS_URL = `${ISSUER}/oauth/jwks`;
const USERINFO_URL = `${ISSUER}/oauth/userinfo`;
const MAX = 20;

let signingKey: CryptoKey;
let foreignKey: CryptoKey;
let jwks: JSONWebKeySet;
let revoked: Set<string>;
let userinfoCalls: number;

beforeAll(async () => {
  const signing = await generateKeyPair('RS256');
  foreignKey = (await generateKeyPair('RS256')).privateKey;
  signingKey = signing.privateKey;
  jwks = { keys: [{ ...await exportJWK(signing.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] };
});

function mint(subject: string, key: CryptoKey = signingKey, sessionId = 'fixture-session'): Promise<string> {
  return new SignJWT({ actorType: 'USER', sessionId, clientId: 'hivexui-magnus', roles: [], permissions: ['magnus:view'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .setIssuer(ISSUER).setAudience('magnus').setSubject(subject).setJti(`jti-${subject}-${sessionId}`)
    .setIssuedAt().setExpirationTime('10m').sign(key);
}

const limited = new Hono<AppVariables>();
limited.use('/hermes/*', rateLimitMiddleware({ windowMs: 60_000, max: MAX, keyPrefix: 'rl:hermes' }));
limited.get('/hermes/ping', (c) => c.text('ok'));

/** The ingress: every browser arrives from the same socket peer. */
const INGRESS = { incoming: { socket: { remoteAddress: '192.0.2.10', remotePort: 44321, remoteFamily: 'IPv4' } } };

function call(token?: string, headers: Record<string, string> = {}, env: unknown = INGRESS) {
  return limited.request('/hermes/ping', {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  }, env as object);
}

async function exhaust(token?: string): Promise<void> {
  for (let attempt = 0; attempt < MAX; attempt += 1) expect((await call(token)).status).toBe(200);
}

beforeEach(() => {
  buckets.clear();
  revoked = new Set();
  userinfoCalls = 0;
  resetOathweaveVerifier();
  vi.stubEnv('OATHWEAVE_ISSUER', ISSUER);
  vi.stubEnv('OATHWEAVE_JWKS_URL', JWKS_URL);
  vi.stubEnv('OATHWEAVE_USERINFO_URL', USERINFO_URL);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === JWKS_URL) return Response.json(jwks);
    if (url === USERINFO_URL) {
      userinfoCalls += 1;
      const token = new Headers(init?.headers).get('Authorization')!.slice(7);
      if (revoked.has(token)) return new Response(null, { status: 401 });
      const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string };
      return Response.json({ sub: payload.sub });
    }
    throw new Error(`unexpected request to ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('rate-limit identity behind a shared ingress', () => {
  it('gives each verified subject its own bucket on one peer address', async () => {
    const alice = await mint('alice-subject');
    const bob = await mint('bob-subject');
    await exhaust(alice);
    const limitedResponse = await call(alice);
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('Retry-After')).toBe('60');
    expect((await call(bob)).status).toBe(200);
    expect((await call()).status).toBe(200);
  });

  it('keeps one subject in one bucket across sessions and new tokens', async () => {
    await exhaust(await mint('alice-subject', signingKey, 'session-one'));
    expect((await call(await mint('alice-subject', signingKey, 'session-two'))).status).toBe(429);
  });

  it('does not let a forged token claim a bucket: rotating subjects share the peer bucket', async () => {
    for (let attempt = 0; attempt < MAX; attempt += 1) {
      expect((await call(await mint(`forged-${attempt}`, foreignKey))).status).toBe(200);
    }
    expect((await call(await mint('forged-final', foreignKey))).status).toBe(429);
    expect((await call()).status).toBe(429);
    expect((await call(await mint('alice-subject'))).status).toBe(200);
    expect(userinfoCalls).toBe(1);
  });

  it('keeps a revoked token on the peer bucket', async () => {
    const token = await mint('revoked-subject');
    revoked.add(token);
    await call(token);
    expect([...buckets.keys()]).toEqual([expect.stringMatching(/rl:hermes:.*192\.0\.2\.10$/)]);
  });

  it('never uses a forwarded header while a socket peer exists', async () => {
    await exhaust();
    const rotated = await call(undefined, { 'x-forwarded-for': '198.51.100.7', 'x-real-ip': '198.51.100.8' });
    expect(rotated.status).toBe(429);
    const authenticatedRotation = await mint('alice-subject');
    await call(authenticatedRotation, { 'x-forwarded-for': '198.51.100.7' });
    await call(authenticatedRotation, { 'x-forwarded-for': '198.51.100.9' });
    expect([...buckets.keys()].filter((key) => key.includes('198.51.100'))).toEqual([]);
  });

  it('does not store the raw subject in the key', async () => {
    await call(await mint('alice-subject'));
    expect([...buckets.keys()]).toEqual([expect.stringMatching(/^.*rl:hermes:subject:[a-f0-9]{64}$/)]);
  });

  it('keys everything on the peer when Oathweave is off', async () => {
    vi.stubEnv('OATHWEAVE_ISSUER', '');
    vi.stubEnv('OATHWEAVE_JWKS_URL', '');
    vi.stubEnv('OATHWEAVE_USERINFO_URL', '');
    await call(await mint('alice-subject'));
    expect([...buckets.keys()]).toEqual([expect.stringMatching(/rl:hermes:.*192\.0\.2\.10$/)]);
    expect(userinfoCalls).toBe(0);
  });

  it('leaves opaque service credentials on the peer bucket without any identity traffic', async () => {
    await call('opaque-service-credential');
    expect([...buckets.keys()]).toEqual([expect.stringMatching(/rl:hermes:.*192\.0\.2\.10$/)]);
    expect(userinfoCalls).toBe(0);
  });
});
