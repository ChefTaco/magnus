import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { agentIdentityResponseSchema, magnusBrowserResponseSchema } from '@hivemagnus/magnus-contracts/browser';
import type { AppVariables } from '../types/index.js';

const API_SECRET = 'fixture-identity-api-secret-at-least-32-chars';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'fixture-identity-jwt-secret-at-least-32-chars', API_SECRET: 'fixture-identity-api-secret-at-least-32-chars',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '' }));
vi.mock('../services/credential-rotation-service.js', async original => ({ ...await original<object>(),
  verifyWithRotation: (_: string, expected: string, actual: string) => expected === actual,
}));
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));

interface ArdentRow { nodeId: string; name: string }
interface CredentialRow { nodeId: string; profile: string; agentId: string; workspaceId: string; createdAt: Date; leaseToken: string }
interface HermesRow { id: string; nodeId: string | null; name: string; apiServerKeyFingerprint: string }
const store = vi.hoisted(() => ({ ardent: [] as ArdentRow[], credentials: [] as CredentialRow[], hermes: [] as HermesRow[] }));
const db = vi.hoisted(() => ({
  ardentProfile: {
    findFirst: vi.fn(async ({ where }: { where: { name: string; installation: { nodeId: string } } }) => {
      const row = store.ardent.find(entry => entry.name === where.name && entry.nodeId === where.installation.nodeId);
      return row ? { name: row.name } : null;
    }),
  },
  ardentHiveMemCredential: {
    findUnique: vi.fn(async ({ where }: { where: { nodeId_profile: { nodeId: string; profile: string } } }) => {
      const row = store.credentials.find(entry => entry.nodeId === where.nodeId_profile.nodeId && entry.profile === where.nodeId_profile.profile);
      return row ? { agentId: row.agentId, workspaceId: row.workspaceId } : null;
    }),
    findMany: vi.fn(async ({ where, take }: { where: { agentId: string }; take: number }) => store.credentials
      .filter(entry => entry.agentId === where.agentId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, take)
      .map(entry => ({ nodeId: entry.nodeId, profile: entry.profile }))),
  },
  hermesProfile: {
    findMany: vi.fn(async ({ where, take }: { where: { name: string; installation: { nodeId: string } }; take: number }) => store.hermes
      .filter(entry => entry.name === where.name && entry.nodeId === where.installation.nodeId).slice(0, take).map(entry => ({ id: entry.id }))),
  },
}));
vi.mock('../db/index.js', () => ({ getDb: () => db }));

const { errorHandler } = await import('../middleware/error-handler.js');
const { signUserToken } = await import('../middleware/auth.js');
const { resetOathweaveVerifier } = await import('../middleware/oathweave-verifier.js');
const { ardentHiveMemAgentId } = await import('../services/ardent-hivemem.js');
const { agentIdentityRouter } = await import('./agent-identity.js');

const app = new Hono<AppVariables>().onError(errorHandler).route('/api/v1/agents', agentIdentityRouter);
const LEAD_ACTOR = ardentHiveMemAgentId('node-1', 'lead');
const CANARY_LEASE = 'canary-lease-token-value';
const CANARY_FINGERPRINT = 'canaryhermesfingerprint';

type Role = 'VIEWER' | 'OPERATOR' | 'ADMIN';
const tokenFor = (role: Role) => signUserToken({ userId: `fixture-${role.toLowerCase()}`, email: 'alice@example.com', role });
async function get(path: string, auth: Role | { apiSecret: string } | { bearer: string } | null = 'ADMIN') {
  const headers: Record<string, string> = {};
  if (auth && typeof auth === 'object' && 'apiSecret' in auth) headers['x-api-secret'] = auth.apiSecret;
  else if (auth && typeof auth === 'object') headers['Authorization'] = `Bearer ${auth.bearer}`;
  else if (auth) headers['Authorization'] = `Bearer ${await tokenFor(auth)}`;
  const response = await app.request(path, { headers });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as { success: boolean; data: Record<string, unknown>; error: { code: string } } };
}

beforeEach(() => {
  store.ardent = [{ nodeId: 'node-1', name: 'lead' }, { nodeId: 'node-1', name: 'scout' }];
  store.credentials = [
    { nodeId: 'node-1', profile: 'lead', agentId: LEAD_ACTOR, workspaceId: 'ardent-agents', createdAt: new Date('2026-01-01T00:00:00Z'), leaseToken: CANARY_LEASE },
    // A record whose profile has gone: Magnus no longer knows that agent.
    { nodeId: 'node-1', profile: 'gone', agentId: ardentHiveMemAgentId('node-1', 'gone'), workspaceId: 'ardent-agents', createdAt: new Date('2026-01-01T00:00:00Z'), leaseToken: CANARY_LEASE },
  ];
  store.hermes = [
    { id: 'hp-1', nodeId: 'node-1', name: 'default', apiServerKeyFingerprint: CANARY_FINGERPRINT },
    { id: 'hp-2', nodeId: 'node-1', name: 'lead', apiServerKeyFingerprint: CANARY_FINGERPRINT },
    { id: 'hp-3', nodeId: 'node-2', name: 'twin', apiServerKeyFingerprint: CANARY_FINGERPRINT },
    { id: 'hp-4', nodeId: 'node-2', name: 'twin', apiServerKeyFingerprint: CANARY_FINGERPRINT },
    { id: 'hp-5', nodeId: null, name: 'detached', apiServerKeyFingerprint: CANARY_FINGERPRINT },
  ];
  vi.clearAllMocks();
});

describe('GET /api/v1/agents/:agentRef/identity', () => {
  it('resolves an Ardent profile enrolled in HiveMem to its actor and workspace', async () => {
    const response = await get('/api/v1/agents/node-1~lead/identity');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: {
      agentRef: 'node-1~lead', nodeId: 'node-1', profile: 'lead', runtime: 'ardent', actorId: LEAD_ACTOR,
      workspaceId: 'ardent-agents', oathweaveSubject: null, emberpathClientKeyId: null,
    } });
    expect(LEAD_ACTOR).toMatch(/^ardent-lead-[0-9a-f]{8}$/u);
    // The published contract parses it, and the route table finds it by a concrete path.
    expect(agentIdentityResponseSchema.parse(response.body)).toEqual(response.body);
    expect(magnusBrowserResponseSchema('/agents/node-1~lead/identity')).toBe(agentIdentityResponseSchema);
    expect(magnusBrowserResponseSchema('/agents/identity?actorId=x')).toBe(agentIdentityResponseSchema);
  });

  it('leaves the actor null for an Ardent profile Magnus never enrolled', async () => {
    const response = await get('/api/v1/agents/node-1~scout/identity');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ runtime: 'ardent', actorId: null, workspaceId: null });
  });

  it('resolves a Hermes profile with no HiveMem identity', async () => {
    for (const role of ['VIEWER', 'OPERATOR', 'ADMIN'] as const) {
      const response = await get('/api/v1/agents/node-1~default/identity', role);
      expect(response.status, role).toBe(200);
      expect(response.body.data).toEqual({ agentRef: 'node-1~default', nodeId: 'node-1', profile: 'default', runtime: 'hermes',
        actorId: null, workspaceId: null, oathweaveSubject: null, emberpathClientKeyId: null });
    }
  });

  it('keeps Ardent profiles to ADMIN, as the Ardent routes do', async () => {
    for (const role of ['VIEWER', 'OPERATOR'] as const) {
      const scout = await get('/api/v1/agents/node-1~scout/identity', role);
      expect(scout.status, role).toBe(404);
      expect(scout.text).not.toContain('ardent');
      // A Hermes profile of the same name is still visible; the Ardent one is not hinted at.
      const lead = await get('/api/v1/agents/node-1~lead/identity', role);
      expect(lead.body.data).toMatchObject({ runtime: 'hermes', actorId: null });
    }
    expect((await get('/api/v1/agents/node-1~lead/identity', 'ADMIN')).body.data).toMatchObject({ runtime: 'ardent', actorId: LEAD_ACTOR });
  });

  it('answers 404 for an unknown agent, node or detached Hermes installation', async () => {
    for (const ref of ['node-1~nobody', 'node-9~lead', 'node-1~gone', 'node-1~detached']) {
      const response = await get(`/api/v1/agents/${ref}/identity`);
      expect(response.status, ref).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('refuses a reference two Hermes installations on one node share', async () => {
    const response = await get('/api/v1/agents/node-2~twin/identity');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('AGENT_REF_AMBIGUOUS');
  });

  it('rejects malformed references before reading anything', async () => {
    const long = 'a'.repeat(129);
    for (const ref of ['node-1', 'node-1~', '~lead', 'node-1~lead~x', '~', 'node%201~lead', 'node-1~le%24d', `${long}~lead`, `node-1~${long}`, 'node-1%7Elead%7Ex']) {
      const response = await get(`/api/v1/agents/${ref}/identity`);
      expect(response.status, ref).toBe(400);
      expect(response.body.error.code, ref).toBe('INVALID_AGENT_REF');
    }
    expect(db.ardentProfile.findFirst).not.toHaveBeenCalled();
    expect(db.hermesProfile.findMany).not.toHaveBeenCalled();
    // An encoded separator is the same reference.
    expect((await get('/api/v1/agents/node-1%7Elead/identity')).body.data).toMatchObject({ agentRef: 'node-1~lead' });
  });

  it('never returns a credential, lease or fingerprint', async () => {
    for (const path of ['/api/v1/agents/node-1~lead/identity', '/api/v1/agents/node-1~default/identity', `/api/v1/agents/identity?actorId=${LEAD_ACTOR}`]) {
      const { text } = await get(path);
      expect(text).not.toContain(CANARY_LEASE);
      expect(text).not.toContain(CANARY_FINGERPRINT);
    }
  });
});

describe('GET /api/v1/agents/identity?actorId=', () => {
  it('finds the Ardent profile that holds a HiveMem actor', async () => {
    const response = await get(`/api/v1/agents/identity?actorId=${LEAD_ACTOR}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ agentRef: 'node-1~lead', nodeId: 'node-1', profile: 'lead', runtime: 'ardent', actorId: LEAD_ACTOR,
      workspaceId: 'ardent-agents', oathweaveSubject: null, emberpathClientKeyId: null });
  });

  it('answers 404 for an unknown actor, or one whose profile is gone', async () => {
    for (const actorId of ['ardent-nobody-00000000', ardentHiveMemAgentId('node-1', 'gone')]) {
      const response = await get(`/api/v1/agents/identity?actorId=${actorId}`);
      expect(response.status, actorId).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('answers 404 below ADMIN, because only Ardent profiles have an actor', async () => {
    for (const role of ['VIEWER', 'OPERATOR'] as const) expect((await get(`/api/v1/agents/identity?actorId=${LEAD_ACTOR}`, role)).status, role).toBe(404);
    expect(db.ardentHiveMemCredential.findMany).not.toHaveBeenCalled();
  });

  it('refuses two profiles that claim one actor', async () => {
    store.ardent.push({ nodeId: 'node-3', name: 'lead' });
    store.credentials.push({ nodeId: 'node-3', profile: 'lead', agentId: LEAD_ACTOR, workspaceId: 'ardent-agents', createdAt: new Date('2026-02-01T00:00:00Z'), leaseToken: CANARY_LEASE });
    const response = await get(`/api/v1/agents/identity?actorId=${LEAD_ACTOR}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('AGENT_REF_AMBIGUOUS');
  });

  it('rejects a missing or malformed actor ID', async () => {
    for (const query of ['', '?actorId=', '?actorId=a', `?actorId=${'a'.repeat(33)}`, '?actorId=Ardent-Lead', '?actorId=ardent%2Flead', '?actorId=node-1~lead']) {
      const response = await get(`/api/v1/agents/identity${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code, query).toBe('VALIDATION_ERROR');
    }
    expect(db.ardentHiveMemCredential.findMany).not.toHaveBeenCalled();
  });
});

describe('agent identity authorization', () => {
  const ISSUER = 'https://identity.example.com';
  const JWKS_URL = `${ISSUER}/oauth/jwks`;
  const USERINFO_URL = `${ISSUER}/oauth/userinfo`;
  let signingKey: CryptoKey;
  let jwks: JSONWebKeySet;
  /** Oathweave checks each token online; userinfo answers for the subject the test signs. */
  let userinfoSubject = 'admin-subject';
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    signingKey = pair.privateKey;
    jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] };
  });
  const sign = (claims: Record<string, unknown>, subject: string) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer(ISSUER).setAudience('magnus')
      .setSubject(subject).setJti('fixture-jti').setIssuedAt(now).setExpirationTime(now + 300).sign(signingKey);
  };
  const person = (subject: string, permissions: string[]) => {
    userinfoSubject = subject;
    return sign({ actorType: 'USER', sessionId: 'fixture-session', clientId: 'hivexui-magnus', roles: [], permissions }, subject);
  };
  beforeEach(() => {
    resetOathweaveVerifier();
    vi.stubEnv('OATHWEAVE_ISSUER', ISSUER);
    vi.stubEnv('OATHWEAVE_JWKS_URL', JWKS_URL);
    vi.stubEnv('OATHWEAVE_USERINFO_URL', USERINFO_URL);
    vi.stubEnv('MAGNUS_OATHWEAVE_IDENTITIES_JSON', JSON.stringify([
      { issuer: ISSUER, subject: 'ardent-studio', localUserId: 'ardent-studio', role: 'ARDENT_SERVICE' },
      { issuer: ISSUER, subject: 'admin-subject', localUserId: 'alice', role: 'ADMIN' },
      { issuer: ISSUER, subject: 'viewer-subject', localUserId: 'bob', role: 'VIEWER' },
    ]));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === JWKS_URL) return Response.json(jwks);
      if (url === USERINFO_URL) return Response.json({ sub: userinfoSubject });
      throw new Error(`unexpected request to ${url}`);
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('needs a credential on both routes', async () => {
    for (const path of ['/api/v1/agents/node-1~lead/identity', `/api/v1/agents/identity?actorId=${LEAD_ACTOR}`]) {
      expect((await get(path, null)).status, path).toBe(401);
      expect((await get(path, { bearer: 'not-a-token' })).status, path).toBe(401);
      expect((await get(path, { apiSecret: 'wrong-secret-value-of-sufficient-length' })).status, path).toBe(401);
    }
    expect(db.ardentProfile.findFirst).not.toHaveBeenCalled();
  });

  it('treats the API secret as the system administrator, as other reads do', async () => {
    const response = await get('/api/v1/agents/node-1~lead/identity', { apiSecret: API_SECRET });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ runtime: 'ardent', actorId: LEAD_ACTOR });
  });

  it('maps Oathweave permissions: magnus:view reads Hermes, magnus:admin also reads Ardent', async () => {
    const viewer = await person('viewer-subject', ['magnus:view']);
    expect((await get('/api/v1/agents/node-1~default/identity', { bearer: viewer })).status).toBe(200);
    expect((await get('/api/v1/agents/node-1~scout/identity', { bearer: viewer })).status).toBe(404);
    const admin = await person('admin-subject', ['magnus:admin']);
    expect((await get('/api/v1/agents/node-1~scout/identity', { bearer: admin })).body.data).toMatchObject({ runtime: 'ardent' });
    expect((await get(`/api/v1/agents/identity?actorId=${LEAD_ACTOR}`, { bearer: admin })).status).toBe(200);
    // A token with no Magnus permission is refused.
    expect((await get('/api/v1/agents/node-1~default/identity', { bearer: await person('admin-subject', ['hivemem:view']) })).status).toBe(403);
  });

  it('keeps a linked service identity on the Ardent bridge', async () => {
    userinfoSubject = 'ardent-studio';
    const service = await sign({ actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: 'ardent-studio', permissions: ['magnus:ardent'] }, 'ardent-studio');
    for (const path of ['/api/v1/agents/node-1~lead/identity', `/api/v1/agents/identity?actorId=${LEAD_ACTOR}`])
      expect((await get(path, { bearer: service })).status, path).toBe(403);
  });
});
