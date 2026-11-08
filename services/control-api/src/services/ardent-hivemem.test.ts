import { describe, expect, it, vi } from 'vitest';
import { ardentHiveMemAgentId, ardentHiveMemSettings, HiveMemEnrollmentError, planArdentHiveMemCredential, requestArdentHiveMemCredential } from './ardent-hivemem.js';

const env = { MAGNUS_ARDENT_HIVEMEM_URL: 'https://memory.example.com/api/hivemem', MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN: 'fixture-enrollment-token',
  MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID: 'agents' };
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.fixture-signature-value';

describe('Ardent HiveMem enrollment settings', () => {
  it('is off without settings, refuses a partial or insecure setup, and normalizes URLs', () => {
    expect(ardentHiveMemSettings({})).toBeNull();
    expect(() => ardentHiveMemSettings({ MAGNUS_ARDENT_HIVEMEM_URL: env.MAGNUS_ARDENT_HIVEMEM_URL })).toThrow(/together/);
    expect(() => ardentHiveMemSettings({ ...env, MAGNUS_ARDENT_HIVEMEM_URL: 'http://memory.example.com' })).toThrow(/HTTPS/);
    expect(() => ardentHiveMemSettings({ ...env, MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS: '721' })).toThrow(/720/);
    expect(ardentHiveMemSettings({ ...env, MAGNUS_ARDENT_HIVEMEM_AGENT_URL: 'http://192.0.2.5:8080' })).toEqual({
      apiUrl: 'https://memory.example.com/api/hivemem/', agentUrl: 'http://192.0.2.5:8080/', token: 'fixture-enrollment-token', workspaceId: 'agents', hours: 720 });
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
