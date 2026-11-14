import { describe, expect, it, vi } from 'vitest';

const findMany = vi.fn(async () => [{ id: 'node-a', name: 'node-a', hostname: 'node-a.example.com', ipAddress: '192.0.2.10', port: 4100,
  status: 'ONLINE', credentials: [], agent: { version: '2.10.2' } }, { id: 'node-b', name: 'node-b', hostname: 'node-b.example.com',
  ipAddress: '192.0.2.20', port: 4100, status: 'ONLINE', credentials: [], agent: null }]);
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findMany } }) }));
const { nodeCredentialStore } = await import('./node-credential-store.js');

describe('the fleet the summary and the start-up guard judge', () => {
  it('leaves out decommissioned nodes and the internal __control-api__ / __dashboard__ log sources, and carries the agent version', async () => {
    expect(await nodeCredentialStore.fleet()).toMatchObject([{ id: 'node-a', agentVersion: '2.10.2' }, { id: 'node-b', agentVersion: null }]);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ where: { status: { not: 'DECOMMISSIONED' }, id: { notIn: ['__control-api__', '__dashboard__'] } },
      select: { agent: { select: { version: true } } } });
  });
});
