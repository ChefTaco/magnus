import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';

vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'fixture-deploy-retirement-jwt-secret-at-least-32',
  API_SECRET: 'fixture-deploy-retirement-api-secret-at-least-32',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '',
}));
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async () => ({ active: true, role: 'ADMIN' }), invalidateUserStatus: () => undefined,
}));
const { deployRouter } = await import('./deploy.js');
const { signUserToken } = await import('../middleware/auth.js');
const app = new Hono().onError(errorHandler).route('/api/v1/deploy', deployRouter);

describe('retired API deployment surface', () => {
  it('requires authentication on legacy endpoints', async () => {
    expect((await app.request('/api/v1/deploy/agent', { method: 'POST' })).status).toBe(401);
  });
  it('keeps all deployment and migration endpoints retired even for administrators', async () => {
    const token = await signUserToken({ userId: 'fixture-admin', username: 'fixture', role: 'ADMIN' });
    for (const path of ['', '/agent', '/upgrade', '/control-node', '/migrate', '/arbitrary']) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const response = await app.request(`/api/v1/deploy${path}`, { method, headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(410);
        expect((await response.json()).error.code).toBe('DEPLOYMENT_PATH_RETIRED');
      }
    }
  });
});
