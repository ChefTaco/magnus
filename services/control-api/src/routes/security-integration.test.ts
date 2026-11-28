import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nodes = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findMany: async () => nodes } }) }));

const { securityIntegrationRouter } = await import('./security-integration.js');
const { securityInventoryExportSchema } = await import('@hivemagnus/magnus-contracts');

const TOKEN = 'fixture-security-inventory-token';
const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `node ${id}`, hostname: `${id}.example.com`, ipAddress: '192.0.2.10', port: 4100, tags: '[]', metadata: '{}', ...extra,
});
const inventory = () => securityIntegrationRouter.request('/inventory', { headers: { Authorization: `Bearer ${TOKEN}` } });

beforeEach(() => {
  nodes.length = 0;
  vi.stubEnv('SECURITY_INVENTORY_TOKEN_SHA256', createHash('sha256').update(TOKEN).digest('hex'));
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /security-integration/inventory', () => {
  it('skips a node that is not a valid target instead of failing the whole export', async () => {
    vi.stubEnv('TLS_CERT_PATH', '/etc/magnus/tls/cert.pem');
    vi.stubEnv('TLS_KEY_PATH', '/etc/magnus/tls/key.pem');
    nodes.push(node('a'), node('b', { name: '' }), node('c', { metadata: '{"securityIsolationCapable":true,"token":"x"}' }));
    const response = await inventory();
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string; baseUrl: string; metadata: string }>; skipped: unknown[] };
    expect(securityInventoryExportSchema.parse(body)).toBeTruthy();
    expect(body.data.map((target) => target.id)).toEqual(['a', 'c']);
    expect(body.data[0]!.baseUrl).toBe('https://192.0.2.10:4100');
    expect(JSON.parse(body.data[1]!.metadata)).toEqual({ securityIsolationCapable: true });
    expect(body.skipped).toEqual([{ id: 'b', name: '', reason: 'invalid_target' }]);
  });

  it('flags nodes without agent TLS', async () => {
    nodes.push(node('a'), node('b'));
    const response = await inventory();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [], skipped: [
      { id: 'a', name: 'node a', reason: 'agent_tls_required' }, { id: 'b', name: 'node b', reason: 'agent_tls_required' },
    ] });
  });

  it('answers a wrong token with the ApiError envelope', async () => {
    const response = await securityIntegrationRouter.request('/inventory', { headers: { Authorization: 'Bearer wrong' } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
  });
});
