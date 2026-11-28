import { describe, expect, it, vi } from 'vitest';
import { hermesSummaryResponseSchema } from '@hivemagnus/magnus-contracts/browser';
import type { HermesInstallationStatus } from '../types/shared-contracts.js';

vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async (original) => ({ ...await original<object>(),
  JWT_SECRET: 'hermes-summary-jwt-fixture-at-least-32-characters', API_SECRET: 'hermes-summary-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '' }));

const installation = (id: string, status: HermesInstallationStatus) => ({ id, hostname: `${id}.example.com`, displayName: null, status });
const profile = (id: string, gatewayStatus: string, status: HermesInstallationStatus) => ({ id, gatewayStatus, installation: installation(`host-${id}`, status) });
vi.mock('../services/hermes-service.js', async (original) => ({ ...await original<object>(),
  listHermesInstallations: async () => [installation('a', 'running'), installation('b', 'detected'), installation('c', 'degraded'), installation('d', 'not_installed')],
  listHermesProfiles: async () => [profile('p1', 'running', 'running'), profile('p2', 'inactive', 'detected'), profile('p3', 'running', 'not_installed')],
}));

const { summarizeHermesInventory } = await import('../services/hermes-summary.js');
const { app } = await import('../server.js');
const { signUserToken } = await import('../middleware/auth.js');

const as = async (role: 'ADMIN' | 'OPERATOR' | 'VIEWER') =>
  ({ authorization: `Bearer ${await signUserToken({ userId: role, email: 'alice@example.com', role })}` });

describe('summarizeHermesInventory', () => {
  it('does not count rows for hosts without Hermes, or leftover homes as healthy', () => {
    expect(summarizeHermesInventory(
      [{ status: 'running' }, { status: 'detected' }, { status: 'degraded' }, { status: 'not_installed' }],
      [{ gatewayStatus: 'running', installation: { status: 'running' } }, { gatewayStatus: 'inactive', installation: { status: 'detected' } },
        { gatewayStatus: 'running', installation: { status: 'not_installed' } }],
    )).toEqual({ installations: 3, healthyInstallations: 2, profiles: 2, runningGateways: 1 });
  });

  it('counts nothing for an empty inventory', () => {
    expect(summarizeHermesInventory([], [])).toEqual({ installations: 0, healthyInstallations: 0, profiles: 0, runningGateways: 0 });
  });
});

describe('GET /api/v1/hermes/summary', () => {
  it('answers an ADMIN with the counts, in the browser contract shape', async () => {
    const response = await app.request('/api/v1/hermes/summary', { headers: await as('ADMIN') });
    expect(response.status).toBe(200);
    const body = hermesSummaryResponseSchema.parse(await response.json());
    expect(body.data).toEqual({ installations: 3, healthyInstallations: 2, profiles: 2, runningGateways: 1 });
  });

  it.each(['OPERATOR', 'VIEWER'] as const)('refuses %s', async (role) => {
    const response = await app.request('/api/v1/hermes/summary', { headers: await as(role) });
    expect(response.status).toBe(403);
  });

  it('refuses a caller without credentials', async () => {
    expect((await app.request('/api/v1/hermes/summary')).status).toBe(401);
  });

  it('is not added to the deprecated /orchestra alias', async () => {
    const response = await app.request('/api/v1/orchestra/summary', { headers: await as('ADMIN') });
    expect(response.status).toBe(410);
  });
});
