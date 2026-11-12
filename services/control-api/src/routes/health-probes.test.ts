import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dependencies = vi.hoisted(() => ({
  database: vi.fn<() => Promise<unknown>>(async () => [{ '?column?': 1 }]),
  redis: vi.fn<() => Promise<string>>(async () => 'PONG'),
}));
vi.mock('../db/index.js', () => ({ getDb: () => ({ $queryRaw: () => dependencies.database() }) }));
vi.mock('../queue/redis.js', () => ({ getRedis: () => ({ ping: () => dependencies.redis() }) }));

const { app } = await import('../server.js');
const { registerHealthProbes } = await import('./health-probes.js');
const { correlationId } = await import('../middleware/correlation-id.js');
const { tracing } = await import('../middleware/tracing.js');

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('suite health probes', () => {
  it('serves liveness without touching a dependency', async () => {
    dependencies.database.mockClear();
    const response = await app.request('/health/live');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'live', service: 'magnus-control-api' });
    expect(body).not.toHaveProperty('version');
    expect(dependencies.database).not.toHaveBeenCalled();
  });

  it('is ready when the database and Redis answer', async () => {
    const response = await app.request('/health/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ready', checks: { database: { status: 'up', critical: true }, redis: { status: 'up', critical: false } },
    });
  });

  it('is degraded, not down, without Redis', async () => {
    dependencies.redis.mockRejectedValueOnce(new Error('connect ECONNREFUSED 192.0.2.10:6379'));
    const response = await app.request('/health/ready');
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; checks: Record<string, Record<string, unknown>> };
    expect(body.status).toBe('degraded');
    expect(body.checks['redis']).toMatchObject({ status: 'down' });
    expect(JSON.stringify(body)).not.toContain('192.0.2.10');
  });

  it('is not ready without the database, and hides the error', async () => {
    dependencies.database.mockRejectedValueOnce(new Error('password authentication failed for user "magnus"'));
    const response = await app.request('/health/ready');
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ status: 'not_ready', checks: { database: { status: 'down' } } });
    expect(text).not.toContain('password');
  });

  it('keeps the request ID and trace headers the server already sends', async () => {
    const local = new Hono();
    local.use('*', correlationId);
    local.use('*', tracing);
    registerHealthProbes(local, []);
    for (const path of ['/health/live', '/health/ready']) {
      const response = await local.request(path, { headers: { 'x-request-id': 'probe-1', traceparent: TRACEPARENT, tracestate: 'vendor=1' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('probe-1');
      expect(response.headers.get('traceparent')).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
      expect(response.headers.get('tracestate')).toBe('vendor=1');
    }
  });

  it('leaves the existing health routes unchanged', async () => {
    const root = await app.request('/');
    expect(await root.json()).toEqual({ service: 'magnus-control-api', status: 'ok' });
    const v1 = await app.request('/api/v1/health');
    expect(v1.status).toBe(200);
    expect(await v1.json()).toEqual({ success: true, data: { service: 'magnus-control-api', status: 'ok' } });
  });
});
