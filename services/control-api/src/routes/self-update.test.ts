import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler, HttpError } from '../middleware/error-handler.js';
const calls = vi.hoisted(() => ({ check: vi.fn(), apply: vi.fn(), restart: vi.fn(), status: vi.fn(), audit: vi.fn() }));
vi.mock('../services/self-update-service.js', () => ({ checkForUpdates: calls.check, performSelfUpdate: calls.apply,
  scheduleRestart: calls.restart, getUpdateStatus: vi.fn() }));
vi.mock('../services/api-local-work.js', async original => ({ ...await original<object>(), apiLocalWorkStatus: calls.status }));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: calls.audit }));
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'self-update-route-jwt-fixture-at-least-32-characters',
  API_SECRET: 'self-update-route-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '' }));
process.env['MAGNUS_LEGACY_GIT_SELF_UPDATE'] = 'true';
const { selfUpdateRouter } = await import('./self-update.js');
const { ApiLocalWorkError } = await import('../services/api-local-work.js');
const { signUserToken } = await import('../middleware/auth.js');
const app = new Hono().onError(errorHandler).route('/self-update', selfUpdateRouter);
async function request(path: string, body = {}, role: 'ADMIN' | 'OPERATOR' | 'VIEWER' = 'ADMIN') {
  const token = await signUserToken({ userId: 'fixture-' + role, username: 'fixture', role });
  return app.request('/self-update/' + path, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('git self-update switch', () => {
  it('answers 410 with the upgrade command unless MAGNUS_LEGACY_GIT_SELF_UPDATE=true', async () => {
    process.env['MAGNUS_LEGACY_GIT_SELF_UPDATE'] = 'false';
    try {
      for (const path of ['check', 'apply', 'restart']) {
        const response = await request(path);
        expect(response.status).toBe(410);
        expect((await response.json()).error).toMatchObject({ code: 'SELF_UPDATE_RETIRED', upgradeCommand: 'magnus upgrade' });
      }
      expect(calls.apply).not.toHaveBeenCalled();
    } finally {
      process.env['MAGNUS_LEGACY_GIT_SELF_UPDATE'] = 'true';
    }
  });
});

describe('self-update durable recovery responses', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it.each([409, 503])('preserves admission HTTP status %i and code without inventing a receipt', async status => {
    calls.check.mockRejectedValue(new HttpError(status, 'RESOURCE_DRAIN_REQUIRED', 'Admission denied'));
    const response = await request('check', {}, 'OPERATOR');
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe('RESOURCE_DRAIN_REQUIRED');
    expect(response.headers.get('X-Magnus-Work-Id')).toBeNull();
  });
  it('returns the exact server-created work UUID after a failed check', async () => {
    const workId = randomUUID();
    calls.check.mockRejectedValue(new ApiLocalWorkError(workId, new Error('Fetch failed')));
    const response = await request('check');
    expect(response.status).toBe(500); expect(response.headers.get('X-Magnus-Work-Id')).toBe(workId);
    expect((await response.json()).error.code).toBe('LOCAL_WORK_FAILED');
  });
  it('preserves a typed admission failure and its non-dispatched work receipt', async () => {
    const workId = randomUUID();
    calls.check.mockRejectedValue(new ApiLocalWorkError(workId, new HttpError(409, 'RESOURCE_DRAIN_REQUIRED', 'Drain won')));
    const response = await request('check');
    expect(response.status).toBe(409); expect(response.headers.get('X-Magnus-Work-Id')).toBe(workId);
    expect((await response.json()).error.code).toBe('RESOURCE_DRAIN_REQUIRED');
  });
  it('retains the failed apply receipt when service returns success:false', async () => {
    const workId = randomUUID(); calls.apply.mockResolvedValue({ success: false, error: 'Build failed', workId });
    const response = await request('apply', { restart: true });
    expect(response.status).toBe(500); expect(response.headers.get('X-Magnus-Work-Id')).toBe(workId);
    expect(calls.restart).not.toHaveBeenCalled();
  });
  it('keeps both apply and restart receipts when the subsequent restart fails', async () => {
    const applyId = randomUUID(), restartId = randomUUID();
    calls.apply.mockResolvedValue({ success: true, updated: true, workId: applyId });
    calls.restart.mockRejectedValue(new ApiLocalWorkError(restartId, new HttpError(409, 'RESOURCE_DRAIN_REQUIRED', 'Drain won')));
    const response = await request('apply', { restart: true });
    expect(response.status).toBe(409); expect(response.headers.get('X-Magnus-Work-Id')).toBe(applyId);
    expect(response.headers.get('X-Magnus-Restart-Work-Id')).toBe(restartId);
  });
  it('retains successful apply receipt even when no restart reservation was created', async () => {
    const workId = randomUUID(); calls.apply.mockResolvedValue({ success: true, updated: true, workId });
    calls.restart.mockRejectedValue(new HttpError(503, 'LOCAL_WORK_IDENTITY_UNAVAILABLE', 'Identity unavailable'));
    const response = await request('apply', { restart: true });
    expect(response.status).toBe(503); expect(response.headers.get('X-Magnus-Work-Id')).toBe(workId);
  });
  it('never promotes an arbitrary error property into a recovery header', async () => {
    calls.check.mockRejectedValue(Object.assign(new Error('Untrusted exception'), { workId: randomUUID() }));
    expect((await request('check')).headers.get('X-Magnus-Work-Id')).toBeNull();
    expect(() => new ApiLocalWorkError('not-a-work-uuid', new Error('No'))).toThrow(TypeError);
  });
  it('requires existing route authentication and role before effects or receipt reads', async () => {
    expect((await app.request('/self-update/work/' + randomUUID())).status).toBe(401);
    expect((await request('apply', {}, 'OPERATOR')).status).toBe(403);
    expect((await request('restart', {}, 'VIEWER')).status).toBe(403);
    expect(calls.apply).not.toHaveBeenCalled(); expect(calls.restart).not.toHaveBeenCalled(); expect(calls.status).not.toHaveBeenCalled();
  });
});
