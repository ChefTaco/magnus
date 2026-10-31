/**
 * Tests for the unified agent server — feature flag routing + auth.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock env module with node management enabled.
vi.mock('./env.js', () => ({
  ENABLE_NODE_MANAGEMENT: true,
  NODE_MANAGER_SECRET: 'test-node-secret',
  NODE_MANAGER_SECRET_PREVIOUS: 'test-node-secret-previous',
  RESULT_SIGNING_SECRET: 'test-result-signing-key-at-least-32-characters',
  CONTROL_API_URL: 'https://localhost:4000',
  HOST_FQDN: 'test-host',
  MAGNUS_EXECUTION_SUPERVISOR_ENABLED: true,
  validateSecrets: vi.fn(),
}));

// Mock heavy node-management route modules to keep tests fast
vi.mock('./collectors/health-routes.js', () => {
  const { Hono } = require('hono');
  const r = new Hono();
  r.get('/', (c: any) => c.json({ status: 'ok' }));
  return { healthRoutes: r };
});
vi.mock('./executors/command-executor.js', () => {
  const { Hono } = require('hono');
  return { commandRoutes: new Hono() };
});
vi.mock('./executors/cron-manager.js', () => {
  const { Hono } = require('hono');
  return { cronRoutes: new Hono() };
});
vi.mock('./executors/file-sync-executor.js', () => {
  const { Hono } = require('hono');
  return { fileRoutes: new Hono() };
});
vi.mock('./executors/skill-manager.js', () => {
  const { Hono } = require('hono');
  return { skillRoutes: new Hono() };
});
vi.mock('./updater/self-updater.js', () => {
  const { Hono } = require('hono');
  return { updateRoutes: new Hono() };
});
vi.mock('./executors/hermes-manager.js', () => {
  const { Hono } = require('hono');
  return { hermesRoutes: new Hono() };
});
import { createApp, hermesCliCandidates } from './server.js';
import type { Hono } from 'hono';

describe('server', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', '');
    app = await createApp();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('probes the configured user-owned Hermes CLI before the system path', () => {
    expect(hermesCliCandidates({ HERMES_USER: 'operator', HERMES_OWNER: 'operator' }))
      .toEqual(['/home/operator/.hermes/hermes-agent/venv/bin/hermes', 'hermes']);
    expect(hermesCliCandidates({ HERMES_USER: '../../tmp/rogue', HERMES_OWNER: 'deploy' }))
      .toEqual(['/home/deploy/.hermes/hermes-agent/venv/bin/hermes', 'hermes']);
  });

  // ── Ping (always available, unauthenticated) ──

  it('GET /api/v1/ping returns features', async () => {
    const res = await app.request('/api/v1/ping');
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.data.features.nodeManagement).toBe(true);
    expect(body.data).not.toHaveProperty('heartbeat');
    expect(body.data).not.toHaveProperty('fingerprints');
    expect(body.data.features.commandReconciliation).toBe(0);
    expect(body.data.features.commandCompletionRegistry).toEqual({ version: 1,
      sha256: '2909a7be52ea7242fe37c6dc38e817895989c12d13affbeb4254eb65c46b0029', enabled: 1 });
  });

  it('advertises reconciliation only with a configured independent key', async () => {
    for (const secret of ['', 'short', 'test-node-secret', 'test-result-signing-key-at-least-32-characters']) {
      vi.stubEnv('COMMAND_RECONCILIATION_SECRET', secret);
      expect((await (await app.request('/api/v1/ping')).json()).data.features.commandReconciliation).toBe(0);
    }
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', 'independent-test-reconciliation-key-at-least-32-characters');
    expect((await (await app.request('/api/v1/ping')).json()).data.features.commandReconciliation).toBe(1);
  });

  // ── Node-management auth (x-node-token) ──

  it('returns 401 for node-management routes without token', async () => {
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(401);
  });

  it('returns 401 for the detailed health check without a node token', async () => {
    const res = await app.request('/api/v1/health/check');
    expect(res.status).toBe(401);
  });

  it('keeps retained mutation inventory behind node authentication', async () => {
    const res = await app.request('/api/v1/commands/mutation-inventory');
    expect(res.status).toBe(401);
  });

  it('returns 401 for node-management routes with wrong token', async () => {
    const res = await app.request('/api/v1/health', {
      headers: { 'x-node-token': 'wrong-secret' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 for node-management routes with correct token', async () => {
    const res = await app.request('/api/v1/health', {
      headers: { 'x-node-token': 'test-node-secret' },
    });
    expect(res.status).toBe(200);
  });

  it('accepts the bounded previous secret during a rotation grace window', async () => {
    const res = await app.request('/api/v1/health', {
      headers: { 'x-node-token': 'test-node-secret-previous' },
    });
    expect(res.status).toBe(200);
  });

  it('does not mount retired IAM routes', async () => {
    const res = await app.request('/api/iam/health');
    expect(res.status).toBe(404);
  });
});

describe('privileged mode route gating', () => {
  const headers = { 'x-node-token': 'test-node-secret' };
  afterEach(() => { vi.unstubAllEnvs(); });

  it('answers 403 AGENT_NOT_PRIVILEGED for root-only routes when unprivileged', async () => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false');
    const app = await createApp();
    for (const [method, path] of [['GET', '/api/v1/cron'], ['POST', '/api/v1/cron/sync'], ['GET', '/api/v1/users'],
      ['POST', '/api/v1/users/provision'], ['POST', '/api/v1/health/system-updates/enable'], ['POST', '/api/v1/ardent/action']] as const) {
      const res = await app.request(path, { method, headers });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error).toMatchObject({ code: 'AGENT_NOT_PRIVILEGED' });
    }
    // Unprivileged-safe routes stay available.
    expect((await app.request('/api/v1/health', { headers })).status).toBe(200);
  });

  it('does not gate those routes in privileged mode', async () => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'true');
    const app = await createApp();
    expect((await app.request('/api/v1/cron', { headers })).status).not.toBe(403);
    expect((await app.request('/api/v1/health/system-updates/enable', { method: 'POST', headers })).status).not.toBe(403);
  });
});
