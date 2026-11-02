import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error-handler.js';
const service = vi.hoisted(() => ({ listUpgradeCandidates: vi.fn(async () => []), verifyAgentRelease: vi.fn(async () => ({ verified: true, integrity: null, reason: null })), latestUpgradeRun: vi.fn(async () => null),
  withCachedPreflight: vi.fn(() => [{ nodeId: 'n', name: 'n', version: '1.1.7', eligible: true, reason: null, code: null, upgrade: null, layout: 'versioned',
    preflight: { status: 'warning', checkedAt: 'x', problems: [{ code: 'FENCE_AHEAD', detail: 'fence 9 for node:n', blocking: false }], report: { ledger: { activeLock: { commandId: 'secret-command' } }, fenceHighWater: { 'node:n': '9' }, writable: { blocked: ['/opt/x'] } } } }]),
  isPrerelease: () => false, getUpgradeRun: vi.fn(), retryUpgradeRun: vi.fn(), startUpgradeRun: vi.fn(), stopUpgradeRun: vi.fn(), checkUpgrade: vi.fn() }));
vi.mock('../services/agent-upgrade-service.js', () => service);
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'upgrade-route-jwt-fixture-at-least-32-characters', API_SECRET: 'upgrade-route-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '' }));
const { agentUpgradesRouter } = await import('./agent-upgrades.js');
const { signUserToken } = await import('../middleware/auth.js');
const app = new Hono().onError(errorHandler).route('/', agentUpgradesRouter);

describe('GET /eligibility', () => {
  const nodes = async (role: 'VIEWER' | 'OPERATOR' | 'ADMIN') => {
    const token = await signUserToken({ userId: `fixture-${role.toLowerCase()}`, username: 'fixture', role });
    const response = await app.request('/eligibility', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { nodes: Array<Record<string, unknown>> } }).data.nodes;
  };

  it('does not hand preflight reports (paths, fences, command ids) to every logged-in role', async () => {
    service.listUpgradeCandidates.mockResolvedValue([{ nodeId: 'n', name: 'n', version: '1.1.7', preflight: { report: { ledger: { activeLock: { commandId: 'secret-command' } }, fenceHighWater: { 'node:n': '9' } } } }] as never);
    for (const value of ['VIEWER', 'OPERATOR'] as const) {
      const [node] = await nodes(value);
      expect(node).not.toHaveProperty('preflight');
      expect(JSON.stringify(node)).not.toMatch(/secret-command|fence/i);
    }
  });

  it('shows them to the role that can run upgrades', async () => {
    expect((await nodes('ADMIN'))[0]).toHaveProperty('preflight.status', 'warning');
  });
});
