import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeApiClient, isAgentNotPrivileged } from './node-api-client.js';

const client = () => new NodeApiClient({ baseUrl: 'http://node.invalid', nodeToken: 'test-node-auth' });
const respond = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));

afterEach(() => vi.unstubAllGlobals());

describe('unprivileged agent responses', () => {
  it('maps 403 AGENT_NOT_PRIVILEGED to a non-retryable feature-disabled error', async () => {
    respond(403, { success: false, error: { code: 'AGENT_NOT_PRIVILEGED', feature: 'cron', message: 'cron is disabled' } });
    const error = await client().listCronJobs().catch((caught: unknown) => caught);
    expect(isAgentNotPrivileged(error)).toBe(true);
    expect(error).toMatchObject({ status: 409, code: 'AGENT_NOT_PRIVILEGED' });
    expect((error as Error).message).toContain('cron is disabled on this node');
  });

  it('leaves other 403 responses untouched', async () => {
    respond(403, { success: false, error: { code: 'FORBIDDEN' } });
    const error = await client().listCronJobs().catch((caught: unknown) => caught);
    expect(isAgentNotPrivileged(error)).toBe(false);
    expect((error as { response?: Response }).response?.status).toBe(403);
  });
});
