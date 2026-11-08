import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARDENT_HIVEMEM_SERVICE_SCOPE, ardentHiveMemAgentId, ardentHiveMemSettings, ardentHiveMemSupportsRenewal, HiveMemEnrollmentError, planArdentHiveMemCredential, prepareArdentHiveMem,
  requestArdentHiveMemCredential, resetArdentHiveMemTokens } from './ardent-hivemem.js';

const env = { MAGNUS_ARDENT_HIVEMEM_URL: 'https://memory.example.com/api/hivemem', MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN: 'fixture-enrollment-token',
  MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID: 'agents' };
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.fixture-signature-value';

describe('Ardent HiveMem enrollment settings', () => {
  it('is off without settings, refuses a partial or insecure setup, and normalizes URLs', () => {
    expect(ardentHiveMemSettings({})).toBeNull();
    expect(() => ardentHiveMemSettings({ MAGNUS_ARDENT_HIVEMEM_URL: env.MAGNUS_ARDENT_HIVEMEM_URL })).toThrow(/together/);
    expect(() => ardentHiveMemSettings({ ...env, MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID: undefined })).toThrow(/existing workspace/);
    expect(() => ardentHiveMemSettings({ ...env, MAGNUS_ARDENT_HIVEMEM_URL: 'http://memory.example.com' })).toThrow(/HTTPS/);
    expect(() => ardentHiveMemSettings({ ...env, MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS: '721' })).toThrow(/720/);
    expect(ardentHiveMemSettings({ ...env, MAGNUS_ARDENT_HIVEMEM_AGENT_URL: 'http://192.0.2.5:8080' })).toEqual({
      apiUrl: 'https://memory.example.com/api/hivemem/', agentUrl: 'http://192.0.2.5:8080/', auth: { kind: 'token', token: 'fixture-enrollment-token' },
      workspaceId: 'agents', hours: 720 });
  });

  it('derives a stable agent ID within HiveMem limits', () => {
    const id = ardentHiveMemAgentId('node-1', 'Research_Lead-With-A-Very-Long-Name');
    expect(id).toMatch(/^[a-z0-9_-]{2,32}$/);
    expect(id).toBe(ardentHiveMemAgentId('node-1', 'Research_Lead-With-A-Very-Long-Name'));
    expect(id).not.toBe(ardentHiveMemAgentId('node-2', 'Research_Lead-With-A-Very-Long-Name'));
  });
});

describe('HiveMem actor credential request', () => {
  const settings = ardentHiveMemSettings(env)!;
  const plan = planArdentHiveMemCredential(settings, { operationId: 'op', nodeId: 'node-1', nodeName: 'node-1', profile: 'lead', action: 'enroll', now: Date.UTC(2026, 10, 8) });

  it('sends one explicit, replayable policy and returns the token', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, agent_id: plan.agentId, operation_id: 'x', token: TOKEN, expires_at: plan.expiresAt }));
    const first = await requestArdentHiveMemCredential(settings, plan, fetcher as unknown as typeof fetch);
    const second = await requestArdentHiveMemCredential(settings, plan, fetcher as unknown as typeof fetch);
    expect(first.token).toBe(TOKEN);
    expect(second.operationId).toBe(first.operationId);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`https://memory.example.com/api/hivemem/v1/actor-credentials/${first.operationId}`);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer fixture-enrollment-token');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'enroll', agent_id: plan.agentId, display_name: 'Ardent lead on node-1',
      description: 'Ardent profile managed by Magnus', scopes: ['memories:read', 'memories:write', 'sessions:read', 'sessions:write'],
      workspace_id: 'agents', expires_at: '2026-12-07T23:59:00.000Z' });
  });

  it('sends a renewal with its grace period, and detects whether HiveMem can renew', async () => {
    const renewal = planArdentHiveMemCredential(settings, { operationId: 'op', nodeId: 'node-1', nodeName: 'node-1', profile: 'lead', action: 'renew',
      now: Date.UTC(2026, 10, 8), graceSeconds: 86_400 });
    expect(renewal).toMatchObject({ key: 'op:renew', action: 'renew', graceSeconds: 86_400 });
    const fetcher = vi.fn(async () => Response.json({ ok: true, agent_id: renewal.agentId, operation_id: 'x', token: TOKEN, expires_at: renewal.expiresAt }));
    await requestArdentHiveMemCredential(settings, renewal, fetcher as unknown as typeof fetch);
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ action: 'renew', grace_seconds: 86_400, expires_at: '2026-12-07T23:59:00.000Z' });
    // Other actions carry no grace period, which HiveMem would refuse.
    expect(JSON.parse(String((await (async () => { fetcher.mockClear(); await requestArdentHiveMemCredential(settings, plan, fetcher as unknown as typeof fetch);
      return fetcher.mock.calls[0] as unknown as [URL, RequestInit]; })())[1].body))).not.toHaveProperty('grace_seconds');

    const capabilities = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;
    const current = capabilities({ actor_credentials: 'idempotent-receipt-v1', actor_credential_renewal: 'renew-grace-v1' });
    expect(await ardentHiveMemSupportsRenewal(settings, current)).toBe(true);
    const [url, request] = (current as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://memory.example.com/api/hivemem/v1/capabilities');
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();
    expect(await ardentHiveMemSupportsRenewal(settings, capabilities({ actor_credentials: 'idempotent-receipt-v1' }))).toBe(false);
    await expect(ardentHiveMemSupportsRenewal(settings, capabilities({}, 503))).rejects.toMatchObject({ status: 503 });
  });

  it('reports HiveMem refusals by status without echoing a token', async () => {
    const refused = vi.fn(async () => new Response(`conflict ${TOKEN}`, { status: 409 }));
    const error = await requestArdentHiveMemCredential(settings, plan, refused as unknown as typeof fetch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HiveMemEnrollmentError);
    expect((error as HiveMemEnrollmentError).status).toBe(409);
    expect((error as Error).message).not.toContain(TOKEN);
    const wrongAgent = vi.fn(async () => Response.json({ ok: true, agent_id: 'someone-else', token: TOKEN }));
    await expect(requestArdentHiveMemCredential(settings, plan, wrongAgent as unknown as typeof fetch)).rejects.toThrow(/no usable/);
  });
});

const SERVICE_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlLWNsaWVudCJ9.fixture-service-signature';
const serviceEnv = { MAGNUS_ARDENT_HIVEMEM_URL: 'https://memory.example.com/', MAGNUS_ARDENT_HIVEMEM_CLIENT_ID: 'magnus-hivemem',
  MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET: 'fixture-client-secret-that-is-long-enough', MAGNUS_ARDENT_HIVEMEM_TOKEN_URL: 'https://identity.example.com/api/v1/oauth/token' };

/** A fake Oathweave token endpoint and HiveMem, recording each call. */
function services(options: { tokenStatus?: number; workspaceStatus?: number; credentialStatuses?: number[] } = {}) {
  const calls: Array<{ url: string; authorization: string | null; body: string }> = [];
  const credentialStatuses = [...(options.credentialStatuses ?? [])];
  let tokens = 0;
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization'), body: String(init?.body ?? '') });
    if (url.startsWith('https://identity.example.com/')) {
      if (options.tokenStatus) return new Response('{"error":"invalid_client"}', { status: options.tokenStatus });
      tokens++;
      return Response.json({ access_token: `${SERVICE_TOKEN}${tokens}`, token_type: 'Bearer', expires_in: 300 });
    }
    if (url.endsWith('/v1/workspaces')) {
      if (options.workspaceStatus) return Response.json({ detail: 'Workspace read permission required' }, { status: options.workspaceStatus });
      return Response.json({ workspace_id: JSON.parse(String(init?.body)).workspace_id, owner_agent_id: 'magnus' }, { status: 201 });
    }
    const status = credentialStatuses.shift() ?? 200;
    if (status !== 200) return Response.json({ detail: 'JWT has been revoked' }, { status });
    const body = JSON.parse(String(init?.body)) as { agent_id: string };
    return Response.json({ ok: true, agent_id: body.agent_id, operation_id: 'x', token: TOKEN, expires_at: '2026-12-01T00:00:00.000Z' });
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch, tokens: () => tokens };
}

describe('HiveMem enrollment as Magnus\'s Oathweave service identity', () => {
  afterEach(() => resetArdentHiveMemTokens());

  it('reads the client settings, requests the enrollment scopes and enrolls into the agents workspace by default', () => {
    expect(ardentHiveMemSettings(serviceEnv)).toEqual({ apiUrl: 'https://memory.example.com/', agentUrl: 'https://memory.example.com/', workspaceId: 'ardent-agents', hours: 720,
      auth: { kind: 'oathweave', tokenUrl: 'https://identity.example.com/api/v1/oauth/token', clientId: 'magnus-hivemem',
        clientSecret: 'fixture-client-secret-that-is-long-enough', scope: ARDENT_HIVEMEM_SERVICE_SCOPE } });
    expect(ARDENT_HIVEMEM_SERVICE_SCOPE).toBe('hivemem:admin:agents hivemem:workspaces:write hivemem:memories:read hivemem:memories:write hivemem:sessions:read hivemem:sessions:write');
    expect(ardentHiveMemSettings({ ...serviceEnv, MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID: 'fleet-agents' })!.workspaceId).toBe('fleet-agents');
    expect(ardentHiveMemSettings({ ...serviceEnv, MAGNUS_ARDENT_HIVEMEM_SCOPE: 'hivemem:admin:all' })!.auth).toMatchObject({ scope: 'hivemem:admin:all' });
  });

  it('refuses an incomplete, ambiguous or insufficient client', () => {
    expect(() => ardentHiveMemSettings({ ...serviceEnv, MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET: undefined })).toThrow(/set together/);
    expect(() => ardentHiveMemSettings({ ...serviceEnv, MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN: 'fixture-enrollment-token' })).toThrow(/not both/);
    expect(() => ardentHiveMemSettings({ ...serviceEnv, MAGNUS_ARDENT_HIVEMEM_TOKEN_URL: 'http://identity.example.com/token' })).toThrow(/HTTPS/);
    expect(() => ardentHiveMemSettings({ ...serviceEnv, MAGNUS_ARDENT_HIVEMEM_CLIENT_ID: 'bad id' })).toThrow(/CLIENT_ID/);
    expect(() => ardentHiveMemSettings({ ...serviceEnv, MAGNUS_ARDENT_HIVEMEM_SCOPE: 'hivemem:memories:read hivemem:memories:write' })).toThrow(/lacks hivemem:admin:agents/);
    expect(() => ardentHiveMemSettings({ ...serviceEnv, MAGNUS_ARDENT_HIVEMEM_SCOPE: 'magnus:ardent' })).toThrow(/hivemem: permissions/);
  });

  it('fetches one short-lived token, ensures the workspace, then enrolls with that token', async () => {
    const settings = ardentHiveMemSettings(serviceEnv)!;
    const plan = planArdentHiveMemCredential(settings, { operationId: 'op', nodeId: 'node-1', nodeName: 'node-1', profile: 'lead', action: 'enroll', now: Date.UTC(2026, 10, 8) });
    const { calls, fetcher, tokens } = services();
    const issued = await requestArdentHiveMemCredential(settings, plan, fetcher);
    await requestArdentHiveMemCredential(settings, plan, fetcher);
    expect(issued.token).toBe(TOKEN);
    expect(tokens()).toBe(1);
    expect(calls.map(call => call.url)).toEqual(['https://identity.example.com/api/v1/oauth/token', 'https://memory.example.com/v1/workspaces',
      `https://memory.example.com/v1/actor-credentials/${issued.operationId}`, 'https://memory.example.com/v1/workspaces', `https://memory.example.com/v1/actor-credentials/${issued.operationId}`]);
    const form = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: 'magnus-hivemem', client_secret: 'fixture-client-secret-that-is-long-enough',
      scope: ARDENT_HIVEMEM_SERVICE_SCOPE });
    expect(calls.slice(1).every(call => call.authorization === `Bearer ${SERVICE_TOKEN}1`)).toBe(true);
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ workspace_id: 'ardent-agents' });
    expect(JSON.parse(calls[2]!.body)).toMatchObject({ workspace_id: 'ardent-agents', agent_id: plan.agentId, scopes: ['memories:read', 'memories:write', 'sessions:read', 'sessions:write'] });
  });

  it('replaces a service token HiveMem rejects, once', async () => {
    const settings = ardentHiveMemSettings(serviceEnv)!;
    const plan = planArdentHiveMemCredential(settings, { operationId: 'op', nodeId: 'node-1', nodeName: 'node-1', profile: 'lead', action: 'enroll' });
    const retried = services({ credentialStatuses: [401] });
    expect((await requestArdentHiveMemCredential(settings, plan, retried.fetcher)).token).toBe(TOKEN);
    expect(retried.tokens()).toBe(2);
    expect(retried.calls.at(-1)!.authorization).toBe(`Bearer ${SERVICE_TOKEN}2`);
    resetArdentHiveMemTokens();
    const refused = services({ credentialStatuses: [401, 401] });
    const error = await requestArdentHiveMemCredential(settings, plan, refused.fetcher).catch((caught: unknown) => caught) as HiveMemEnrollmentError;
    expect(error).toMatchObject({ status: 401, code: 'HIVEMEM_ENROLLMENT_FAILED' });
    expect(error.message).toMatch(/^HIVEMEM_ENROLLMENT_FAILED: HiveMem enroll answered HTTP 401/);
  });

  it('names the failing dependency with a clear code and never echoes the client secret', async () => {
    const settings = ardentHiveMemSettings(serviceEnv)!;
    const plan = planArdentHiveMemCredential(settings, { operationId: 'op', nodeId: 'node-1', nodeName: 'node-1', profile: 'lead', action: 'enroll' });
    const identity = await requestArdentHiveMemCredential(settings, plan, services({ tokenStatus: 401 }).fetcher).catch((caught: unknown) => caught) as HiveMemEnrollmentError;
    expect(identity).toMatchObject({ code: 'HIVEMEM_IDENTITY_UNAVAILABLE', status: 503 });
    expect(identity.message).toMatch(/HTTP 401/);
    expect(identity.message).not.toContain('fixture-client-secret');
    resetArdentHiveMemTokens();
    const workspace = await requestArdentHiveMemCredential(settings, plan, services({ workspaceStatus: 403 }).fetcher).catch((caught: unknown) => caught) as HiveMemEnrollmentError;
    expect(workspace).toMatchObject({ code: 'HIVEMEM_WORKSPACE_UNAVAILABLE', status: 403 });
    expect(workspace.message).toMatch(/ardent-agents.*HTTP 403.*workspaces:write/);
  });

  it('checks before an operation starts, answering 503 with the code', async () => {
    const settings = ardentHiveMemSettings(serviceEnv)!;
    const ready = services();
    await prepareArdentHiveMem(settings, ready.fetcher);
    expect(ready.calls.map(call => call.url.split('/').at(-1))).toEqual(['token', 'workspaces']);
    resetArdentHiveMemTokens();
    await expect(prepareArdentHiveMem(settings, services({ tokenStatus: 400 }).fetcher)).rejects.toMatchObject({ status: 503, code: 'HIVEMEM_IDENTITY_UNAVAILABLE' });
    await expect(prepareArdentHiveMem(settings, services({ workspaceStatus: 409 }).fetcher)).rejects.toMatchObject({ status: 503, code: 'HIVEMEM_WORKSPACE_UNAVAILABLE' });
    // A static token names an existing workspace, so there is nothing to check.
    const unused = services();
    await prepareArdentHiveMem(ardentHiveMemSettings(env)!, unused.fetcher);
    expect(unused.calls).toEqual([]);
  });
});
