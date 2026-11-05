import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { assertLiveExecution, rehearsalEnabled, rehearsalReadOnly, startLiveBackgroundServices } from './rehearsal.js';
import { startCommandWorker, getCommandQueue } from '../queue/workers.js';
import { startWebhookWorker, getWebhookQueue } from '../services/webhook-service.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
afterEach(() => vi.unstubAllEnvs());
describe('isolated restore execution fence', () => {
  it('fails invalid safety flags and never starts background consumers in rehearsal', () => {
    expect(() => rehearsalEnabled({ HIVE_REHEARSAL: 'yes' })).toThrow();
    const start = vi.fn();
    expect(startLiveBackgroundServices(start, { HIVE_REHEARSAL: 'true' })).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(() => assertLiveExecution({ HIVE_REHEARSAL: 'true' })).toThrow(/Isolated rehearsal/);
    expect(startLiveBackgroundServices(start, { HIVE_REHEARSAL: 'false' })).toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });
  it('holds every mutation before handler execution while retaining read access', async () => {
    vi.stubEnv('HIVE_REHEARSAL', 'true');
    const app = new Hono().use('*', rehearsalReadOnly), mutate = vi.fn();
    app.all('/fixture', c => { mutate(); return c.json({ ok: true }); });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await app.request('/fixture', { method });
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('REHEARSAL_READ_ONLY');
    }
    expect(mutate).not.toHaveBeenCalled();
    expect((await app.request('/fixture')).status).toBe(200);
  });
  it('refuses queue creation, workers and host contact even if callers bypass startup', async () => {
    vi.stubEnv('HIVE_REHEARSAL', 'true');
    for (const action of [getCommandQueue, startCommandWorker, getWebhookQueue, startWebhookWorker]) expect(action).toThrow(/Isolated rehearsal/);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      const client = new NodeApiClient({ baseUrl: 'https://agent.example.com', nodeToken: 'obviously-fake-fixture-token' });
      await expect(client.collectHealth()).rejects.toThrow(/Isolated rehearsal/);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
