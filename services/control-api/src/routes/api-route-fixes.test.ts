/**
 * Regression tests for route fixes found while documenting every route in OpenAPI: request
 * validation, audit events, role-dependent fields and the standard ApiError envelope.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  role: 'ADMIN',
  audit: vi.fn(),
  resolveAnomaly: vi.fn(), resolveNodeAnomalies: vi.fn(), purgeResolvedAnomalies: vi.fn(),
  createScheduledOp: vi.fn(), updateScheduledOp: vi.fn(), deleteScheduledOp: vi.fn(), getScheduledOp: vi.fn(), executeDueOps: vi.fn(),
  getRule: vi.fn(),
  nodeFindUnique: vi.fn(), driftScanCreate: vi.fn(), kyPost: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set(key: string, value: unknown): void }, next: () => Promise<void>) => {
    c.set('user', { userId: `${m.role.toLowerCase()}-1`, email: `${m.role.toLowerCase()}@example.com`, role: m.role });
    await next();
  },
  requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUser: (c: { get(key: string): unknown }) => c.get('user'),
}));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: m.audit }));
vi.mock('../services/anomaly-detector.js', () => ({
  listAnomalyEvents: vi.fn(), getNodeAnomalySummary: vi.fn(), resolveAnomaly: m.resolveAnomaly, getFleetAnomalySummary: vi.fn(),
  resolveNodeAnomalies: m.resolveNodeAnomalies, purgeResolvedAnomalies: m.purgeResolvedAnomalies,
}));
vi.mock('../services/ai-correlation-service.js', () => ({ correlateAnomalies: vi.fn(), getAnomalyCorrelationDetails: vi.fn(), getAnomalyTimeline: vi.fn() }));
vi.mock('../services/ai-schedule-service.js', () => ({
  createScheduledOp: m.createScheduledOp, updateScheduledOp: m.updateScheduledOp, deleteScheduledOp: m.deleteScheduledOp,
  listScheduledOps: vi.fn(), getScheduledOp: m.getScheduledOp, executeDueOps: m.executeDueOps,
}));
vi.mock('../services/fleet-check-log.js', () => ({
  listFleetCheckRuns: async () => ({ directory: '/var/log/magnus/fleet-checks', runs: [] }),
  getLatestFleetCheckRun: async () => ({ directory: '/var/log/magnus/fleet-checks', run: null }),
  listFleetCheckLogFiles: async () => ({ directory: '/var/log/magnus/fleet-checks', files: [] }),
}));
vi.mock('../services/ops-service.js', () => ({
  getDependencyHealth: vi.fn(), getFleetReadiness: vi.fn(), getFleetTimeline: vi.fn(), getRetentionSummary: vi.fn(),
}));
vi.mock('../services/codex-service.js', () => ({ getCodexFleetPosture: vi.fn() }));
vi.mock('../services/remediation-service.js', async (original) => ({ ...await original<object>(), getRule: m.getRule }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findUnique: m.nodeFindUnique }, driftScan: { create: m.driftScanCreate } }) }));
vi.mock('ky', () => ({ default: { post: m.kyPost } }));
vi.mock('../services/node-agent-auth.js', () => ({ agentAuthHeaders: () => ({}) }));

const { Hono } = await import('hono');
const { errorHandler } = await import('../middleware/error-handler.js');
const { anomaliesRouter } = await import('./anomalies.js');
const { aiScheduleRouter } = await import('./ai-schedule.js');
const { fleetChecksRouter } = await import('./fleet-checks.js');
const { mcpRouter } = await import('./mcp.js');
const { remediationRouter } = await import('./remediation.js');
const { driftRouter } = await import('./drift.js');
const app = new Hono().route('/anomalies', anomaliesRouter).route('/ai-schedules', aiScheduleRouter).route('/fleet-checks', fleetChecksRouter)
  .route('/mcp', mcpRouter).route('/remediation', remediationRouter).route('/drift', driftRouter).onError(errorHandler);

const send = (path: string, body?: unknown, method = 'POST') => app.request(path, body === undefined ? { method } : {
  method, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const apiError = (code: string) => ({ success: false, error: { code, message: expect.any(String) } });

beforeEach(() => {
  vi.clearAllMocks();
  m.role = 'ADMIN';
  m.resolveAnomaly.mockResolvedValue(undefined);
  m.resolveNodeAnomalies.mockResolvedValue(3);
  m.purgeResolvedAnomalies.mockResolvedValue(5);
  m.createScheduledOp.mockResolvedValue({ id: 'op-1', name: 'disks' });
  m.updateScheduledOp.mockResolvedValue({ id: 'op-1', name: 'disks' });
  m.deleteScheduledOp.mockResolvedValue({ id: 'op-1', name: 'disks' });
  m.executeDueOps.mockResolvedValue(2);
  m.getScheduledOp.mockResolvedValue(null);
  m.getRule.mockResolvedValue(null);
});

describe('anomalies', () => {
  it('answers invalid JSON on resolve-node with 400, not 500', async () => {
    const response = await send('/anomalies/resolve-node', '{oops');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(apiError('VALIDATION_ERROR'));
    expect((await send('/anomalies/resolve-node', { metric: 'cpu' })).status).toBe(400);
    expect((await send('/anomalies/resolve-node', { nodeId: 42 })).status).toBe(400);
    expect(m.resolveNodeAnomalies).not.toHaveBeenCalled();
    expect((await send('/anomalies/resolve-node', { nodeId: 'node-1', metric: 'cpu' })).status).toBe(200);
    expect(m.resolveNodeAnomalies).toHaveBeenCalledWith('node-1', 'cpu');
  });

  it('refuses a purge retention that would delete every resolved anomaly', async () => {
    for (const retentionDays of [-1, 0, 1.5, '30', 3651, null]) {
      const response = await send('/anomalies/purge', { retentionDays });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(apiError('VALIDATION_ERROR'));
    }
    expect(m.purgeResolvedAnomalies).not.toHaveBeenCalled();
  });

  it('keeps the 30-day default for an empty body', async () => {
    const response = await send('/anomalies/purge');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { deleted: 5, retentionDays: 30 } });
    expect((await send('/anomalies/purge', { retentionDays: 7 })).status).toBe(200);
    expect(m.purgeResolvedAnomalies).toHaveBeenLastCalledWith(7);
  });
});

describe('anomaly audit events', () => {
  it('audits resolving one anomaly, and not an unknown one', async () => {
    m.role = 'OPERATOR';
    expect((await send('/anomalies/anomaly-1/resolve')).status).toBe(200);
    expect(m.audit).toHaveBeenCalledWith({ action: 'anomaly.resolve', actorId: 'operator-1', targetType: 'anomaly', targetId: 'anomaly-1' });
    m.audit.mockClear();
    m.resolveAnomaly.mockRejectedValueOnce(new Error('Record to update not found'));
    expect((await send('/anomalies/missing/resolve')).status).toBe(404);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('audits resolving a node\'s anomalies with the node, metric and count', async () => {
    expect((await send('/anomalies/resolve-node', { nodeId: 'node-1' })).status).toBe(200);
    expect(m.audit).toHaveBeenCalledWith({ action: 'anomaly.resolve_node', actorId: 'admin-1', targetType: 'node', targetId: 'node-1',
      details: { metric: null, resolved: 3 } });
  });

  it('audits a purge with the retention and the number deleted, and not a refused one', async () => {
    expect((await send('/anomalies/purge', { retentionDays: 7 })).status).toBe(200);
    expect(m.audit).toHaveBeenCalledWith({ action: 'anomaly.purge', actorId: 'admin-1', targetType: 'anomaly', targetId: 'resolved',
      details: { retentionDays: 7, deleted: 5 } });
    m.audit.mockClear();
    expect((await send('/anomalies/purge', { retentionDays: -1 })).status).toBe(400);
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe('AI schedules', () => {
  const op = { name: 'disks', cronExpr: '0 * * * *', prompt: 'check disks' };

  it('audits create, update, delete and a manual run', async () => {
    expect((await send('/ai-schedules', op)).status).toBe(201);
    expect(m.audit).toHaveBeenLastCalledWith({ action: 'ai_schedule.create', actorId: 'admin-1', targetType: 'ai-schedule', targetId: 'op-1',
      details: { name: 'disks', cronExpr: '0 * * * *', type: 'chat', nodeId: null } });

    expect((await send('/ai-schedules/op-1', { enabled: false, prompt: 'secret-ish text' }, 'PATCH')).status).toBe(200);
    expect(m.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'ai_schedule.update', targetId: 'op-1',
      details: { changedFields: ['enabled', 'prompt'], enabled: false } }));

    expect((await send('/ai-schedules/op-1', undefined, 'DELETE')).status).toBe(200);
    expect(m.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'ai_schedule.delete', targetId: 'op-1', details: { name: 'disks' } }));

    expect((await send('/ai-schedules/execute-due')).status).toBe(200);
    expect(m.executeDueOps).toHaveBeenCalledWith(undefined, { actorId: 'admin-1', actorType: 'user' });
  });

  it('does not audit a rejected body', async () => {
    expect((await send('/ai-schedules', { ...op, cronExpr: 'every day' })).status).toBe(400);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('answers an unknown operation with the ApiError envelope', async () => {
    const response = await app.request('/ai-schedules/missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Scheduled operation not found' } });
  });
});

describe('fleet checks', () => {
  it.each(['/fleet-checks/runs', '/fleet-checks/latest', '/fleet-checks/files'])('shows the log directory to ADMIN only: %s', async (path) => {
    for (const role of ['VIEWER', 'OPERATOR']) {
      m.role = role;
      const body = await (await app.request(path)).json() as { data: Record<string, unknown> };
      expect(body.data).not.toHaveProperty('directory');
      expect(JSON.stringify(body)).not.toContain('/var/log');
    }
    m.role = 'ADMIN';
    const body = await (await app.request(path)).json() as { data: Record<string, unknown> };
    expect(body.data['directory']).toBe('/var/log/magnus/fleet-checks');
  });
});

describe('ApiError envelope', () => {
  it('answers MCP errors with it, keeping the status codes', async () => {
    const unsupported = await send('/mcp', { method: 'resources/list' });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toEqual({ success: false, error: { code: 'UNSUPPORTED_METHOD', message: 'Supported methods: tools/list, tools/call' } });
    const unknown = await send('/mcp', { method: 'tools/call', params: { name: 'magnus_delete_everything' } });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ success: false, error: { code: 'UNKNOWN_TOOL', message: 'Unknown tool: magnus_delete_everything' } });
  });

  it('answers an unknown remediation rule with it', async () => {
    const response = await app.request('/remediation/rules/missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Rule not found' } });
  });
});

describe('drift scan', () => {
  it('audits a scan that failed to reach the agent', async () => {
    m.nodeFindUnique.mockResolvedValue({ id: 'node-1', ipAddress: '192.0.2.10', port: 4100 });
    m.driftScanCreate.mockResolvedValue({ id: 'scan-1', nodeId: 'node-1', status: 'error' });
    m.kyPost.mockReturnValue({ json: async () => { throw new Error('connect ECONNREFUSED 192.0.2.10:4100'); } });
    const response = await send('/drift/scan', { nodeId: 'node-1', checks: [{ type: 'package', name: 'openssh-server', expected: 'installed' }] });
    expect(response.status).toBe(200);
    expect(m.audit).toHaveBeenCalledWith({ action: 'drift.scan', actorId: 'admin-1', targetType: 'node', targetId: 'node-1',
      details: { status: 'error', checks: 1, scanId: 'scan-1' } });
  });
});
