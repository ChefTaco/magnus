import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../queue/redis.js', () => ({
  getRedis: () => ({
    set: async (key: string, value: string) => (store.has(key) ? null : (store.set(key, value), 'OK')),
    eval: async (_script: string, _keys: number, key: string, token: string) =>
      (store.get(key) === token ? Number(store.delete(key)) : 0),
  }),
}));

const { claimIdempotency, enforceIdempotencyFromHeader } = await import('./idempotency.js');
const { errorHandler } = await import('../middleware/error-handler.js');

describe('idempotency claims', () => {
  it('scopes keys by operation and actor and rejects a repeat in the same scope', async () => {
    await claimIdempotency('commands.dispatch', 'user-a', 'k1');
    await claimIdempotency('commands.dispatch', 'user-b', 'k1');
    await claimIdempotency('cron.create', 'user-a', 'k1');
    await expect(claimIdempotency('commands.dispatch', 'user-a', 'k1')).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
  });

  it('allows a retry after the claim is released for a request that created nothing', async () => {
    const claim = await claimIdempotency('commands.dispatch', 'user-a', 'k2');
    await claim.release();
    await expect(claimIdempotency('commands.dispatch', 'user-a', 'k2')).resolves.toBeDefined();
  });

  it('derives the header scope from the matched route', async () => {
    const app = new Hono().onError(errorHandler);
    app.post('/a/:id', async (c) => { await enforceIdempotencyFromHeader(c); return c.text('ok'); });
    app.post('/b/:id', async (c) => { await enforceIdempotencyFromHeader(c); return c.text('ok'); });
    const send = (path: string) => app.request(path, { method: 'POST', headers: { 'x-idempotency-key': 'k3' } });
    expect((await send('/a/1')).status).toBe(200);
    expect((await send('/b/1')).status).toBe(200);
    expect((await send('/a/2')).status).toBe(409);
  });
});
