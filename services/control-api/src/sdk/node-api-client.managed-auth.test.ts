/**
 * How the server authenticates managed HTTP for each agent version. 2.10.0 and 2.10.1 agents with a
 * node key refuse every signed request on that route as a replay; the server sends them the shared
 * secret alone, after a request that runs nothing has shown they accept it, and never in enforce mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// These cases exercise shared-secret paths, which 3.0.0 keeps only under an explicit NODE_AUTH_MODE=compat (or warn).
beforeEach(() => { process.env['NODE_AUTH_MODE'] = 'compat'; });
afterEach(() => { delete process.env['NODE_AUTH_MODE']; });
import { nativeCompletionDescriptor, nativeCompletionResourceKey } from '../security/native-completion-registry.js';

const mocks = vi.hoisted(() => ({ admit: vi.fn(), mark: vi.fn(), fail: vi.fn(async () => true), legacy: vi.fn() }));
vi.mock('../services/command-resource-leases.js', async original => ({ ...await original<object>(),
  admitResourceCommand: mocks.admit, markResourceDispatched: mocks.mark, failResourceCommand: mocks.fail }));
vi.mock('../services/node-legacy-use.js', async original => ({ ...await original<object>(), recordLegacyUse: mocks.legacy }));
const { NodeApiClient, NotDispatchedError, AGENT_MANAGED_HTTP_NEEDS_UPGRADE } = await import('./node-api-client.js');
const { agentRefusesSignedManagedHttp } = await import('../services/node-agent-auth.js');

const resourceKey = nativeCompletionResourceKey(nativeCompletionDescriptor('POST', '/agent-upgrade')!, 'fixture');
const client = () => new NodeApiClient({ baseUrl: 'http://node.invalid', nodeToken: 'test-node-auth', resourceNodeId: 'fixture' });
const upgrade = () => client().upgradeAgent({ version: '2.10.2', integrity: 'sha512-AA==', requestId: 'r1', packageName: '@hivemagnus/magnus-agent' });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Seen = { method: string; path: string; headers: Record<string, string> };
/** An agent that reports `version`, answers the unsigned probe with `probeStatus`, and refuses the managed POST. */
function agent(version: string, nodeAuth: number, probeStatus = 404): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    seen.push({ method: request.method, path, headers: Object.fromEntries(request.headers) });
    if (path.endsWith('/ping')) return json(200, { success: true, data: { ok: true, version, features: { managedMutations: 1, nodeAuth } } });
    if (request.method === 'GET') return json(probeStatus, { success: false, error: { code: probeStatus === 401 ? 'NODE_SIGNATURE_REQUIRED' : 'NOT_FOUND' } });
    return json(409, { success: false, error: { code: 'RESOURCE_BUSY', message: 'busy' } });
  }));
  return seen;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
mocks.admit.mockImplementation(async (_context: unknown, identity: { commandId: string }) => ({ leaseId: 'lease', commandId: identity.commandId, nodeId: 'fixture',
  nodeFqdn: 'node-1.example.com', payload: { ...identity, coordination: { version: 1, resourceKey, fence: '3', expiresAt: Date.now() + 60_000 } } }));

describe('the versions that refuse signed managed HTTP', () => {
  it('are 2.10.0 and 2.10.1 with a node key, and nothing else', () => {
    for (const version of ['2.10.0', '2.10.1', '2.10.1-rc.1']) expect(agentRefusesSignedManagedHttp(version, 1), version).toBe(true);
    for (const version of ['2.9.1', '2.10.2', '2.11.0', '12.10.0', '2.10.10', undefined]) expect(agentRefusesSignedManagedHttp(version, 1), String(version)).toBe(false);
    expect(agentRefusesSignedManagedHttp('2.10.0', 0)).toBe(false);
    expect(agentRefusesSignedManagedHttp('2.10.1', undefined)).toBe(false);
  });
});

describe('managed HTTP authentication by agent version', () => {
  it.each([['2.10.0'], ['2.10.1']])('%s with a key: probes with a GET that runs nothing, then sends the POST with the shared secret only', async version => {
    const seen = agent(version, 1);
    await expect(upgrade()).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
    expect(seen.map(request => `${request.method} ${request.path}`)).toEqual(['GET /api/v1/ping', 'GET /api/v1/commands/managed-http', 'POST /api/v1/commands/managed-http']);
    for (const request of seen.slice(1)) {
      expect(request.headers['x-node-token']).toBe('test-node-auth');
      expect(request.headers['x-magnus-signature']).toBeUndefined();
    }
    expect(mocks.mark).toHaveBeenCalledTimes(1);
    expect(mocks.legacy).toHaveBeenCalledWith('fixture', 'outbound', expect.stringContaining('POST /api/v1/commands/managed-http'));
  });

  it.each([['2.10.2', 1], ['2.9.1', 0], ['2.10.1', 0]])('%s (node key %s): no probe, and the managed POST takes the usual signed path', async (version, nodeAuth) => {
    const seen = agent(version, nodeAuth);
    await expect(upgrade()).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
    expect(seen.map(request => `${request.method} ${request.path}`)).toEqual(['GET /api/v1/ping', 'POST /api/v1/commands/managed-http']);
    expect(mocks.legacy).not.toHaveBeenCalledWith('fixture', 'outbound', expect.stringContaining('refuses signed managed HTTP'));
  });

  it('never sends its internal marker header to an agent', async () => {
    const seen = agent('2.10.0', 1);
    await upgrade().catch(() => undefined);
    expect(seen.every(request => !Object.keys(request.headers).includes('x-magnus-internal-unsigned'))).toBe(true);
  });

  it('an agent that enforces its key (the probe is refused): nothing is dispatched and the lease is released', async () => {
    const seen = agent('2.10.1', 1, 401);
    const error = await upgrade().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotDispatchedError);
    expect(error).toMatchObject({ code: AGENT_MANAGED_HTTP_NEEDS_UPGRADE, dispatched: false });
    expect(seen.some(request => request.method === 'POST')).toBe(false);
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledTimes(1);
  });

  it('a probe answered with anything else proves nothing: not dispatched', async () => {
    const seen = agent('2.10.0', 1, 500);
    await expect(upgrade()).rejects.toBeInstanceOf(NotDispatchedError);
    expect(seen.some(request => request.method === 'POST')).toBe(false);
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it('server enforce mode: no unsigned request at all, not even the probe', async () => {
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    const seen = agent('2.10.0', 1);
    await expect(upgrade()).rejects.toMatchObject({ code: AGENT_MANAGED_HTTP_NEEDS_UPGRADE, dispatched: false });
    expect(seen.filter(request => request.headers['x-node-token'] !== undefined)).toEqual([]);
    expect(seen.some(request => request.path.endsWith('/commands/managed-http'))).toBe(false);
    expect(mocks.mark).not.toHaveBeenCalled();
  });
});
