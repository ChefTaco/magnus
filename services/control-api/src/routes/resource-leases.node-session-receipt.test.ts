import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error-handler.js';

const fixture = vi.hoisted(() => ({ settle: vi.fn() }));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(), NODE_MANAGER_SECRET: 'node-secret' }));
vi.mock('../services/credential-rotation-service.js', async original => ({ ...await original<object>(),
  verifyWithRotation: vi.fn((_purpose: string, _active: string, token: string) => token === 'node-secret'),
}));
vi.mock('../services/resource-participant-work.js', async original => ({ ...await original<object>(),
  settleParticipantWorkFromNodeReceipt: fixture.settle,
}));

const { resourceLeasesRouter } = await import('./resource-leases.js');
const app = new Hono().onError(errorHandler).route('/resource-leases', resourceLeasesRouter);
const workId = randomUUID();
const body = { version: 1, workId, nodeId: 'node-one', nodeFqdn: 'node-one.lab', participant: 'api', ownerId: randomUUID(),
  kind: 'ssh-command', operationSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64), fence: '3',
  deadline: Date.now() + 60_000, bootId: randomUUID(), unit: `magnus-exec-${'c'.repeat(64)}.service`,
  invocationId: 'd'.repeat(32), cgroup: `/system.slice/magnus-exec-${'c'.repeat(64)}.service`, startedAt: Date.now(),
  terminalAt: Date.now() + 1, disposition: 'succeeded', resultSha256: 'e'.repeat(64), groupEmpty: true,
  completionRegistrySha256: '1'.repeat(64), completionDescriptorId: 'diagnostics-uptime-v1',
  effectBoundary: 'bounded-node-process', signature: 'f'.repeat(64) };

describe('node session receipt route', () => {
  it('requires node authentication, strict shape, and the exact path identity', async () => {
    const send = (token: string | undefined, value: unknown, id = workId) => app.request(`/resource-leases/enrollment/work/${id}/node-receipt`, {
      method: 'POST', headers: { ...(token ? { 'x-node-token': token } : {}), 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    expect((await send(undefined, body)).status).toBe(401);
    expect((await send('wrong', body)).status).toBe(401);
    expect((await send('node-secret', { ...body, arbitrary: true })).status).toBe(400);
    expect((await send('node-secret', body, randomUUID())).status).toBe(400);
    expect(fixture.settle).not.toHaveBeenCalled();
  });

  it('passes the exact signed envelope to the non-dispatching settlement service', async () => {
    fixture.settle.mockResolvedValueOnce({ workId, state: 'released' });
    const response = await app.request(`/resource-leases/enrollment/work/${workId}/node-receipt`, { method: 'POST',
      headers: { 'x-node-token': 'node-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(fixture.settle).toHaveBeenCalledWith(body);
  });
});
