import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiErrorSchema, nodeCredentialResetResponseSchema, nodeCredentialRevokeResponseSchema, nodeCredentialsResponseSchema } from '@hivemagnus/magnus-contracts/browser';
import type { AppVariables } from '../types/index.js';

// The node key administration routes are browser routes for ADMIN users (docs/console-api.md#node-key-administration).
const NODE_SECRET = 'fixture-node-manager-secret-at-least-32-characters';
const MACHINE = vi.hoisted(() => ({
  pluginRead: 'fixture-plugin-read-credential', pluginOperator: 'fixture-plugin-operator-credential', fleetCheck: 'fixture-fleet-check-credential',
  sharedResource: 'fixture-shared-resource-credential', collector: 'fixture-collector-credential',
}));
vi.mock('../utils/env.js', async original => {
  const { createHash: hash } = await import('node:crypto');
  const digest = (value: string) => hash('sha256').update(value).digest('hex');
  return { ...await original<object>(), JWT_SECRET: 'fixture-node-keys-jwt-secret-at-least-32-chars', API_SECRET: 'fixture-node-keys-api-secret-at-least-32',
    IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '', NODE_MANAGER_SECRET: 'fixture-node-manager-secret-at-least-32-characters',
    MAGNUS_PLUGIN_API_ENABLED: true, MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({ hermes: digest(MACHINE.pluginRead) }),
    MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: digest(MACHINE.pluginOperator), MAGNUS_FLEET_CHECK_TOKEN_SHA256: digest(MACHINE.fleetCheck),
    MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: digest(MACHINE.sharedResource), MAGNUS_COLLECTOR_TOKEN_SHA256: digest(MACHINE.collector) };
});
vi.mock('../services/credential-rotation-service.js', async original => ({ ...await original<object>(),
  verifyWithRotation: (_name: string, active: string, token: string) => token === active }));
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));
const fixture = vi.hoisted(() => ({ audit: [] as Array<{ action: string; actorId: string; targetId: string; details?: Record<string, unknown> }>,
  notifications: [] as Array<Record<string, unknown>>, redis: new Map<string, string>() }));
vi.mock('../services/audit-service.js', async original => ({ ...await original<object>(),
  logAuditEvent: async (event: { action: string; actorId: string; targetId: string }) => { fixture.audit.push(event); } }));
vi.mock('../services/notification-service.js', () => ({ createNotification: async (input: Record<string, unknown>) => { fixture.notifications.push(input); return 'n'; } }));
vi.mock('../queue/redis.js', () => ({
  getRedis: () => ({
    set: async (key: string, value: string) => (fixture.redis.has(key) ? null : (fixture.redis.set(key, value), 'OK')),
    eval: async (_script: string, _keys: number, key: string, token: string) => (fixture.redis.get(key) === token ? Number(fixture.redis.delete(key)) : 0),
  }),
}));
vi.mock('../services/node-credential-store.js', async () => {
  const { createFakeCredentialStore } = await import('../services/node-credential-test-fixture.js');
  const fake = createFakeCredentialStore();
  return { nodeCredentialStore: fake.store, fakeCredentialStore: fake };
});

const { fakeCredentialStore: fake } = await import('../services/node-credential-store.js') as unknown as
  { fakeCredentialStore: ReturnType<typeof import('../services/node-credential-test-fixture.js').createFakeCredentialStore> };
const { fixtureAgentKey, fixtureNode } = await import('../services/node-credential-test-fixture.js');
const { errorHandler } = await import('../middleware/error-handler.js');
const { signUserToken } = await import('../middleware/auth.js');
const { resetOathweaveVerifier } = await import('../middleware/oathweave-verifier.js');
const { resetNodeCredentialServiceState } = await import('../services/node-credential-service.js');
const { nodesRouter } = await import('./nodes.js');

const app = new Hono<AppVariables>().onError(errorHandler).route('/api/v1/nodes', nodesRouter);
const BASE = '/api/v1/nodes/node-a/credentials';
type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';
type Auth = Role | { headers: Record<string, string> } | null;

async function send(method: 'GET' | 'POST', path: string, auth: Auth, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (typeof auth === 'string') headers['Authorization'] = `Bearer ${await signUserToken({ userId: `fixture-${auth.toLowerCase()}`, email: 'alice@example.com', role: auth })}`;
  else if (auth) Object.assign(headers, auth.headers);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as { success: boolean; data: Record<string, unknown>; error?: { code: string } },
    cacheControl: response.headers.get('cache-control') };
}
const revoke = (auth: Auth, body: unknown = {}, extra?: Record<string, string>) => send('POST', `${BASE}/revoke`, auth, body, extra);
const reset = (auth: Auth, body: unknown = {}, extra?: Record<string, string>) => send('POST', `${BASE}/reset`, auth, body, extra);

function addKey(status: 'ACTIVE' | 'RETIRING' | 'REVOKED' = 'ACTIVE') {
  const key = fixtureAgentKey();
  fake.state.credentials.push({ id: `cred-${key.keyId.slice(0, 8)}`, nodeId: 'node-a', keyId: key.keyId, publicKey: key.publicKey, boundFqdn: 'node-a.example.com',
    status, origin: 'LEGACY_UPGRADE', createdAt: new Date(), lastUsedAt: null, retireAt: status === 'RETIRING' ? new Date(Date.now() + 60_000) : null,
    revokedAt: null, revokedBy: null, evidenceSigning: false, evidenceSigningAt: null });
  return key;
}
const statuses = () => fake.state.credentials.map(entry => entry.status);

beforeEach(() => {
  fake.reset();
  fake.state.nodes.push(fixtureNode('node-a', 'node-a.example.com', '192.0.2.10'));
  fixture.audit = []; fixture.notifications = []; fixture.redis.clear();
  resetNodeCredentialServiceState();
  process.env['NODE_AUTH_MODE'] = 'compat';
});
afterEach(() => { process.env['NODE_AUTH_MODE'] = 'compat'; });

describe('node key administration: roles', () => {
  it('lets an ADMIN list the keys, with no key material and no-store', async () => {
    const key = addKey();
    const response = await send('GET', BASE, 'ADMIN');
    expect(response.status).toBe(200);
    expect(response.cacheControl).toBe('no-store');
    expect(nodeCredentialsResponseSchema.parse(response.json).data).toMatchObject([{ keyId: key.keyId, status: 'ACTIVE' }]);
    expect(response.text).not.toMatch(/PRIVATE KEY|publicKey/u);
  });

  it.each(['OPERATOR', 'VIEWER'] as const)('refuses %s on every route, and changes nothing', async (role) => {
    addKey();
    for (const response of [await send('GET', BASE, role), await revoke(role, { reason: 'not mine' }), await reset(role)]) {
      expect(response.status).toBe(403);
      expect(response.json.error?.code).toBe('FORBIDDEN');
    }
    expect(statuses()).toEqual(['ACTIVE']);
    expect(fixture.audit).toEqual([]);
  });

  it('needs a user token', async () => {
    for (const response of [await send('GET', BASE, null), await revoke(null), await reset(null)]) expect(response.status).toBe(401);
  });
});

describe('node key administration: revoke and reset', () => {
  it('revokes the last active key: the agent is refused, the shared secret stays closed, and the audit names the user and the reason', async () => {
    const key = addKey();
    const response = await revoke('ADMIN', { reason: '  laptop stolen  ' });
    expect(response.status).toBe(200);
    expect(response.cacheControl).toBe('no-store');
    expect(nodeCredentialRevokeResponseSchema.parse(response.json).data).toMatchObject({ revoked: 1, state: 'revoked', agentRefused: true,
      sharedSecretAccepted: false, resetAvailable: true });
    expect(String(response.json.data['detail'])).toMatch(/NODE_CREDENTIAL_REVOKED/u);
    expect(fixture.audit).toEqual([expect.objectContaining({ action: 'node.credential.revoke', actorId: 'fixture-admin', targetId: 'node-a',
      details: { revoked: 1, all: true, agentRefused: true, reason: 'laptop stolen' } })]);
    expect(JSON.stringify(fixture.notifications)).not.toContain('laptop stolen');
    expect(JSON.stringify([fixture.audit, response.json])).not.toContain(key.publicKey);
  });

  it('revoking a retiring key leaves the active one working', async () => {
    const old = addKey('RETIRING');
    addKey();
    const response = await revoke('ADMIN', { keyId: old.keyId });
    expect(nodeCredentialRevokeResponseSchema.parse(response.json).data).toMatchObject({ revoked: 1, state: 'active', agentRefused: false });
    expect(statuses()).toEqual(['REVOKED', 'ACTIVE']);
    expect(fixture.audit[0]!.details).toMatchObject({ keyId: old.keyId, agentRefused: false });
    expect(fixture.audit[0]!.details).not.toHaveProperty('reason');
  });

  it('says a reset is not a way back in enforce mode', async () => {
    addKey();
    process.env['NODE_AUTH_MODE'] = 'enforce';
    expect((await revoke('ADMIN')).json.data).toMatchObject({ agentRefused: true, resetAvailable: false });
  });

  it('resets the node to the shared secret, and says whether its agent binds again by itself', async () => {
    addKey('REVOKED');
    const response = await reset('ADMIN', { reason: 'rollback to 2.9.1' });
    expect(response.status).toBe(200);
    expect(nodeCredentialResetResponseSchema.parse(response.json).data).toMatchObject({ removed: 1, state: 'none', sharedSecretAccepted: true, legacyUpgradeOpen: true });
    expect(fake.state.credentials).toEqual([]);
    expect(fixture.audit).toEqual([expect.objectContaining({ action: 'node.credential.reset', actorId: 'fixture-admin',
      details: { removed: 1, legacyUpgradeOpen: true, reason: 'rollback to 2.9.1' } })]);
    fake.state.startedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    resetNodeCredentialServiceState();
    expect((await reset('ADMIN')).json.data).toMatchObject({ removed: 0, legacyUpgradeOpen: false });
  });

  it('answers safe error codes', async () => {
    const unknownNode = await send('POST', '/api/v1/nodes/node-x/credentials/revoke', 'ADMIN', {});
    expect([unknownNode.status, apiErrorSchema.parse(unknownNode.json).error.code]).toEqual([404, 'NOT_FOUND']);
    const nothing = await revoke('ADMIN');
    expect([nothing.status, nothing.json.error?.code]).toEqual([404, 'NODE_CREDENTIAL_NOT_FOUND']);
    addKey();
    process.env['NODE_AUTH_MODE'] = 'enforce';
    const enforced = await reset('ADMIN');
    expect([enforced.status, enforced.json.error?.code]).toEqual([409, 'NODE_AUTH_ENFORCED']);
    expect(statuses()).toEqual(['ACTIVE']);
    expect(fixture.audit).toEqual([]);
  });
});

describe('node key administration: the reason', () => {
  it.each([
    ['empty', { reason: '' }], ['blank', { reason: '   ' }], ['too long', { reason: 'x'.repeat(501) }], ['not text', { reason: 7 }],
    ['an unknown field', { reason: 'ok', force: true }], ['a malformed keyId', { keyId: 'abc' }],
  ])('refuses a revoke with %s, and changes nothing', async (_label, body) => {
    addKey();
    const response = await revoke('ADMIN', body);
    expect([response.status, response.json.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(statuses()).toEqual(['ACTIVE']);
    expect(fixture.audit).toEqual([]);
  });

  it.each([
    ['too long', { reason: 'x'.repeat(501) }], ['a keyId', { keyId: 'a'.repeat(64) }], ['malformed JSON', '{'],
  ])('refuses a reset with %s', async (_label, body) => {
    addKey();
    expect((await reset('ADMIN', body)).status).toBe(400);
    expect(statuses()).toEqual(['ACTIVE']);
  });

  it('accepts 500 characters and no reason at all', async () => {
    addKey(); addKey('RETIRING');
    expect((await revoke('ADMIN', { keyId: fake.state.credentials[1]!.keyId, reason: 'x'.repeat(500) })).status).toBe(200);
    expect(fixture.audit[0]!.details!['reason']).toHaveLength(500);
    expect((await reset('ADMIN', {})).status).toBe(200);
    expect(fixture.audit[1]!.details).not.toHaveProperty('reason');
  });
});

describe('node key administration: idempotency', () => {
  it('answers a repeat of the same key with 409 DUPLICATE_REQUEST, once per user and route', async () => {
    addKey(); addKey('RETIRING');
    const idem = { 'x-idempotency-key': 'revoke-1' };
    expect((await revoke('ADMIN', { keyId: fake.state.credentials[1]!.keyId }, idem)).status).toBe(200);
    const repeat = await revoke('ADMIN', { keyId: fake.state.credentials[1]!.keyId }, idem);
    expect([repeat.status, repeat.json.error?.code]).toEqual([409, 'DUPLICATE_REQUEST']);
    expect(fixture.audit.map(event => event.action)).toEqual(['node.credential.revoke']);
    // Another route is another scope.
    expect((await reset('ADMIN', {}, idem)).status).toBe(200);
  });

  it('frees the key when the change was refused', async () => {
    addKey();
    const idem = { 'x-idempotency-key': 'reset-1' };
    process.env['NODE_AUTH_MODE'] = 'enforce';
    expect((await reset('ADMIN', {}, idem)).status).toBe(409);
    process.env['NODE_AUTH_MODE'] = 'compat';
    expect((await reset('ADMIN', {}, idem)).status).toBe(200);
    expect((await reset('ADMIN', {}, idem)).json.error?.code).toBe('DUPLICATE_REQUEST');
  });

  it('works without a key, as before', async () => {
    addKey();
    expect((await reset('ADMIN')).status).toBe(200);
    expect((await reset('ADMIN')).json.data).toMatchObject({ removed: 0 });
  });
});

describe('node key administration: credentials a browser must not use here', () => {
  const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

  it('refuses node credentials: the shared node secret and a node signature', async () => {
    const key = addKey();
    const signed = { headers: key.sign({ nodeId: 'node-a', serverKeyId: 'a'.repeat(64), path: `${BASE}/reset`, body: '{}' }) };
    for (const auth of [{ headers: { 'x-node-token': NODE_SECRET } }, signed]) {
      for (const response of [await send('GET', BASE, auth), await revoke(auth), await reset(auth)]) expect(response.status).toBe(401);
    }
    expect(statuses()).toEqual(['ACTIVE']);
  });

  it.each(Object.entries(MACHINE))('refuses the scoped %s credential', async (_name, token) => {
    addKey();
    for (const response of [await send('GET', BASE, bearer(token)), await revoke(bearer(token)), await reset(bearer(token))]) expect(response.status).toBe(403);
    expect(statuses()).toEqual(['ACTIVE']);
    expect(fixture.audit).toEqual([]);
  });
});

describe('node key administration: Oathweave sign-in', () => {
  const ISSUER = 'https://identity.example.com';
  const JWKS_URL = `${ISSUER}/oauth/jwks`;
  const USERINFO_URL = `${ISSUER}/oauth/userinfo`;
  let signingKey: CryptoKey;
  let jwks: JSONWebKeySet;
  let userinfoSubject = 'admin-subject';
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    signingKey = pair.privateKey;
    jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] };
  });
  const sign = (claims: Record<string, unknown>, subject: string) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer(ISSUER).setAudience('magnus')
      .setSubject(subject).setJti(`fixture-jti-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}`)
      .setIssuedAt(now).setExpirationTime(now + 300).sign(signingKey);
  };
  const person = async (subject: string, permissions: string[]) => {
    userinfoSubject = subject;
    return { headers: { Authorization: `Bearer ${await sign({ actorType: 'USER', sessionId: 'fixture-session', clientId: 'hivexui-magnus', roles: [], permissions }, subject)}` } };
  };
  beforeEach(() => {
    resetOathweaveVerifier();
    vi.stubEnv('OATHWEAVE_ISSUER', ISSUER);
    vi.stubEnv('OATHWEAVE_JWKS_URL', JWKS_URL);
    vi.stubEnv('OATHWEAVE_USERINFO_URL', USERINFO_URL);
    vi.stubEnv('MAGNUS_OATHWEAVE_IDENTITIES_JSON', JSON.stringify([
      { issuer: ISSUER, subject: 'ardent-studio', localUserId: 'ardent-studio', role: 'ARDENT_SERVICE' },
      { issuer: ISSUER, subject: 'admin-subject', localUserId: 'alice', role: 'ADMIN' },
      { issuer: ISSUER, subject: 'operator-subject', localUserId: 'carol', role: 'OPERATOR' },
      { issuer: ISSUER, subject: 'viewer-subject', localUserId: 'bob', role: 'VIEWER' },
    ]));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === JWKS_URL) return Response.json(jwks);
      if (url === USERINFO_URL) return Response.json({ sub: userinfoSubject });
      throw new Error(`unexpected request to ${url}`);
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('lets an ADMIN link with magnus:admin act, and audits the linked user', async () => {
    addKey();
    expect((await send('GET', BASE, await person('admin-subject', ['magnus:admin']))).status).toBe(200);
    const response = await revoke(await person('admin-subject', ['magnus:admin']), { reason: 'from the UI' });
    expect(response.status).toBe(200);
    expect(fixture.audit).toEqual([expect.objectContaining({ action: 'node.credential.revoke', actorId: 'alice', details: expect.objectContaining({ reason: 'from the UI' }) })]);
  });

  it('refuses an ADMIN link that only holds magnus:operate, and OPERATOR or VIEWER links', async () => {
    addKey();
    for (const [subject, permissions] of [['admin-subject', ['magnus:operate']], ['operator-subject', ['magnus:operate']], ['viewer-subject', ['magnus:view']]] as const) {
      for (const response of [await send('GET', BASE, await person(subject, [...permissions])), await revoke(await person(subject, [...permissions])),
        await reset(await person(subject, [...permissions]))]) expect(response.status, subject).toBe(403);
    }
    expect(statuses()).toEqual(['ACTIVE']);
    expect(fixture.audit).toEqual([]);
  });

  it('keeps a linked service identity off these routes', async () => {
    addKey();
    userinfoSubject = 'ardent-studio';
    const service = { headers: { Authorization: `Bearer ${await sign({ actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: 'ardent-studio', permissions: ['magnus:ardent'] }, 'ardent-studio')}` } };
    for (const response of [await send('GET', BASE, service), await revoke(service), await reset(service)]) expect(response.status).toBe(403);
    expect(statuses()).toEqual(['ACTIVE']);
  });
});
