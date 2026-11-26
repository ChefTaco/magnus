import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWebhook: vi.fn(), updateWebhook: vi.fn(), getWebhook: vi.fn(), createRule: vi.fn(), updateRule: vi.fn(), getRule: vi.fn(),
  scan: vi.fn(), nodeFindUnique: vi.fn(), aiMemoryCreate: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { userId: 'admin-1', email: 'admin@example.com', role: 'ADMIN' });
    await next();
  },
  requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUser: (c: { var: { user: unknown } }) => c.var.user,
}));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../services/webhook-security.js', () => ({ validateWebhookTarget: vi.fn(), WebhookOriginNotAllowedError: class extends Error {} }));
vi.mock('../services/webhook-service.js', () => ({
  listWebhookEndpoints: vi.fn(), getWebhookEndpoint: mocks.getWebhook, createWebhookEndpoint: mocks.createWebhook,
  updateWebhookEndpoint: mocks.updateWebhook, deleteWebhookEndpoint: vi.fn(), listDeliveries: vi.fn(),
  testWebhookEndpoint: vi.fn(), dispatchWebhook: vi.fn(), redeliverWebhookDelivery: vi.fn(),
}));
vi.mock('../services/alert-service.js', () => ({
  listAlertRules: vi.fn(), getAlertRule: mocks.getRule, createAlertRule: mocks.createRule, updateAlertRule: mocks.updateRule,
  deleteAlertRule: vi.fn(), listAlertViolations: vi.fn(),
}));
vi.mock('../services/topology-service.js', () => ({ scanTopology: mocks.scan }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findUnique: mocks.nodeFindUnique }, aiMemory: { create: mocks.aiMemoryCreate } }) }));

const { Hono } = await import('hono');
const { errorHandler } = await import('../middleware/error-handler.js');
const { webhooksRouter } = await import('./webhooks.js');
const { alertsRouter } = await import('./alerts.js');
const { topologyRouter } = await import('./topology.js');
const { driftRouter } = await import('./drift.js');
const { pinInsight } = await import('../services/ai-insights-service.js');
const app = new Hono().route('/webhooks', webhooksRouter).route('/alerts', alertsRouter)
  .route('/topology', topologyRouter).route('/drift', driftRouter).onError(errorHandler);

const send = (path: string, body: unknown, method = 'POST') => app.request(path, {
  method, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createWebhook.mockResolvedValue({ id: 'hook-1' });
  mocks.updateWebhook.mockResolvedValue({ id: 'hook-1' });
  mocks.getWebhook.mockResolvedValue({ id: 'hook-1' });
  mocks.createRule.mockResolvedValue({ id: 'rule-1' });
  mocks.updateRule.mockResolvedValue({ id: 'rule-1' });
  mocks.getRule.mockResolvedValue({ id: 'rule-1' });
  mocks.scan.mockResolvedValue({ nodes: [] });
  mocks.aiMemoryCreate.mockResolvedValue({});
});

describe('request bodies are validated before use', () => {
  it('answers bad webhook retries and timeouts with 400, not 500', async () => {
    const hook = { name: 'ops', url: 'https://hooks.example.com/x' };
    expect((await send('/webhooks', { ...hook, retries: 'three' })).status).toBe(400);
    expect((await send('/webhooks', { ...hook, timeoutMs: 999_999 })).status).toBe(400);
    expect((await send('/webhooks', '{not json')).status).toBe(400);
    expect((await send('/webhooks/hook-1', { retries: -1 }, 'PATCH')).status).toBe(400);
    expect(mocks.createWebhook).not.toHaveBeenCalled();
    expect((await send('/webhooks', { ...hook, retries: 2 })).status).toBe(201);
  });

  it('validates alert rules field by field', async () => {
    const rule = { name: 'cpu', metric: 'cpu', operator: 'gt', threshold: 90 };
    expect((await send('/alerts/rules', { ...rule, metric: 'temperature' })).status).toBe(400);
    expect((await send('/alerts/rules', { ...rule, threshold: '90' })).status).toBe(400);
    expect((await send('/alerts/rules/rule-1', { severity: 'apocalyptic' }, 'PATCH')).status).toBe(400);
    expect((await send('/alerts/rules', rule)).status).toBe(201);
  });

  it('bounds the topology probe timeout and keeps an empty body working', async () => {
    expect((await send('/topology/scan', { probeTimeoutMs: 600_000 })).status).toBe(400);
    expect((await send('/topology/scan', '{oops')).status).toBe(400);
    expect((await app.request('/topology/scan', { method: 'POST' })).status).toBe(200);
    expect(mocks.scan).toHaveBeenLastCalledWith(3000);
  });

  it('requires well-formed drift checks', async () => {
    expect((await send('/drift/scan', { nodeId: 'node-1', checks: [] })).status).toBe(400);
    expect((await send('/drift/scan', { nodeId: 'node-1', checks: [{ type: 'kernel', name: 'x', expected: 'y' }] })).status).toBe(400);
    expect(mocks.nodeFindUnique).not.toHaveBeenCalled();
  });

  it('never lets a pinned insight choose its own id', async () => {
    const pinned = await pinInsight({ title: 't', body: 'b', severity: 'info', category: 'c', id: 'chosen', pinnedAt: 'then' } as never);
    expect(pinned.id).not.toBe('chosen');
    expect(pinned.pinnedAt).not.toBe('then');
  });
});
