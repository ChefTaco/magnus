import { afterEach, describe, expect, it, vi } from 'vitest';
const admit = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => null));
vi.mock('../services/command-resource-leases.js', async original => ({ ...await original<object>(), admitResourceCommand: admit }));
const { AgentResponseError, DispatchOutcomeUnknownError, NodeApiClient, NotDispatchedError, agentErrorBody } = await import('./node-api-client.js');
const { HttpError } = await import('../middleware/error-handler.js');

const client = () => new NodeApiClient({ baseUrl: 'http://node.invalid', nodeToken: 'test-node-auth', resourceNodeId: 'n1' });
const request = { version: '1.1.1', integrity: 'sha512-AA==', requestId: 'r1', packageName: '@hivemagnus/magnus-agent' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
/** First call is the ping, second the upgrade POST. */
const fetchSequence = (...steps: Array<() => Response>) => {
  let call = 0;
  vi.stubGlobal('fetch', vi.fn(async () => steps[Math.min(call++, steps.length - 1)]!()));
};

afterEach(() => { vi.unstubAllGlobals(); admit.mockReset(); admit.mockImplementation(async () => null); });

describe('agent upgrade dispatch errors', () => {
  it('reports an admission refusal as not dispatched, with its code', async () => {
    admit.mockImplementation(async () => { throw new HttpError(409, 'RESOURCE_ENROLLMENT_REQUIRED', 'Verified participant drain enrollment is required'); });
    const error = await client().upgradeAgent(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotDispatchedError);
    expect(error).toMatchObject({ code: 'RESOURCE_ENROLLMENT_REQUIRED', dispatched: false });
  });

  it('pings first on the legacy path; an unreachable agent was never asked', async () => {
    fetchSequence(() => { throw refused(); });
    const error = await client().upgradeAgent(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotDispatchedError);
  });

  it('keeps the agent error code and message', async () => {
    fetchSequence(() => json(200, { success: true, data: { ok: true } }),
      () => json(409, { success: false, error: { code: 'UNMANAGED_MUTATION', message: 'Enrolled node requires the reviewed managed mutation boundary' } }));
    const error = await client().upgradeAgent(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentResponseError);
    expect(error).toMatchObject({ agentStatus: 409, code: 'UNMANAGED_MUTATION', agentMessage: 'Enrolled node requires the reviewed managed mutation boundary' });
    expect((error as Error).message).toContain('UNMANAGED_MUTATION');
  });

  it('treats a lost reply as unknown, and a refused connection as not dispatched', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { if (call++ === 0) return json(200, { success: true }); throw new Error('socket hang up'); }));
    expect(await client().upgradeAgent(request).catch((caught: unknown) => caught)).toBeInstanceOf(DispatchOutcomeUnknownError);
    call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { if (call++ === 0) return json(200, { success: true }); throw refused(); }));
    expect(await client().upgradeAgent(request).catch((caught: unknown) => caught)).toBeInstanceOf(NotDispatchedError);
  });

  it('reads agent error bodies from objects and JSON text', () => {
    expect(agentErrorBody('{"success":false,"error":{"code":"RESOURCE_BUSY","message":"busy"}}')).toEqual({ code: 'RESOURCE_BUSY', message: 'busy' });
    expect(agentErrorBody({ error: { code: 'X' } })).toEqual({ code: 'X', message: 'X' });
    expect(agentErrorBody('not json')).toBeNull();
  });
});
