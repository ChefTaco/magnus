import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
beforeEach(() => { process.env['NODE_AUTH_MODE'] = 'compat'; });
afterEach(() => { delete process.env['NODE_AUTH_MODE']; vi.unstubAllGlobals(); });
import { NodeApiClient } from './node-api-client.js';

const client = () => new NodeApiClient({ baseUrl: 'http://node.invalid', nodeToken: 'test-node-auth', resourceNodeId: 'fixture' });

function agent(features: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const text = request.method === 'GET' ? '' : await request.text();
    calls.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
    const body = path.endsWith('/ping')
      ? { success: true, data: { version: '9.9.9', features } }
      : { success: true, data: { written: true, checksum: 'abc', backupPath: null } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

describe('restricted file writes', () => {
  it('refuses an agent that does not advertise restricted writes, sending nothing that changes the node', async () => {
    const calls = agent({ managedMutations: 1 });
    await expect(client().writeFile({ filePath: '/srv/app/config.yml', content: 'x', backup: true }))
      .rejects.toMatchObject({ status: 409, code: 'AGENT_FILE_WRITE_UNSUPPORTED' });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/v1/ping']);
  });

  it('sends the backup request to an agent that checks the path before backing up', async () => {
    agent({ managedMutations: 1, restrictedFileWrite: 1 });
    // The managed mutation path itself (admission, signing) is covered elsewhere.
    const mutate = vi.spyOn(NodeApiClient.prototype as unknown as { mutate: () => Promise<unknown> }, 'mutate')
      .mockResolvedValue({ success: true, data: { written: true, checksum: 'abc', backupPath: null } });
    await client().writeFile({ filePath: '/srv/app/config.yml', content: 'x', backup: true });
    expect(mutate).toHaveBeenCalledWith('POST', 'files/write', { filePath: '/srv/app/config.yml', content: 'x', backup: true });
    mutate.mockRestore();
  });
});
