import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/env.js', () => ({
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '',
  JWT_SECRET: 'isolated-jwt-fixture-secret-at-least-32',
  API_SECRET: 'isolated-api-fixture-secret-at-least-32',
  MAGNUS_PLUGIN_API_ENABLED: true, MAGNUS_APPROVAL_BRIDGE_CONSUMER: '',
  MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({
    magnus: '4cd2cd8ce912b646598abfc7c79e8fd745b31d27e953cbc3eaca9bc6d11cc561',
  }),
  MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: '', MAGNUS_FLEET_CHECK_TOKEN_SHA256: '',
  MAGNUS_COLLECTOR_TOKEN_SHA256: '',
}));
vi.mock('../services/credential-rotation-service.js', () => ({
  verifyWithRotation: (_: string, expected: string, actual: string) => expected === actual,
}));
vi.mock('../services/dependency-service.js', () => ({
  buildDependencyGraph: vi.fn(async () => ({
    discoveredAt: '2026-09-28T04:00:00.000Z', status: 'partial',
    nodes: [{ id: 'node-1', name: 'Magnus', ip: '10.0.0.7',
      services: [{ port: 4000, protocol: 'tcp', process: 'private-process', pid: 123 }],
      collection: { status: 'unknown', observedAt: '2026-09-28T04:00:00.000Z', reason: 'unavailable' } }],
    edges: [{ from: 'node-1', to: 'node-2', fromPort: 5555, toPort: 5432,
      service: 'postgres', connectionCount: 2 }],
  })),
}));

import { dependenciesRouter } from './dependencies.js';
import { errorHandler } from '../middleware/error-handler.js';
const app = new Hono().route('/api/v1/dependencies', dependenciesRouter).onError(errorHandler);

describe('dependency graph read boundary', () => {
  it('redacts endpoint details for the scoped plugin read principal and denies scan', async () => {
    const headers = { authorization: 'Bearer plugin-scoped-token-for-unit-tests-12345' };
    const response = await app.request('/api/v1/dependencies', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: {
      discoveredAt: '2026-09-28T04:00:00.000Z', status: 'partial',
      nodes: [{ id: 'node-1', name: 'Magnus', collection: {
        status: 'unknown', observedAt: '2026-09-28T04:00:00.000Z', reason: 'collection_unavailable',
      } }],
      edges: [{ from: 'node-1', to: 'node-2', service: 'postgres', connectionCount: 2 }],
    } });
    expect((await app.request('/api/v1/dependencies/scan', { method: 'POST', headers })).status).toBe(403);
  });

  it('preserves the full graph for an administrator', async () => {
    const response = await app.request('/api/v1/dependencies', {
      headers: { 'x-api-secret': 'isolated-api-fixture-secret-at-least-32' },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { nodes: Array<{ ip: string; services: unknown[] }> } };
    expect(body.data.nodes[0].ip).toBe('10.0.0.7');
    expect(body.data.nodes[0].services).toHaveLength(1);
  });
});
