import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import type { AppVariables } from '../types/index.js';

vi.mock('../utils/env.js', async (original) => ({
  ...await original<typeof import('../utils/env.js')>(),
  JWT_SECRET: 'fixture-jwt-secret-for-unit-tests-at-least-32',
  API_SECRET: 'fixture-api-secret-for-unit-tests-at-least-32',
  IAM_CORE_URL: '',
}));
vi.mock('../middleware/user-status.js', () => ({ getCurrentUserStatus: vi.fn(async () => ({ active: true, role: 'ADMIN' })), invalidateUserStatus: vi.fn() }));
const mocks = vi.hoisted(() => ({ deploy: vi.fn(), hivemem: vi.fn(), resume: vi.fn(), operation: vi.fn(), action: vi.fn(), read: vi.fn(), audit: vi.fn(), list: vi.fn() }));
vi.mock('../services/ardent-agent-deploy.js', () => ({
  startArdentAgentDeploy: mocks.deploy, startArdentHiveMemEnable: mocks.hivemem, resumeArdentAgentOperation: mocks.resume, getArdentAgentOperation: mocks.operation,
}));
vi.mock('../services/ardent-service.js', () => ({
  performArdentAction: mocks.action, getArdentProfileResource: mocks.read, listArdentInstallations: mocks.list, requireArdentStudioAgent: vi.fn(),
  streamArdentProfileResource: vi.fn(), getArdentContextAdoption: vi.fn(), getArdentContextRelease: vi.fn(), getArdentInstallation: vi.fn(),
}));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: mocks.audit }));

const { authMiddleware } = await import('../middleware/auth.js');
const { errorHandler } = await import('../middleware/error-handler.js');
const { resetOathweaveVerifier } = await import('../middleware/oathweave-verifier.js');
const { ardentRouter } = await import('./ardent.js');

const ISSUER = 'https://identity.example.com';
const JWKS_URL = `${ISSUER}/oauth/jwks`;
const USERINFO_URL = `${ISSUER}/oauth/userinfo`;
const SERVICE = { issuer: ISSUER, subject: 'ardent-studio', localUserId: 'ardent-studio', role: 'ARDENT_SERVICE' };
const LINKS = [SERVICE,
  { issuer: ISSUER, subject: 'admin-subject', localUserId: 'alice', role: 'ADMIN' },
  { issuer: ISSUER, subject: 'operator-subject', localUserId: 'bob', role: 'OPERATOR' }];
let signingKey: CryptoKey;
let jwks: JSONWebKeySet;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] };
});

function sign(claims: Record<string, unknown>, subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer(ISSUER).setAudience('magnus')
    .setSubject(subject).setJti('fixture-jti').setIssuedAt(now).setExpirationTime(now + 300).sign(signingKey);
}
const serviceToken = (claims: Record<string, unknown> = {}, subject = 'ardent-studio') =>
  sign({ actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: subject, permissions: ['magnus:ardent'], ...claims }, subject);
const userToken = (subject: string, permissions: string[]) =>
  sign({ actorType: 'USER', sessionId: 'fixture-session', clientId: 'hivexui-magnus', roles: [], permissions }, subject);

function app() {
  const instance = new Hono<AppVariables>();
  instance.onError(errorHandler);
  instance.route('/api/v1/ardent', ardentRouter);
  // A route outside the bridge, to prove a service identity cannot reach it.
  instance.use('/api/v1/nodes', authMiddleware);
  instance.get('/api/v1/nodes', c => c.json({ success: true, data: [] }));
  return instance;
}
const call = (token: string, method: string, path: string, options: { body?: unknown; acting?: string } = {}) => app().request(path, {
  method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.acting ? { 'x-acting-subject': options.acting } : {}) },
  ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
});
const profile = '/api/v1/ardent/installations/node-1/profiles/lead';
const operation = '/api/v1/ardent/agents/operations/00000000-0000-4000-8000-0000000000aa';

beforeEach(() => {
  vi.clearAllMocks();
  resetOathweaveVerifier();
  vi.stubEnv('OATHWEAVE_ISSUER', ISSUER);
  vi.stubEnv('OATHWEAVE_JWKS_URL', JWKS_URL);
  vi.stubEnv('OATHWEAVE_USERINFO_URL', USERINFO_URL);
  vi.stubEnv('MAGNUS_OATHWEAVE_IDENTITIES_JSON', JSON.stringify(LINKS));
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === JWKS_URL) return Response.json(jwks);
    if (url === USERINFO_URL) return Response.json({ sub: 'admin-subject' });
    throw new Error(`unexpected request to ${url}`);
  });
  mocks.deploy.mockResolvedValue('00000000-0000-4000-8000-0000000000aa');
  mocks.hivemem.mockResolvedValue('00000000-0000-4000-8000-0000000000ab');
  mocks.resume.mockResolvedValue('00000000-0000-4000-8000-0000000000aa');
  mocks.operation.mockResolvedValue({ id: 'op', status: 'running' });
  mocks.action.mockResolvedValue({ task_id: 'task', state: 'queued' });
  mocks.read.mockResolvedValue({ ok: true });
  mocks.list.mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('linked Ardent service identity', () => {
  it('reaches the bridge routes and nothing else', async () => {
    const token = await serviceToken();
    expect((await call(token, 'GET', '/api/v1/ardent/profiles')).status).toBe(200);
    expect((await call(token, 'GET', `${profile}/status`)).status).toBe(200);
    expect((await call(token, 'GET', operation)).status).toBe(200);
    expect((await call(token, 'GET', '/api/v1/nodes')).status).toBe(403);
    // Configuration, providers and peers stay with ADMIN people.
    for (const resource of ['config', 'providers', 'peers/config', 'channels']) expect((await call(token, 'GET', `${profile}/${resource}`)).status, resource).toBe(403);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('may open sessions and submit or cancel tasks, and no other action', async () => {
    const token = await serviceToken();
    const submit = await call(token, 'POST', `${profile}/action`, { body: { action: 'task-submit', body: { prompt: 'Hi', idempotency_key: '00000000-0000-4000-8000-000000000001' } } });
    expect(submit.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ardent.task-submit', actorId: 'service:ardent:ardent-studio',
      details: expect.objectContaining({ serviceClientId: 'ardent-studio' }) }));
    for (const action of ['config-save', 'service-stop', 'identity-save', 'package-install'])
      expect((await call(token, 'POST', `${profile}/action`, { body: { action, body: {} } })).status, action).toBe(403);
    expect(mocks.action).toHaveBeenCalledTimes(1);
  });

  it('records the person it acts for, who must be linked', async () => {
    const token = await serviceToken();
    const cancel = await call(token, 'POST', `${profile}/action`, { acting: 'operator-subject', body: { action: 'task-cancel', target: '00000000-0000-4000-8000-000000000001' } });
    expect(cancel.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'bob',
      details: expect.objectContaining({ serviceActor: 'service:ardent:ardent-studio', actingSubject: 'operator-subject' }) }));
    const unlinked = await call(token, 'POST', `${profile}/action`, { acting: 'stranger', body: { action: 'task-cancel', target: '00000000-0000-4000-8000-000000000001' } });
    expect(unlinked.status).toBe(403);
    expect((await unlinked.json()).error.code).toBe('ACTING_SUBJECT_UNLINKED');
    // A service link is never a person to act for.
    expect((await call(token, 'POST', `${profile}/action`, { acting: 'ardent-studio', body: { action: 'task-cancel', target: '00000000-0000-4000-8000-000000000001' } })).status).toBe(403);
  });

  it('may submit missions, pause and resume tasks and read mission resources', async () => {
    const token = await serviceToken();
    const task = '00000000-0000-4000-8000-000000000001';
    const mission = { id: 'p1:brief', revision: 2, parent_task: null, constraints: [], allowed_actions: ['analyze'], resources: ['project:p1'],
      deadline: 4_102_444_800, acceptance_criteria: ['A brief'], expected_artifacts: [] };
    const submitted = await call(token, 'POST', `${profile}/action`, { body: { action: 'mission-submit',
      body: { objective: 'Write the secret plan', mission, context_items: [{ title: 'Notes', text: 'private context' }], idempotency_key: 'p1:brief:2' } } });
    expect(submitted.status).toBe(200);
    const audit = mocks.audit.mock.calls.at(-1)![0] as { action: string; details: Record<string, unknown> };
    expect(audit).toMatchObject({ action: 'ardent.mission-submit', details: { missionId: 'p1:brief', missionRevision: 2, idempotencyKey: 'p1:brief:2' } });
    // The audit keeps identifiers, never the objective or the context.
    expect(JSON.stringify(audit)).not.toMatch(/secret plan|private context/);
    for (const action of ['task-pause', 'task-resume']) expect((await call(token, 'POST', `${profile}/action`, { body: { action, target: task } })).status, action).toBe(200);
    for (const resource of [`tasks/${task}/artifacts`, `artifacts/${'a'.repeat(64)}/manifest`, 'development?kind=skill_change', 'sessions?context=mission'])
      expect((await call(token, 'GET', `${profile}/${resource}`)).status, resource).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith('node-1', 'lead', 'development', { kind: 'skill_change' });
    expect(mocks.read).toHaveBeenCalledWith('node-1', 'lead', 'sessions', { context: 'mission' });
  });

  it('runs previews and development notes only for a named, linked person', async () => {
    const token = await serviceToken();
    const requests = [{ action: 'preview-submit', body: { prompt: 'Hello', overrides: { soul: '# Draft soul' } } },
      { action: 'development-note', body: { kind: 'operator_note', title: 'Tone', body: 'Shorter answers' } }];
    for (const body of requests) {
      const missing = await call(token, 'POST', `${profile}/action`, { body });
      expect(missing.status, body.action).toBe(403);
      expect((await missing.json()).error.code).toBe('ACTING_SUBJECT_REQUIRED');
      expect((await call(token, 'POST', `${profile}/action`, { acting: 'stranger', body })).status).toBe(403);
      // Any linked role will do: a preview or a note changes no agent.
      expect((await call(token, 'POST', `${profile}/action`, { acting: 'operator-subject', body })).status, body.action).toBe(200);
    }
    expect(mocks.action).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ardent.preview-submit', actorId: 'bob',
      details: expect.objectContaining({ overrides: ['soul'], actingSubject: 'operator-subject' }) }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ardent.development-note', actorId: 'bob', details: expect.objectContaining({ kind: 'operator_note' }) }));
  });

  it('creates agents, resumes and enables HiveMem only for an acting ADMIN', async () => {
    const token = await serviceToken();
    const requests: Array<[string, string]> = [['POST', '/api/v1/ardent/agents'], ['POST', `${operation}/resume`], ['POST', `${profile}/hivemem`]];
    for (const [method, path] of requests) {
      const missing = await call(token, method, path, { body: {} });
      expect(missing.status, path).toBe(403);
      expect((await missing.json()).error.code).toBe('ACTING_ADMIN_REQUIRED');
      const operator = await call(token, method, path, { acting: 'operator-subject', body: {} });
      expect((await operator.json()).error.code).toBe('ACTING_ADMIN_REQUIRED');
      expect((await call(token, method, path, { acting: 'admin-subject', body: {} })).status, path).toBe(202);
    }
    expect(mocks.deploy).toHaveBeenCalledWith({}, { actorId: 'alice', details: { serviceActor: 'service:ardent:ardent-studio', serviceClientId: 'ardent-studio', actingSubject: 'admin-subject' } });
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.hivemem).toHaveBeenCalledWith('node-1', 'lead', expect.objectContaining({ actorId: 'alice' }));
  });

  it('refuses an unlinked client, a token without magnus:ardent, and a person using a service link', async () => {
    expect((await call(await serviceToken({}, 'other-client'), 'GET', '/api/v1/ardent/profiles')).status).toBe(403);
    expect((await call(await serviceToken({ permissions: ['magnus:admin'] }), 'GET', '/api/v1/ardent/profiles')).status).toBe(403);
    expect((await call(await serviceToken({ sessionId: 'session' }), 'GET', '/api/v1/ardent/profiles')).status).toBe(401);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => String(input) === JWKS_URL ? Response.json(jwks) : Response.json({ sub: 'ardent-studio' }));
    const person = await call(await userToken('ardent-studio', ['magnus:admin']), 'GET', '/api/v1/ardent/profiles');
    expect(person.status).toBe(403);
  });
});

describe('Ardent routes for people', () => {
  it('keep ADMIN-only access and need no acting subject', async () => {
    const admin = await userToken('admin-subject', ['magnus:admin']);
    expect((await call(admin, 'POST', '/api/v1/ardent/agents', { body: {} })).status).toBe(202);
    expect(mocks.deploy).toHaveBeenCalledWith({}, { actorId: 'alice', details: {} });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => String(input) === JWKS_URL ? Response.json(jwks) : Response.json({ sub: 'operator-subject' }));
    const operator = await userToken('operator-subject', ['magnus:operate']);
    for (const [method, path] of [['GET', '/api/v1/ardent/profiles'], ['POST', '/api/v1/ardent/agents'], ['GET', operation]] as const)
      expect((await call(operator, method, path, { body: method === 'POST' ? {} : undefined })).status, path).toBe(403);
  });
});
