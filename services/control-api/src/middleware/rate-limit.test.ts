import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import type { AppVariables } from '../types/index.js';

/** Each bucket's request times, oldest first, as the sorted set holds them. */
const buckets = vi.hoisted(() => new Map<string, number[]>());

vi.mock('ioredis', () => ({
  Redis: class {
    connect = async () => undefined;
    pipeline() {
      let key = '';
      let score = 0;
      let windowStart = 0;
      const chain = {
        zremrangebyscore: (_name: string, _min: string, max: number) => { windowStart = max; return chain; },
        zadd: (name: string, at: number) => { key = name; score = at; return chain; },
        zcard: () => chain,
        pexpire: () => chain,
        exec: async () => {
          const entries = [...(buckets.get(key) ?? []).filter((at) => at > windowStart), score];
          buckets.set(key, entries);
          return [[null, 0], [null, 1], [null, entries.length], [null, 1]];
        },
      };
      return chain;
    }
    async zrange(name: string, start: string, stop: string) {
      return (buckets.get(name) ?? []).slice(Number(start), Number(stop) + 1).flatMap((at) => [`${at}-member`, String(at)]);
    }
  },
}));
vi.mock('../routes/metrics.js', () => ({ incMetric: vi.fn() }));

const { ARDENT_RATE_LIMITS, ardentRateLimitMiddleware, rateLimitMiddleware } = await import('./rate-limit.js');
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
limited.use('/ardent/*', rateLimitMiddleware({ windowMs: 60_000, max: MAX, serviceMax: MAX * 3, keyPrefix: 'rl:ardent' }));
limited.get('/ardent/ping', (c) => c.text('ok'));

function mintService(clientId: string): Promise<string> {
  return new SignJWT({ actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId, permissions: ['magnus:ardent'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .setIssuer(ISSUER).setAudience('magnus').setSubject(clientId).setJti(`jti-${clientId}`)
    .setIssuedAt().setExpirationTime('10m').sign(signingKey);
}

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

  it('gives a verified service identity its own, larger budget', async () => {
    const service = await mintService('ardent-studio');
    const ping = (token: string) => limited.request('/ardent/ping', { headers: { Authorization: `Bearer ${token}` } }, INGRESS as object);
    for (let attempt = 0; attempt < MAX * 3; attempt += 1) expect((await ping(service)).status).toBe(200);
    expect((await ping(service)).status).toBe(429);
    expect([...buckets.keys()]).toEqual([expect.stringMatching(/^.*rl:ardent:subject:service:[a-f0-9]{64}$/)]);
    expect(userinfoCalls).toBe(0);
  });
});

describe('Retry-After', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names when a slot frees, counting refused requests, instead of always the whole window', async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // MAX requests spread over 40 seconds, then one more at 45 s is refused.
    for (let attempt = 0; attempt < MAX; attempt += 1) {
      clock = 1_000_000 + attempt * 2_000;
      expect((await call()).status).toBe(200);
    }
    clock = 1_045_000;
    const refused = await call();
    expect(refused.status).toBe(429);
    // The bucket holds MAX + 1 entries; the second oldest (at 1 002 000) leaves at 1 062 000.
    expect(refused.headers.get('Retry-After')).toBe('17');
    // A client that waits that long gets through.
    clock = 1_062_001;
    expect((await call()).status).toBe(200);
  });

  it('keeps a client that ignores it waiting: refused requests stay in the window', async () => {
    let clock = 2_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    await exhaust();
    // Asking every two seconds instead of waiting: after the first burst has left, the refusals
    // themselves still fill the window.
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      clock = 2_000_000 + attempt * 2_000;
      expect((await call()).status).toBe(429);
    }
  });
});

describe('the Ardent bridge budgets', () => {
  const ardent = new Hono<AppVariables>();
  ardent.use('/ardent/*', ardentRateLimitMiddleware());
  ardent.get('/ardent/profiles', (c) => c.text('ok'));
  ardent.post('/ardent/installations/node-1/profiles/writer/action', (c) => c.text('ok'));
  const read = (token: string) => ardent.request('/ardent/profiles', { headers: { Authorization: `Bearer ${token}` } }, INGRESS as object);
  const act = (token: string) => ardent.request('/ardent/installations/node-1/profiles/writer/action', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, INGRESS as object);

  it('lets a person read far more than they may change, in separate buckets', async () => {
    const alice = await mint('alice-subject');
    expect(ARDENT_RATE_LIMITS.read.max).toBeGreaterThanOrEqual(ARDENT_RATE_LIMITS.action.max * 10);
    for (let attempt = 0; attempt < ARDENT_RATE_LIMITS.read.max; attempt += 1) expect((await read(alice)).status).toBe(200);
    expect((await read(alice)).status).toBe(429);
    // Reading up to the limit leaves every action available.
    for (let attempt = 0; attempt < ARDENT_RATE_LIMITS.action.max; attempt += 1) expect((await act(alice)).status).toBe(200);
    const refused = await act(alice);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBeTruthy();
    expect([...buckets.keys()].sort()).toEqual([expect.stringMatching(/rl:ardent-read:subject:[a-f0-9]{64}$/), expect.stringMatching(/rl:ardent:subject:[a-f0-9]{64}$/)].sort());
  });

  it('gives a linked service identity larger read and action budgets', async () => {
    const service = await mintService('ardent-studio');
    for (let attempt = 0; attempt < ARDENT_RATE_LIMITS.action.serviceMax; attempt += 1) expect((await act(service)).status).toBe(200);
    expect((await act(service)).status).toBe(429);
    for (let attempt = 0; attempt < ARDENT_RATE_LIMITS.action.serviceMax + 1; attempt += 1) expect((await read(service)).status).toBe(200);
    expect(ARDENT_RATE_LIMITS.read.serviceMax).toBeGreaterThan(ARDENT_RATE_LIMITS.action.serviceMax);
  });
});
