import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';

const control = vi.hoisted(() => vi.fn());
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'rollout-route-jwt-fixture-at-least-32-characters',
  API_SECRET: 'rollout-route-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '' }));
vi.mock('../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../services/audit-service.js', async original => ({ ...await original<object>(), logAuditEvent: vi.fn() }));
vi.mock('../services/rollout-service.js', () => ({ createRollout: vi.fn(), executeRollout: vi.fn(),
  getRolloutStatus: vi.fn(), setRolloutControl: control, rolloutInputSchema: {} }));

const { rolloutRouter } = await import('./rollout.js');
const { signUserToken } = await import('../middleware/auth.js');
const app = new Hono().onError(errorHandler).route('/rollouts', rolloutRouter);

async function post(path: string, role: 'ADMIN' | 'OPERATOR') {
  const token = await signUserToken({ userId: `fixture-${role.toLowerCase()}`, email: '', role });
  return app.request(`/rollouts/run-1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
}

describe('rollout abort authority', () => {
  it('requires ADMIN for abort, like cancel, while operators may still pause', async () => {
    expect((await post('abort', 'OPERATOR')).status).toBe(403);
    expect((await post('cancel', 'OPERATOR')).status).toBe(403);
    expect(control).not.toHaveBeenCalled();
    expect((await post('pause', 'OPERATOR')).status).toBe(200);
    expect((await post('abort', 'ADMIN')).status).toBe(200);
    expect(control).toHaveBeenCalledWith('run-1', 'abort');
  });
});
