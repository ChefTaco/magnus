import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';

const fixture = vi.hoisted(() => ({ node: vi.fn(), read: vi.fn(), execute: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findUnique: fixture.node } }) }));
vi.mock('../utils/env.js', () => ({ getNodeManagerSecret: () => 'obviously-fake-node-credential' }));
vi.mock('../sdk/node-api-client.js', () => ({ NodeApiClient: class { softwareStatus = fixture.read; executeCommand = fixture.execute; } }));
const { nodeSoftwareRouter } = await import('./nodes-software.js');
const app = new Hono().onError(errorHandler).route('/nodes', nodeSoftwareRouter);
beforeEach(() => {
  vi.clearAllMocks();
  fixture.node.mockResolvedValue({ id: 'node-a', status: 'ONLINE', ipAddress: '192.0.2.10', port: 4100 });
  fixture.read.mockResolvedValue({ success: true, data: { checkedAt: '2026-11-01T00:00:00.000Z', versions: {}, packageUpdates: {} } });
});
describe('node software read', () => {
  it('uses the owning metadata reader and never generic command dispatch', async () => {
    expect((await app.request('/nodes/node-a/software?command=ignored')).status).toBe(200);
    expect(fixture.node).toHaveBeenCalledWith({ where: { id: 'node-a' } });
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect(fixture.execute).not.toHaveBeenCalled();
  });
  it('does not contact absent or offline nodes', async () => {
    fixture.node.mockResolvedValueOnce(null);
    expect((await app.request('/nodes/missing/software')).status).toBe(404);
    fixture.node.mockResolvedValueOnce({ id: 'node-a', status: 'OFFLINE' });
    expect((await app.request('/nodes/node-a/software')).status).toBe(409);
    expect(fixture.read).not.toHaveBeenCalled();
  });
});
