import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error-handler.js';
import type { AppVariables } from '../types/index.js';

const fixture = vi.hoisted(() => ({ findUnique: vi.fn(), audit: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findUnique: fixture.findUnique } }) }));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: fixture.audit }));

const { fleetGatewayRouter } = await import('./fleet-gateway.js');

const TOKEN = 'fixture-fleet-gateway-token-at-least-32-characters';
const app = new Hono<AppVariables>().onError(errorHandler).route('/fleet-gateway', fleetGatewayRouter);
const post = (path: string, body: unknown, token: string | null = TOKEN) => app.request(`/fleet-gateway${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { 'x-fleet-gateway-token': token } : {}) },
  body: JSON.stringify(body),
});
const event = {
  action: 'terminal.session.open', subject: 'fixture-subject', actorId: 'alice', nodeId: 'node-1', sessionId: `ts_${'A'.repeat(43)}`,
  outcome: 'opened', at: '2026-01-01T00:00:00.000Z', durationMs: null, ipAddress: '198.51.100.7', fingerprint: null,
};

describe('fleet gateway machine routes', () => {
  beforeEach(() => {
    vi.stubEnv('FLEET_GATEWAY_TOKEN_SHA256', createHash('sha256').update(TOKEN).digest('hex'));
    fixture.findUnique.mockReset();
    fixture.audit.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('requires the gateway credential, and nothing else counts', async () => {
    fixture.findUnique.mockResolvedValue(null);
    expect((await post('/target', { nodeId: 'node-1' }, null)).status).toBe(401);
    expect((await post('/target', { nodeId: 'node-1' }, 'wrong')).status).toBe(401);
    const bearer = await app.request('/fleet-gateway/target', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{"nodeId":"node-1"}' });
    expect(bearer.status).toBe(401);
    expect(fixture.findUnique).not.toHaveBeenCalled();
  });

  it('is off when no digest is configured', async () => {
    vi.stubEnv('FLEET_GATEWAY_TOKEN_SHA256', '');
    expect((await post('/target', { nodeId: 'node-1' })).status).toBe(401);
    expect((await post('/audit', event)).status).toBe(401);
  });

  it('answers only inventory facts, never a node token', async () => {
    fixture.findUnique.mockImplementation(async ({ select }: { select: Record<string, boolean> }) => {
      expect(select).toEqual({ id: true, hostname: true, ipAddress: true, status: true });
      return { id: 'node-1', hostname: 'node-1.example.com', ipAddress: '10.0.0.5', status: 'ONLINE', token: 'must-not-appear' };
    });
    const response = await post('/target', { nodeId: 'node-1' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, data: { nodeId: 'node-1', hostname: 'node-1.example.com', ipAddress: '10.0.0.5', status: 'ONLINE' } });
  });

  it('answers 404 for an unknown node and refuses a malformed id or extra field', async () => {
    fixture.findUnique.mockResolvedValue(null);
    expect((await post('/target', { nodeId: 'node-unknown' })).status).toBe(404);
    fixture.findUnique.mockClear();
    expect((await post('/target', { nodeId: '../nodes' })).status).toBe(400);
    expect((await post('/target', { nodeId: 'node-1', host: 'attacker.example.com' })).status).toBe(400);
    expect(fixture.findUnique).not.toHaveBeenCalled();
  });

  it('records a terminal audit event', async () => {
    expect((await post('/audit', event)).status).toBe(200);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'terminal.session.open', actorId: 'alice', targetType: 'node', targetId: 'node-1', ipAddress: '198.51.100.7',
      details: expect.objectContaining({ subject: 'fixture-subject', outcome: 'opened' }),
    }));
  });

  it.each(['input', 'output', 'data', 'transcript', 'token', 'command'])('has no way to carry %s', async (field) => {
    expect((await post('/audit', { ...event, [field]: 'content' })).status).toBe(400);
    expect(fixture.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown action', { action: 'node.decommission' }],
    ['free text as an outcome', { outcome: 'ls -la /root' }],
    ['a malformed session handle', { sessionId: 'content' }],
    ['a malformed address', { ipAddress: 'not-an-address' }],
    ['a malformed fingerprint', { fingerprint: 'SHA256:nope' }],
    ['a negative duration', { durationMs: -1 }],
  ])('refuses %s', async (_name, change) => {
    expect((await post('/audit', { ...event, ...change })).status).toBe(400);
    expect(fixture.audit).not.toHaveBeenCalled();
  });
});
