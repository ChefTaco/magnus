import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error-handler.js';

const fixture = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(), NODE_MANAGER_SECRET: 'node-secret' }));
vi.mock('../services/credential-rotation-service.js', async original => ({ ...await original<object>(),
  verifyWithRotation: vi.fn((_purpose: string, _active: string, token: string) => token === 'node-secret'),
}));
vi.mock('../services/transfer-authority-snapshot.js', () => ({ transferAuthoritySnapshot: fixture.snapshot }));
const { resourceLeasesRouter } = await import('./resource-leases.js');
const app = new Hono().onError(errorHandler).route('/resource-leases', resourceLeasesRouter);

describe('release authority snapshot route', () => {
  const body = { nodeFqdn: 'magnus.example.com', nonce: randomUUID() };
  const send = (token: string | undefined, value: unknown) => app.request('/resource-leases/transfer/authority-snapshot', {
    method: 'POST', headers: { ...(token ? { 'x-node-token': token } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  it('requires the node credential and an exact fresh request shape', async () => {
    expect((await send(undefined, body)).status).toBe(401);
    expect((await send('wrong', body)).status).toBe(401);
    expect((await send('node-secret', { ...body, extra: true })).status).toBe(400);
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });
  it('returns a non-cacheable inventory with explicit incomplete authority', async () => {
    fixture.snapshot.mockResolvedValueOnce({ nodeFqdn: body.nodeFqdn, nonce: body.nonce, transferAuthorityComplete: false });
    const result = await send('node-secret', body);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect((await result.json()).data.transferAuthorityComplete).toBe(false);
    expect(fixture.snapshot).toHaveBeenCalledWith(body.nodeFqdn, body.nonce);
  });
});
