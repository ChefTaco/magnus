import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';

const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  mode: 'legacy' as 'legacy' | 'managed',
  initial: {} as Record<string, unknown>,
  updated: {} as Record<string, unknown>,
  history: new Map<string, Record<string, unknown>[]>(),
  managed: true,
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
vi.mock('../db/index.js', async original => ({ ...await original<object>(), getDb: () => ({ $queryRaw: async () => [], cronJob: {
  findUnique: async () => fixture.initial,
  findMany: async () => [fixture.initial],
  update: async () => fixture.updated,
}, node: { findUnique: async () => ({ id: 'node-1', hostname: 'node-1.example.com' }) }, managedCronDefinition: {
  findUnique: async () => fixture.managed ? { cronJobId: 'cron-1' } : null,
  findMany: async () => fixture.managed ? [
  { cronJobId: 'cron-1', revision: 7, enabled: false, expiresAt: new Date('2030-01-01T00:00:00Z') } ] : [] } }) }));
vi.mock('../services/managed-cron-history.js', () => ({ readManagedCronHistory: async () => fixture.history }));
vi.mock('../services/managed-cron.js', async original => ({ ...await original<object>(),
  cronMutationMode: async () => fixture.mode }));
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
  it('publishes only finite scheduler metadata for the console', async () => {
    fixture.initial = job({ node: { name: 'fixture' } });
    const token = await signUserToken({ userId: 'fixture-viewer', email: '', role: 'OPERATOR' });
    const response = await app.request('/cron', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].managed).toEqual({ revision: 7, enabled: false,
      expiresAt: '2030-01-01T00:00:00.000Z', timezone: 'UTC' });
  });
  it('validates finite schedules before creating a job or consuming idempotency', async () => {
    fixture.mode = 'managed';
    const token = await signUserToken({ userId: 'fixture-operator', email: '', role: 'OPERATOR' });
    const valid = { nodeId: 'node-1', name: 'fixture', schedule: '* * * * *', command: '/usr/bin/uptime', timeoutSeconds: 60,
      managed: { revision: 1, timezone: 'UTC', timeoutSeconds: 60, expiresAt: Date.now() + 60000 } };
    for (const patch of [{ schedule: 'not cron' }, { name: '[AI] invalid' }, { timeoutSeconds: 61 },
      { managed: { ...valid.managed, expiresAt: 1 } }]) {
      const response = await app.request('/cron', { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...valid, ...patch }) });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_MANAGED_CRON');
    }
  });
  it('refuses finite scheduling on legacy nodes before creating an unbounded job', async () => {
    const token = await signUserToken({ userId: 'fixture-operator', email: '', role: 'OPERATOR' });
    const response = await app.request('/cron', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({
      nodeId: 'node-1', name: 'fixture', schedule: '* * * * *', command: '/usr/bin/uptime', timeoutSeconds: 60,
      managed: { revision: 1, timezone: 'UTC', timeoutSeconds: 60, expiresAt: Date.now() + 60000 } }) });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('MANAGED_CRON_ENROLLMENT_REQUIRED');
  });
  beforeEach(() => { fixture.calls = []; fixture.mode = 'legacy'; fixture.history = new Map(); fixture.managed = true; });

  it('shows managed last-run status and history through the existing list and detail responses', async () => {
    fixture.initial = job({ node: { name: 'fixture' }, lastRunAt: null, lastRunExitCode: null,
      executions: [{ id: 'pre-conversion', startedAt: new Date('2029-01-01T00:00:00Z'), exitCode: 7 }] });
    const execution = { id: 'occurrence-1', cronJobId: 'cron-1', nodeId: 'node-1', startedAt: new Date('2030-01-01T00:00:00Z'),
      completedAt: new Date('2030-01-01T00:00:01Z'), exitCode: 0, stdout: 'fixture-ok', stderr: '', durationMs: 1 };
    fixture.history.set('cron-1', [execution]);
    const token = await signUserToken({ userId: 'fixture-operator', email: '', role: 'OPERATOR' });
    const headers = { authorization: `Bearer ${token}` };
    const list = await app.request('/cron', { headers });
    expect((await list.json()).data[0]).toMatchObject({ lastRunAt: execution.startedAt.toISOString(), lastRunExitCode: 0 });
    const detail = await app.request('/cron/cron-1', { headers });
    expect((await detail.json()).data).toMatchObject({ lastRunExitCode: 0,
      executions: [{ id: execution.id, stdout: 'fixture-ok', exitCode: 0 }, { id: 'pre-conversion', exitCode: 7 }] });
  });

  it('preserves legacy execution history and environment redaction', async () => {
    fixture.managed = false;
    fixture.initial = job({ environment: '{"PRIVATE_KEY":"fixture-only"}', lastRunAt: new Date('2030-01-01T00:00:00Z'),
      lastRunExitCode: 7, executions: [{ id: 'legacy-execution', startedAt: new Date('2030-01-01T00:00:00Z'), exitCode: 7 }] });
    const token = await signUserToken({ userId: 'fixture-operator', email: '', role: 'OPERATOR' });
    const response = await app.request('/cron/cron-1', { headers: { authorization: `Bearer ${token}` } });
    const data = (await response.json()).data;
    expect(data).toMatchObject({ lastRunExitCode: 7, executions: [{ id: 'legacy-execution', exitCode: 7 }], environmentKeys: ['PRIVATE_KEY'] });
    expect(data).not.toHaveProperty('environment');
  });

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
