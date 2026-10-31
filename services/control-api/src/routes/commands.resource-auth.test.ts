import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';

const { getDb } = vi.hoisted(() => ({ getDb: vi.fn(() => { throw Error('Database must not be reached'); }) }));
vi.mock('../db/index.js', () => ({ getDb }));
vi.mock('../queue/workers.js', () => ({ enqueueCommand: vi.fn() }));
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'resource-route-jwt-fixture-at-least-32-characters',
  API_SECRET: 'resource-route-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '' }));
const { commandsRouter } = await import('./commands.js');
const { signUserToken } = await import('../middleware/auth.js');
const app = new Hono().onError(errorHandler).route('/commands', commandsRouter);

describe('resource reconciliation authorization', () => {
  it('requires authentication even for ownership inspection', async () => {
    expect((await app.request('/commands/example/resource-lease')).status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
  });
  it('rejects viewer reconciliation before accessing ownership or node state', async () => {
    const token = await signUserToken({ userId: 'fixture-viewer', username: 'fixture', role: 'VIEWER' });
    const response = await app.request('/commands/example/reconcile-resource', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(403); expect(getDb).not.toHaveBeenCalled();
  });
  it.each([{ release: true }, { assertion: { disposition: 'no_effect_verified' } }])('rejects unsigned unlock forms for administrators: %j', async body => {
    const token = await signUserToken({ userId: 'fixture-admin', username: 'fixture', role: 'ADMIN' });
    const response = await app.request('/commands/example/reconcile-resource', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(400); expect(getDb).not.toHaveBeenCalled();
  });
});
