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
const mocks = vi.hoisted(() => ({ deploy: vi.fn(), hivemem: vi.fn(), resume: vi.fn(), operation: vi.fn(), action: vi.fn(), read: vi.fn(), audit: vi.fn(), list: vi.fn(), release: vi.fn(), studio: vi.fn() }));
vi.mock('../services/ardent-agent-deploy.js', () => ({
  startArdentAgentDeploy: mocks.deploy, startArdentHiveMemEnable: mocks.hivemem, resumeArdentAgentOperation: mocks.resume, getArdentAgentOperation: mocks.operation,
}));
vi.mock('../services/ardent-service.js', () => ({
  performArdentAction: mocks.action, getArdentProfileResource: mocks.read, listArdentInstallations: mocks.list, requireArdentStudioAgent: mocks.studio,
  streamArdentProfileResource: vi.fn(), getArdentContextAdoption: vi.fn(), getArdentContextRelease: vi.fn(), getArdentInstallation: vi.fn(),
}));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: mocks.audit }));
vi.mock('../services/ardent-hiveskills.js', () => ({ fetchArdentSkillRelease: mocks.release }));

const { authMiddleware } = await import('../middleware/auth.js');
const { errorHandler } = await import('../middleware/error-handler.js');
const { resetOathweaveVerifier } = await import('../middleware/oathweave-verifier.js');
const { ardentRouter } = await import('./ardent.js');
const { AgentResponseError } = await import('../sdk/node-api-client.js');

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
const REVISION = 'a'.repeat(64);
const CONFIG = `schema_version: 1
profile: lead
name: Lead
execution:
  backend: llamacpp
  max_model_steps: 12
  max_tool_calls: 24
  max_parallel_tools: 4
  deadline_seconds: 900
  max_delegation_depth: 1
providers:
  llamacpp:
    base_url: http://127.0.0.1:8080/v1
    model: local-model
    api_key_env: LLAMACPP_API_KEY
    request_timeout_seconds: 120
  codex:
    command: codex
    model: codex-model
    auth_mode: chatgpt
    approval_policy: never
    sandbox: read-only
skills:
  directories: [skills]
  enabled: [web-research]
api:
  host: 127.0.0.1
  port: 9910
  token_env: ARDENT_API_TOKEN
`;
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
  mocks.read.mockImplementation(async (_node: string, _profile: string, resource: string) => resource === 'config' ? { revision: REVISION, text: CONFIG } : { ok: true });
  mocks.list.mockResolvedValue([]);
  mocks.release.mockResolvedValue({ sha256: 'd'.repeat(64), archiveBase64: 'H4sIAAAA', files: 2 });
  mocks.studio.mockResolvedValue(undefined);
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
    // Providers, channels, peers and histories stay with ADMIN people.
    for (const resource of ['config/schema', 'providers', 'peers/config', 'channels', 'identity/soul/history']) expect((await call(token, 'GET', `${profile}/${resource}`)).status, resource).toBe(403);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('may open sessions and submit or cancel tasks, and no other action', async () => {
    const token = await serviceToken();
    const submit = await call(token, 'POST', `${profile}/action`, { body: { action: 'task-submit', body: { prompt: 'Hi', idempotency_key: '00000000-0000-4000-8000-000000000001' } } });
    expect(submit.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ardent.task-submit', actorId: 'service:ardent:ardent-studio',
      details: expect.objectContaining({ serviceClientId: 'ardent-studio' }) }));
    for (const action of ['config-validate', 'service-stop', 'identity-restore', 'peer-save', 'package-install'])
      expect((await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body: { action, body: {} } })).status, action).toBe(403);
    expect(mocks.action).toHaveBeenCalledTimes(1);
  });

  it('changes identity, skills and configuration only for an acting ADMIN, and audits both', async () => {
    const token = await serviceToken();
    const requests = [
      { action: 'identity-save', target: 'soul', body: { text: '# Soul\nCalm and exact.', revision: REVISION } },
      { action: 'skill-set', target: 'web-research', body: { enabled: true, revision: REVISION } },
      { action: 'config-save', body: { text: CONFIG.replace('model: local-model', 'model: other-model'), revision: REVISION } },
    ];
    for (const body of requests) {
      const missing = await call(token, 'POST', `${profile}/action`, { body });
      expect(missing.status, body.action).toBe(403);
      expect((await missing.json()).error.code).toBe('ACTING_ADMIN_REQUIRED');
      const operator = await call(token, 'POST', `${profile}/action`, { acting: 'operator-subject', body });
      expect(operator.status, body.action).toBe(403);
      expect((await operator.json()).error.code).toBe('ACTING_ADMIN_REQUIRED');
      const unlinked = await call(token, 'POST', `${profile}/action`, { acting: 'stranger', body });
      expect((await unlinked.json()).error.code).toBe('ACTING_SUBJECT_UNLINKED');
      expect(mocks.action, body.action).not.toHaveBeenCalled();
      const admin = await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body });
      expect(admin.status, body.action).toBe(200);
      expect(mocks.action).toHaveBeenLastCalledWith('node-1', 'lead', body.action, 'target' in body ? body.target : undefined, body.body);
      expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: `ardent.${body.action}`, actorId: 'alice',
        details: expect.objectContaining({ serviceActor: 'service:ardent:ardent-studio', serviceClientId: 'ardent-studio', actingSubject: 'admin-subject' }) }));
      mocks.action.mockClear();
    }
    expect(mocks.audit.mock.calls.at(-1)![0]).toMatchObject({ details: { configPaths: ['providers.llamacpp.model'] } });
    // The audit keeps identifiers and paths, never identity or configuration text.
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/Calm and exact|other-model/);
  });

  it('checks change bodies and targets before anything reaches the node', async () => {
    const token = await serviceToken();
    const bad = [
      { action: 'identity-save', target: 'agents', body: { text: 'x', revision: REVISION } },
      { action: 'identity-save', target: 'soul', body: { text: 'x' } },
      { action: 'skill-set', body: { enabled: true, revision: REVISION } },
      { action: 'skill-set', target: 'web-research', body: { enabled: 'yes', revision: REVISION } },
      { action: 'config-save', body: { text: CONFIG, revision: 'stale' } },
    ];
    for (const body of bad) expect((await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body })).status, JSON.stringify(body)).toBe(400);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('installs a HiveSkills release only for an acting ADMIN, sending the node the release Magnus fetched', async () => {
    const token = await serviceToken();
    const request = { action: 'skill-install', body: { source: 'hiveskills', name: 'web-research', version: '1.2.0', enable: true, revision: REVISION } };
    for (const acting of [undefined, 'operator-subject']) {
      const refused = await call(token, 'POST', `${profile}/action`, { ...(acting ? { acting } : {}), body: request });
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.code).toBe('ACTING_ADMIN_REQUIRED');
    }
    expect(mocks.release).not.toHaveBeenCalled();
    mocks.action.mockResolvedValueOnce({ source: 'hiveskills', name: 'web-research', version: '1.2.0', sha256: 'd'.repeat(64), files: 2,
      changed: true, enabled: true, revision: 'e'.repeat(64), enable_error: null, activation_required: true });
    const installed = await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body: { ...request, body: { ...request.body, archive_base64: 'caller-bytes' } } });
    expect(installed.status).toBe(400);
    const admin = await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body: request });
    expect(admin.status).toBe(200);
    expect((await admin.json()).data).toMatchObject({ changed: true, enabled: true });
    expect(mocks.studio).toHaveBeenCalledWith('node-1', 3);
    expect(mocks.release).toHaveBeenCalledWith(request.body);
    expect(mocks.action).toHaveBeenCalledWith('node-1', 'lead', 'skill-install', undefined, { ...request.body, sha256: 'd'.repeat(64), archive_base64: 'H4sIAAAA' });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'ardent.skill-install', actorId: 'alice', details: expect.objectContaining({
      actingSubject: 'admin-subject', name: 'web-research', version: '1.2.0', channel: 'stable', enable: true, sha256: 'd'.repeat(64), files: 2 }) }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('H4sIAAAA');
  });

  it('reports catalog and node refusals of a skill installation and audits a failed fetch', async () => {
    const token = await serviceToken();
    const { HttpError } = await import('../middleware/error-handler.js');
    const body = { action: 'skill-install', body: { source: 'hiveskills', name: 'web-research', version: '1.2.0' } };
    mocks.release.mockRejectedValueOnce(new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', 'web-research 1.2.0 is not the release promoted on the stable channel'));
    const stale = await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('SKILL_VERSION_UNAVAILABLE');
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'ardent.skill-install',
      details: expect.objectContaining({ outcome: 'failed', code: 'SKILL_VERSION_UNAVAILABLE', dispatched: false }) }));
    mocks.action.mockRejectedValueOnce(new AgentResponseError(409, { code: 'SKILL_CONFLICT', message: 'The profile has a skill named web-research that Magnus did not install; rename or remove it first' }));
    const conflict = await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toMatchObject({ code: 'SKILL_CONFLICT', message: expect.stringContaining('did not install') });
    mocks.action.mockRejectedValueOnce(new AgentResponseError(400, { code: 'SKILL_ARCHIVE_INVALID', message: 'Skill archive digest differs from the catalog release' }));
    expect((await (await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body })).json()).error.code).toBe('SKILL_ARCHIVE_INVALID');
    expect((await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body: { ...body, target: 'web-research' } })).status).toBe(400);
  });

  it('passes on a stale revision as 409 CONFLICT', async () => {
    const token = await serviceToken();
    mocks.action.mockRejectedValueOnce(new AgentResponseError(409, { code: 'CONFLICT', message: 'Configuration revision conflict' }));
    const stale = await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body: { action: 'skill-set', target: 'web-research', body: { enabled: false, revision: REVISION } } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('CONFLICT');
    mocks.action.mockRejectedValueOnce(new AgentResponseError(400, { code: 'INVALID_REQUEST', message: 'Invalid Ardent config: artifacts.max_bytes: Too big' }));
    const invalid = await call(token, 'POST', `${profile}/action`, { acting: 'admin-subject',
      body: { action: 'config-save', body: { text: `${CONFIG}artifacts:\n  max_bytes: 999999999999\n`, revision: REVISION } } });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.message).toMatch(/artifacts\.max_bytes/);
  });

  it('reads configuration only for an acting ADMIN, and only its text and revision', async () => {
    const token = await serviceToken();
    mocks.read.mockResolvedValue({ revision: REVISION, text: CONFIG, extra: 'never passed on' });
    const missing = await call(token, 'GET', `${profile}/config`);
    expect(missing.status).toBe(403);
    expect((await missing.json()).error.code).toBe('ACTING_ADMIN_REQUIRED');
    const operator = await call(token, 'GET', `${profile}/config`, { acting: 'operator-subject' });
    expect((await operator.json()).error.code).toBe('ACTING_ADMIN_REQUIRED');
    expect(mocks.read).not.toHaveBeenCalled();
    const admin = await call(token, 'GET', `${profile}/config`, { acting: 'admin-subject' });
    expect(admin.status).toBe(200);
    expect((await admin.json()).data).toEqual({ revision: REVISION, text: CONFIG });
    // Identity files carry their revisions without an acting person, as before.
    expect((await call(token, 'GET', `${profile}/identity/soul`)).status).toBe(200);
  });

  it('limits a service\'s config-save to the allowlisted paths', async () => {
    const token = await serviceToken();
    const save = (text: string, revision = REVISION) => call(token, 'POST', `${profile}/action`, { acting: 'admin-subject', body: { action: 'config-save', body: { text, revision } } });
    const allowed: Array<[string, string[]]> = [
      [CONFIG.replace('backend: llamacpp', 'backend: codex').replace('model: codex-model', 'model: codex-next'), ['execution.backend', 'providers.codex.model']],
      [CONFIG.replace('request_timeout_seconds: 120', 'request_timeout_seconds: 300\n    reasoning_effort: low'), ['providers.llamacpp.reasoning_effort', 'providers.llamacpp.request_timeout_seconds']],
      [CONFIG.replace('enabled: [web-research]', 'enabled: [web-research, writing]'), ['skills.enabled']],
      [`${CONFIG}artifacts:\n  max_bytes: 67108864\n`, ['artifacts.max_bytes']],
      [`# Edited in a studio\n${CONFIG}`, []],
    ];
    for (const [text, paths] of allowed) {
      expect((await save(text)).status, text).toBe(200);
      expect(mocks.audit.mock.calls.at(-1)![0], text).toMatchObject({ details: { configPaths: paths } });
    }
    const forbidden: Array<[string, string]> = [
      [CONFIG.replace('port: 9910', 'port: 9911'), 'api.port'],
      [CONFIG.replace('token_env: ARDENT_API_TOKEN', 'token_env: OTHER_TOKEN'), 'api.token_env'],
      [CONFIG.replace('base_url: http://127.0.0.1:8080/v1', 'base_url: https://collector.example.com/v1'), 'providers.llamacpp.base_url'],
      [CONFIG.replace('api_key_env: LLAMACPP_API_KEY', 'api_key_env: ARDENT_API_TOKEN'), 'providers.llamacpp.api_key_env'],
      [CONFIG.replace('command: codex', 'command: /tmp/run-anything'), 'providers.codex.command'],
      [CONFIG.replace('auth_mode: chatgpt', 'auth_mode: api_key'), 'providers.codex.auth_mode'],
      [CONFIG.replace('directories: [skills]', 'directories: [skills, ../other]'), 'skills.directories'],
      [`${CONFIG}channels:\n  telegram:\n    enabled: true\n`, 'channels.telegram.enabled'],
      [`${CONFIG}a2a:\n  enabled: true\n  listen_host: 0.0.0.0\n`, 'a2a.enabled'],
      [`${CONFIG}memory:\n  provider: none\n`, 'memory.provider'],
      [`${CONFIG}plugins: [left-pad]\n`, 'plugins'],
      [`${CONFIG}skills.enabled: [writing]\n`, 'skills.enabled'],
      [CONFIG.replace(/providers:[\s\S]*?skills:/, 'providers: none\nskills:'), 'providers'],
      ['[]\n', '(document)'],
    ];
    for (const [text, path] of forbidden) {
      const refused = await save(text);
      expect(refused.status, path).toBe(403);
      const error = (await refused.json()).error as { code: string; message: string };
      expect(error.code).toBe('CONFIG_PATH_FORBIDDEN');
      expect(error.message, path).toContain(path);
    }
    // A change the allowlist permits beside one it does not is refused whole.
    const mixed = await save(CONFIG.replace('model: local-model', 'model: other-model').replace('port: 9910', 'port: 9911'));
    expect((await mixed.json()).error.message).not.toContain('providers.llamacpp.model');
    const stale = await save(CONFIG, 'b'.repeat(64));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('CONFLICT');
    expect((await save('model: [unclosed\n')).status).toBe(400);
    expect((await save(`${CONFIG}name: Second\n`)).status).toBe(400);
    expect(mocks.action).toHaveBeenCalledTimes(allowed.length);
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
  it('let an ADMIN change any configuration path, with no allowlist', async () => {
    const admin = await userToken('admin-subject', ['magnus:admin']);
    const body = { action: 'config-save', body: { text: CONFIG.replace('port: 9910', 'port: 9911'), revision: REVISION } };
    expect((await call(admin, 'POST', `${profile}/action`, { body })).status).toBe(200);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alice', details: expect.not.objectContaining({ configPaths: expect.anything() }) }));
  });

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
