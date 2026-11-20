import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error-handler.js';
const report = vi.hoisted(() => ({ installationReport: vi.fn(() => ({ schema: 1, magnus: { version: '9.9.9', node: 'v24.22.3', layout: 'package' },
  resolution: { reference: 'npm-shrinkwrap', referenceSha256: 'a'.repeat(64), checkedAt: '2026-11-20T09:43:00.000Z', checked: 2,
    differences: [{ name: 'effect', path: 'node_modules/effect', expected: '3.22.1', actual: '3.20.0' }], truncated: false } })) }));
vi.mock('../services/installation-report-service.js', () => report);
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'installation-route-jwt-fixture-at-least-32-characters', API_SECRET: 'installation-route-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '' }));
const { systemInstallationRouter } = await import('./system-installation.js');
const { signUserToken } = await import('../middleware/auth.js');
const { systemInstallationResponseSchema } = await import('@hivemagnus/magnus-contracts/browser');
const app = new Hono().onError(errorHandler).route('/', systemInstallationRouter);
const as = async (role: 'VIEWER' | 'OPERATOR' | 'ADMIN') => app.request('/', { headers: {
  authorization: `Bearer ${await signUserToken({ userId: `fixture-${role.toLowerCase()}`, username: 'fixture', role })}` } });

describe('GET /system/installation', () => {
  it('refuses a request without credentials', async () => {
    expect((await app.request('/')).status).toBe(401);
  });

  it('keeps dependency versions from every role but ADMIN', async () => {
    for (const role of ['VIEWER', 'OPERATOR'] as const) {
      const response = await as(role);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('3.20.0');
    }
  });

  it('answers ADMIN with the browser contract shape, uncached', async () => {
    const response = await as('ADMIN');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = systemInstallationResponseSchema.parse(await response.json());
    expect(body.data.resolution.differences).toEqual([{ name: 'effect', path: 'node_modules/effect', expected: '3.22.1', actual: '3.20.0' }]);
  });
});
