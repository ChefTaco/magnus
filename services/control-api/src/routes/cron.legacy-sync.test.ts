import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';

const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  initial: {} as Record<string, unknown>,
  updated: {} as Record<string, unknown>,
}));
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async () => ({ active: true, role: 'OPERATOR' }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'cron-route-jwt-fixture-at-least-32-characters-long',
  API_SECRET: 'cron-route-api-fixture-at-least-32-characters-long',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '',
  getNodeManagerSecret: () => 'fixture-node-secret' }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ cronJob: {
  findUnique: async () => fixture.initial,
  update: async () => fixture.updated,
} }) }));
vi.mock('../services/managed-cron.js', async original => ({ ...await original<object>(),
  cronMutationMode: async () => 'legacy' }));
vi.mock('../services/audit-service.js', async original => ({ ...await original<object>(), logAuditEvent: vi.fn() }));
vi.mock('../sdk/index.js', () => ({ NodeApiClient: class {
  async syncCronJob(job: { name: string }) { fixture.calls.push(`sync:${job.name}`); }
  async deleteCronJob(name: string) { fixture.calls.push(`delete:${name}`); }
} }));

const { cronRouter } = await import('./cron.js');
const { signUserToken } = await import('../middleware/auth.js');
const app = new Hono().onError(errorHandler).route('/cron', cronRouter);
const node = { ipAddress: '10.0.0.5', port: 4100, metadata: '{}' };
const job = (overrides: Record<string, unknown>) => ({ id: 'cron-1', nodeId: 'node-1', name: 'backup', description: '',
  schedule: '0 * * * *', command: '/usr/bin/true', args: '[]', workingDirectory: null, environment: '{}',
  timeoutSeconds: 60, status: 'ACTIVE', node, ...overrides });

async function patch(body: Record<string, unknown>) {
  const token = await signUserToken({ userId: 'fixture-operator', email: '', role: 'OPERATOR' });
  const response = await app.request('/cron/cron-1', { method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
}

describe('legacy cron PATCH agent push', () => {
  beforeEach(() => { fixture.calls = []; });

  it('removes a paused job from the node instead of re-syncing it', async () => {
    fixture.initial = job({}); fixture.updated = job({ status: 'PAUSED' });
    expect((await patch({ status: 'paused' })).status).toBe(200);
    expect(fixture.calls).toEqual(['delete:backup']);
  });

  it('deletes the old crontab entry before syncing a renamed job', async () => {
    fixture.initial = job({}); fixture.updated = job({ name: 'backup-v2' });
    expect((await patch({ name: 'backup-v2' })).status).toBe(200);
    expect(fixture.calls).toEqual(['delete:backup', 'sync:backup-v2']);
  });

  it('never returns the node token', async () => {
    const withToken = { ...node, token: 'node-fixture-token', name: 'node-1' };
    fixture.initial = job({ node: withToken }); fixture.updated = job({ node: withToken, schedule: '5 * * * *' });
    const response = await patch({ schedule: '5 * * * *' });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain('node-fixture-token');
    expect((JSON.parse(raw) as { data: { node: Record<string, unknown> } }).data.node).toEqual({ ...node, name: 'node-1' });
  });

  it('re-syncs an active job in place', async () => {
    fixture.initial = job({}); fixture.updated = job({ schedule: '5 * * * *' });
    expect((await patch({ schedule: '5 * * * *' })).status).toBe(200);
    expect(fixture.calls).toEqual(['sync:backup']);
  });
});
