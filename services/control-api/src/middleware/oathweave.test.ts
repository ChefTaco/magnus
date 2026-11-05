import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import type { AppVariables, AuthTokenPayload } from '../types/index.js';

const fixture = vi.hoisted(() => ({ iamCoreUrl: '', pluginEnabled: false }));

vi.mock('../utils/env.js', async (original) => ({
  ...await original<typeof import('../utils/env.js')>(),
  JWT_SECRET: 'fixture-jwt-secret-for-unit-tests-at-least-32',
  API_SECRET: 'fixture-api-secret-for-unit-tests-at-least-32',
  get IAM_CORE_URL() { return fixture.iamCoreUrl; },
  IAM_TOKEN_ISSUER: 'https://iam.example.com',
  IAM_TOKEN_AUDIENCE: 'magnus',
  MAGNUS_FLEET_CHECK_TOKEN_SHA256: createHash('sha256').update('fixture-fleet-token').digest('hex'),
}));
const userStatus = vi.hoisted(() => ({ get: vi.fn(async () => ({ active: true, role: 'OPERATOR' })) }));
vi.mock('./user-status.js', () => ({ getCurrentUserStatus: userStatus.get, invalidateUserStatus: vi.fn() }));
vi.mock('../services/credential-rotation-service.js', () => ({
  verifyWithRotation: (_name: string, expected: string, provided: string) => expected === provided,
}));

const { authMiddleware, signUserToken } = await import('./auth.js');
const { errorHandler } = await import('./error-handler.js');
const { createOathweaveVerifier, OATHWEAVE_SESSION_CACHE_TTL_MS, resetOathweaveVerifier } = await import('./oathweave-verifier.js');
const { linkedMagnusIdentity, OATHWEAVE_STREAM_RECHECK_MS, watchOathweaveStream } = await import('./oathweave.js');
const { consoleRouter } = await import('../routes/console.js');
const { consoleSessionResponseSchema } = await import('@hivemagnus/magnus-contracts/browser');

const ISSUER = 'https://identity.example.com';
const JWKS_URL = `${ISSUER}/oauth/jwks`;
const USERINFO_URL = `${ISSUER}/oauth/userinfo`;
const SUBJECT = 'fixture-subject';
const LINK = { issuer: ISSUER, subject: SUBJECT, localUserId: 'alice', role: 'ADMIN' };

let signingKey: CryptoKey;
let foreignKey: CryptoKey;
let jwks: JSONWebKeySet;

beforeAll(async () => {
  const signing = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  signingKey = signing.privateKey;
  foreignKey = foreign.privateKey;
  jwks = { keys: [{ ...await exportJWK(signing.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] };
});

type TokenOverrides = Partial<{
  issuer: string; audience: string | string[]; subject: string; issuedAt: number; expiresAt: number;
  jti: string | null; key: CryptoKey; claims: Record<string, unknown>;
}>;

function mint(overrides: TokenOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = overrides.issuedAt ?? now;
  const token = new SignJWT({
    actorType: 'USER', sessionId: 'fixture-session', clientId: 'hivexui-magnus', roles: [], permissions: ['magnus:admin'],
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? 'magnus')
    .setSubject(overrides.subject ?? SUBJECT)
    .setIssuedAt(issuedAt)
    .setExpirationTime(overrides.expiresAt ?? issuedAt + 600);
  if (overrides.jti !== null) token.setJti(overrides.jti ?? 'fixture-jti');
  return token.sign(overrides.key ?? signingKey);
}

let userinfo: ReturnType<typeof vi.fn>;
let userinfoCalls: Array<{ url: string; init: RequestInit | undefined }>;
let otherCalls: string[];

function stubIdentityService(respond: () => Response | Promise<Response> = () => Response.json({ sub: SUBJECT, name: 'Fixture User' })) {
  userinfoCalls = [];
  otherCalls = [];
  userinfo = vi.fn(respond);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === JWKS_URL) return Response.json(jwks);
    if (url === USERINFO_URL) {
      userinfoCalls.push({ url, init });
      return userinfo();
    }
    otherCalls.push(url);
    throw new Error(`unexpected request to ${url}`);
  });
}

function app() {
  const instance = new Hono<AppVariables>();
  instance.onError(errorHandler);
  instance.use('/probe', authMiddleware);
  instance.get('/probe', (c) => c.json(c.var.user as AuthTokenPayload));
  instance.route('/console', consoleRouter);
  return instance;
}

const get = (token: string, path = '/probe') => app().request(path, { headers: { Authorization: `Bearer ${token}` } });

beforeEach(() => {
  fixture.iamCoreUrl = '';
  userStatus.get.mockClear();
  resetOathweaveVerifier();
  vi.stubEnv('OATHWEAVE_ISSUER', ISSUER);
  vi.stubEnv('OATHWEAVE_JWKS_URL', JWKS_URL);
  vi.stubEnv('OATHWEAVE_USERINFO_URL', USERINFO_URL);
  vi.stubEnv('MAGNUS_OATHWEAVE_IDENTITIES_JSON', JSON.stringify([LINK]));
  stubIdentityService();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Oathweave token verification', () => {
  it('authenticates a valid token and labels the actor for audit', async () => {
    const response = await get(await mint());
    expect(response.status).toBe(200);
    const user = await response.json() as AuthTokenPayload;
    expect(user).toMatchObject({ userId: 'alice', email: 'alice', role: 'ADMIN' });
    // Mirrors `user?.email ?? user?.userId`, used across the audited routes.
    expect(user.email ?? user.userId).toBe('alice');
    expect(user.email).not.toBe('');
    expect(user.exp).toBeGreaterThan(user.iat);
  });

  it('never follows redirects with the bearer token and sends it only to userinfo', async () => {
    const token = await mint();
    await get(token);
    expect(userinfoCalls[0]?.init?.redirect).toBe('error');
    expect(new Headers(userinfoCalls[0]?.init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
  });

  it.each<[string, () => Promise<TokenOverrides>]>([
    ['wrong audience', async () => ({ audience: 'cindertrace' })],
    ['audience list that includes magnus', async () => ({ audience: ['magnus', 'cindertrace'] })],
    ['wrong issuer', async () => ({ issuer: 'https://other.example.com' })],
    ['expired', async () => { const now = Math.floor(Date.now() / 1000); return { issuedAt: now - 700, expiresAt: now - 100 }; }],
    ['lifetime over fifteen minutes', async () => { const now = Math.floor(Date.now() / 1000); return { issuedAt: now, expiresAt: now + 901 }; }],
    ['issued too long ago', async () => { const now = Math.floor(Date.now() / 1000); return { issuedAt: now - 901, expiresAt: now + 10 }; }],
    ['wrong actor type', async () => ({ claims: { actorType: 'SERVICE' } })],
    ['missing jti', async () => ({ jti: null })],
    ['missing session', async () => ({ claims: { sessionId: undefined } })],
    ['signed by an unknown key', async () => ({ key: foreignKey })],
  ])('rejects %s with 401 and no userinfo request', async (_name, overrides) => {
    const response = await get(await mint(await overrides()));
    expect(response.status).toBe(401);
    expect(userinfo).not.toHaveBeenCalled();
  });

  it('rejects a revoked session', async () => {
    stubIdentityService(() => Response.json({ error: 'INVALID_TOKEN' }, { status: 401 }));
    expect((await get(await mint())).status).toBe(401);
    expect(userinfo).toHaveBeenCalledTimes(1);
  });

  it('rejects when userinfo names a different subject', async () => {
    stubIdentityService(() => Response.json({ sub: 'someone-else' }));
    expect((await get(await mint())).status).toBe(401);
  });

  it('fails closed when the identity service is unreachable', async () => {
    stubIdentityService(() => { throw new Error('connection refused'); });
    expect((await get(await mint())).status).toBe(401);
  });

  it('fails closed on a partial configuration', async () => {
    vi.stubEnv('OATHWEAVE_USERINFO_URL', '');
    expect((await get(await mint())).status).toBe(401);
  });

  it('refuses plain HTTP endpoints', () => {
    expect(() => createOathweaveVerifier({ issuer: ISSUER, jwksUrl: JWKS_URL, userinfoUrl: 'http://identity.example.com/userinfo', audience: 'magnus' }))
      .toThrow(/HTTPS/);
  });
});

describe('explicit Oathweave account links', () => {
  it('rejects a verified identity with no link', async () => {
    vi.stubEnv('MAGNUS_OATHWEAVE_IDENTITIES_JSON', JSON.stringify([{ ...LINK, subject: 'other-subject' }]));
    const response = await get(await mint());
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('rejects duplicate links instead of choosing one', async () => {
    vi.stubEnv('MAGNUS_OATHWEAVE_IDENTITIES_JSON', JSON.stringify([LINK, { ...LINK, localUserId: 'bob', role: 'VIEWER' }]));
    expect((await get(await mint())).status).toBe(403);
  });

  it('rejects when the link registry is malformed', async () => {
    vi.stubEnv('MAGNUS_OATHWEAVE_IDENTITIES_JSON', '{not json');
    expect((await get(await mint())).status).toBe(403);
  });

  it('never infers a link from an email or username claim', async () => {
    const token = await mint({ subject: 'unlinked-subject', claims: { email: 'alice', username: 'alice', sub: 'unlinked-subject' } });
    stubIdentityService(() => Response.json({ sub: 'unlinked-subject', email: 'alice' }));
    expect((await get(token)).status).toBe(403);
  });

  const identity = { issuer: ISSUER, subject: SUBJECT, sessionId: 's', roles: [] as string[], displayName: 'd', issuedAt: 1, expiresAt: 2 };

  it.each([
    ['ADMIN', ['magnus:admin'], 'ADMIN'],
    ['ADMIN', ['magnus:operate'], 'OPERATOR'],
    ['ADMIN', ['magnus:view'], 'VIEWER'],
    ['OPERATOR', ['magnus:operate'], 'OPERATOR'],
    ['OPERATOR', ['magnus:admin', 'magnus:operate', 'magnus:view'], 'OPERATOR'],
    ['OPERATOR', ['magnus:view'], 'VIEWER'],
    ['VIEWER', ['magnus:view'], 'VIEWER'],
    ['VIEWER', ['magnus:admin', 'magnus:operate', 'magnus:view'], 'VIEWER'],
  ])('%s link with %j maps to %s', (role, permissions, expected) => {
    expect(linkedMagnusIdentity({ ...identity, permissions }, JSON.stringify([{ ...LINK, role }])).role).toBe(expected);
  });

  it.each([
    ['OPERATOR', ['magnus:admin']],
    ['VIEWER', ['magnus:admin']],
    ['VIEWER', ['magnus:operate']],
    ['ADMIN', []],
    ['ADMIN', ['cindertrace:admin', 'magnus:terminal']],
  ])('%s link with %j is denied by the ceiling', (role, permissions) => {
    expect(() => linkedMagnusIdentity({ ...identity, permissions }, JSON.stringify([{ ...LINK, role }]))).toThrow(/permission required/);
  });

  it('never promotes from identity role names', () => {
    expect(() => linkedMagnusIdentity({ ...identity, roles: ['SUPER_ADMIN', 'SERVICE'], permissions: [] }, JSON.stringify([LINK]))).toThrow();
  });

  it('denies over HTTP when the permission ceiling refuses', async () => {
    const response = await get(await mint({ claims: { permissions: ['router:keys:write'] } }));
    expect(response.status).toBe(403);
  });
});

describe('authentication branch isolation', () => {
  it('does not fall through to IAM verification when an Oathweave token fails', async () => {
    fixture.iamCoreUrl = 'https://iam.example.com';
    const response = await get(await mint({ audience: 'cindertrace' }));
    expect(response.status).toBe(401);
    expect(otherCalls).toEqual([]);
  });

  it('does not fall through to local verification when an Oathweave token fails', async () => {
    const response = await get(await mint({ issuer: 'https://other.example.com' }));
    expect(response.status).toBe(401);
    expect(userStatus.get).not.toHaveBeenCalled();
  });

  it('does not fall through after a revoked session', async () => {
    stubIdentityService(() => new Response(null, { status: 401 }));
    expect((await get(await mint())).status).toBe(401);
    expect(userStatus.get).not.toHaveBeenCalled();
  });

  it('keeps local HS256 sessions working', async () => {
    const token = await signUserToken({ userId: 'local-user', email: 'alice@example.com', role: 'VIEWER' });
    const response = await get(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId: 'local-user', role: 'OPERATOR' });
    expect(userinfo).not.toHaveBeenCalled();
  });

  it('keeps the API secret and service credentials working', async () => {
    const secret = await app().request('/probe', { headers: { 'x-api-secret': 'fixture-api-secret-for-unit-tests-at-least-32' } });
    expect(secret.status).toBe(200);
    expect(await secret.json()).toMatchObject({ userId: 'system', role: 'ADMIN' });
    // The fleet credential is endpoint-scoped, so reaching that check proves digest matching ran first.
    const scoped = await get('fixture-fleet-token');
    expect(scoped.status).toBe(403);
    expect(userinfo).not.toHaveBeenCalled();
  });

  it('ignores RS256 tokens when Oathweave is not configured', async () => {
    vi.stubEnv('OATHWEAVE_ISSUER', '');
    vi.stubEnv('OATHWEAVE_JWKS_URL', '');
    vi.stubEnv('OATHWEAVE_USERINFO_URL', '');
    expect((await get(await mint())).status).toBe(401);
    expect(userinfo).not.toHaveBeenCalled();
  });
});

describe('session revocation cache', () => {
  const START = Date.parse('2026-06-01T00:00:00Z');

  function verifierAt(clock: { now: number }, respond: () => Response) {
    const calls = { count: 0 };
    const verify = createOathweaveVerifier(
      { issuer: ISSUER, jwksUrl: JWKS_URL, userinfoUrl: USERINFO_URL, audience: 'magnus' },
      { keys: createLocalJWKSet(jwks), now: () => clock.now, fetch: (async () => { calls.count += 1; return respond(); }) as typeof fetch },
    );
    return { verify, calls };
  }
  const issuedAtStart = () => mint({ issuedAt: START / 1000, expiresAt: START / 1000 + 600 });

  it('allows at most fifteen seconds of staleness, including on an open stream', () => {
    expect(OATHWEAVE_SESSION_CACHE_TTL_MS).toBeLessThanOrEqual(15_000);
    expect(OATHWEAVE_SESSION_CACHE_TTL_MS + OATHWEAVE_STREAM_RECHECK_MS).toBeLessThanOrEqual(15_000);
  });

  it('collapses five-second pollers onto one userinfo request per window', async () => {
    const clock = { now: START };
    const { verify, calls } = verifierAt(clock, () => Response.json({ sub: SUBJECT }));
    const token = await issuedAtStart();
    for (let ms = 0; ms < OATHWEAVE_SESSION_CACHE_TTL_MS; ms += 5_000) {
      clock.now = START + ms;
      await verify(token);
    }
    expect(calls.count).toBe(1);
    clock.now = START + OATHWEAVE_SESSION_CACHE_TTL_MS;
    await verify(token);
    expect(calls.count).toBe(2);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const clock = { now: START };
    const { verify, calls } = verifierAt(clock, () => Response.json({ sub: SUBJECT }));
    const token = await issuedAtStart();
    await Promise.all([verify(token), verify(token), verify(token)]);
    expect(calls.count).toBe(1);
  });

  it('honours logout within the bound', async () => {
    const clock = { now: START };
    let loggedOut = false;
    const { verify } = verifierAt(clock, () => loggedOut ? new Response(null, { status: 401 }) : Response.json({ sub: SUBJECT }));
    const token = await issuedAtStart();
    await verify(token);

    // Logout one second after the last check. The cached answer may outlive it...
    clock.now = START + 1_000;
    loggedOut = true;
    await expect(verify(token)).resolves.toMatchObject({ subject: SUBJECT });
    clock.now = START + OATHWEAVE_SESSION_CACHE_TTL_MS - 1;
    await expect(verify(token)).resolves.toMatchObject({ subject: SUBJECT });
    // ...but never past the bound, measured from when that check started.
    clock.now = START + OATHWEAVE_SESSION_CACHE_TTL_MS;
    await expect(verify(token)).rejects.toThrow(/inactive/);
    expect(clock.now - (START + 1_000)).toBeLessThanOrEqual(15_000);
    // A revoked token stays rejected on every later request.
    clock.now += 60_000;
    await expect(verify(token)).rejects.toThrow(/inactive/);
  });

  it('measures the bound from when a slow check started', async () => {
    const clock = { now: START };
    let loggedOut = false;
    const verify = createOathweaveVerifier(
      { issuer: ISSUER, jwksUrl: JWKS_URL, userinfoUrl: USERINFO_URL, audience: 'magnus' },
      { keys: createLocalJWKSet(jwks), now: () => clock.now, fetch: (async () => {
        if (loggedOut) return new Response(null, { status: 401 });
        clock.now += 3_000; // The answer takes three seconds to arrive.
        return Response.json({ sub: SUBJECT });
      }) as typeof fetch },
    );
    const token = await issuedAtStart();
    await verify(token);
    loggedOut = true;
    clock.now = START + OATHWEAVE_SESSION_CACHE_TTL_MS;
    await expect(verify(token)).rejects.toThrow(/inactive/);
  });

  it('rejects an expired token even while its session answer is cached', async () => {
    const clock = { now: START };
    const { verify, calls } = verifierAt(clock, () => Response.json({ sub: SUBJECT }));
    const token = await mint({ issuedAt: START / 1000, expiresAt: START / 1000 + 10 });
    await verify(token);
    clock.now = START + 10_000;
    await expect(verify(token)).rejects.toThrow();
    expect(calls.count).toBe(1);
  });

  it('recovers quickly from a transient identity failure', async () => {
    const clock = { now: START };
    let healthy = false;
    const { verify, calls } = verifierAt(clock, () => healthy ? Response.json({ sub: SUBJECT }) : new Response(null, { status: 503 }));
    const token = await issuedAtStart();
    await expect(verify(token)).rejects.toThrow();
    await expect(verify(token)).rejects.toThrow();
    expect(calls.count).toBe(1);
    healthy = true;
    clock.now = START + 2_000;
    await expect(verify(token)).resolves.toMatchObject({ subject: SUBJECT });
  });

  it('keeps forged tokens out of the cache and away from the identity service', async () => {
    const { verify, calls } = verifierAt({ now: START }, () => Response.json({ sub: SUBJECT }));
    await expect(verify(await mint({ issuedAt: START / 1000, expiresAt: START / 1000 + 600, key: foreignKey }))).rejects.toThrow();
    expect(calls.count).toBe(0);
  });
});

describe('open streams', () => {
  const flush = async () => { for (let i = 0; i < 25; i += 1) await vi.advanceTimersByTimeAsync(0); };

  it('ends a stream within fifteen seconds of logout', async () => {
    const token = await mint();
    await get(token);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.now() });
    let loggedOut = false;
    stubIdentityService(() => loggedOut ? new Response(null, { status: 401 }) : Response.json({ sub: SUBJECT }));
    const onRevoked = vi.fn();
    const stop = watchOathweaveStream(`Bearer ${token}`, onRevoked);
    await vi.advanceTimersByTimeAsync(OATHWEAVE_STREAM_RECHECK_MS);
    await flush();
    expect(onRevoked).not.toHaveBeenCalled();

    loggedOut = true;
    for (let elapsed = 0; elapsed < 15_000 && !onRevoked.mock.calls.length; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(onRevoked).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onRevoked).toHaveBeenCalledOnce();
    stop();
  });

  it('ends a stream when its token expires', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await mint({ issuedAt, expiresAt: issuedAt + 8 });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.now() });
    const onRevoked = vi.fn();
    const stop = watchOathweaveStream(`Bearer ${token}`, onRevoked);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(onRevoked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(onRevoked).toHaveBeenCalledOnce();
    stop();
  });

  it('stops watching when told to', async () => {
    const token = await mint();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.now() });
    stubIdentityService(() => new Response(null, { status: 401 }));
    const onRevoked = vi.fn();
    watchOathweaveStream(`Bearer ${token}`, onRevoked)();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(onRevoked).not.toHaveBeenCalled();
    expect(userinfo).not.toHaveBeenCalled();
  });

  it.each([
    ['an opaque service credential', 'Bearer opaque-service-credential'],
    ['no credential', undefined],
  ])('does not watch %s', async (_name, authorization) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.now() });
    const onRevoked = vi.fn();
    watchOathweaveStream(authorization, onRevoked);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRevoked).not.toHaveBeenCalled();
  });
});

describe('GET /console/session', () => {
  it.each([
    ['magnus:admin', 'ADMIN'],
    ['magnus:operate', 'OPERATOR'],
    ['magnus:view', 'VIEWER'],
  ])('returns the role mapped from %s', async (permission, role) => {
    const response = await get(await mint({ claims: { permissions: [permission] } }), '/console/session');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(consoleSessionResponseSchema.parse(await response.json()).data).toMatchObject({ userId: 'alice', role });
  });

  it('reports capabilities from the server environment', async () => {
    const token = await mint();
    const off = consoleSessionResponseSchema.parse(await (await get(token, '/console/session')).json()).data.capabilities;
    expect(off).toMatchObject({ hermes: false, securityConsoleUrl: null });
    expect(off.agentVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(off.magnusVersion).toMatch(/^\d+\.\d+\.\d+/);
    vi.stubEnv('MAGNUS_HERMES_ENABLED', 'true');
    vi.stubEnv('MAGNUS_SECURITY_CONSOLE_URL', 'https://security.example.com/');
    expect(consoleSessionResponseSchema.parse(await (await get(token, '/console/session')).json()).data.capabilities)
      .toMatchObject({ hermes: true, securityConsoleUrl: 'https://security.example.com' });
  });

  describe('terminal capability', () => {
    const terminal = async (permissions: string[], subject = SUBJECT) => {
      const response = await get(await mint({ subject, claims: { permissions } }), '/console/session');
      return consoleSessionResponseSchema.parse(await response.json()).data.capabilities.terminal;
    };
    const deploy = () => {
      vi.stubEnv('FLEET_GATEWAY_URL', 'https://fleet-gateway.example.com:4310');
      vi.stubEnv('FLEET_GATEWAY_TOKEN_SHA256', 'a'.repeat(64));
    };

    it('is false without a deployed gateway, whoever asks', async () => {
      expect(await terminal(['magnus:admin', 'magnus:terminal'])).toBe(false);
      vi.stubEnv('FLEET_GATEWAY_URL', 'https://fleet-gateway.example.com:4310');
      expect(await terminal(['magnus:admin', 'magnus:terminal'])).toBe(false);
    });

    it('is true for an ADMIN link holding magnus:terminal', async () => {
      deploy();
      expect(await terminal(['magnus:admin', 'magnus:terminal'])).toBe(true);
    });

    it('is false without magnus:terminal', async () => {
      deploy();
      expect(await terminal(['magnus:admin', 'magnus:operate', 'magnus:view'])).toBe(false);
    });

    it('is false for a link below ADMIN, even holding the permission', async () => {
      deploy();
      vi.stubEnv('MAGNUS_OATHWEAVE_IDENTITIES_JSON', JSON.stringify([{ ...LINK, role: 'OPERATOR' }]));
      expect(await terminal(['magnus:operate', 'magnus:terminal'])).toBe(false);
    });

    it('magnus:terminal grants no other access', async () => {
      deploy();
      expect((await get(await mint({ claims: { permissions: ['magnus:terminal'] } }), '/console/session')).status).toBe(403);
    });

    it('is false for a local service credential', async () => {
      deploy();
      const response = await app().request('/console/session', { headers: { 'x-api-secret': 'fixture-api-secret-for-unit-tests-at-least-32' } });
      expect(consoleSessionResponseSchema.parse(await response.json()).data.capabilities.terminal).toBe(false);
    });
  });

  it('requires authentication', async () => {
    expect((await app().request('/console/session')).status).toBe(401);
    expect((await get(await mint({ audience: 'cindertrace' }), '/console/session')).status).toBe(401);
  });
});
