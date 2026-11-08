import { describe, expect, it, vi } from 'vitest';

const status = { agentId: 'ardent-lead-0000', workspaceId: 'ardent-agents', expiresAt: '2026-12-01T00:00:00.000Z', lastRenewedAt: null,
  lastAttemptAt: null, nextRenewalAt: '2026-11-16T00:00:00.000Z', failures: 0, lastError: null, state: 'ok' as const };
const profile = (id: string) => ({ id, name: id, backend: 'llamacpp', apiPort: 9910, running: true, a2aEnabled: false, channels: {}, error: null });
const tx = { ardentInstallation: { upsert: async () => ({ id: 'installation-1' }) }, ardentProfile: { deleteMany: async () => ({}), upsert: async () => ({}) } };
vi.mock('../db/index.js', () => ({ getDb: () => ({
  node: { findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id, name: 'node-1', hostname: 'node-1.example.com', ipAddress: '192.0.2.10', port: 4100 }) },
  $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
}) }));
vi.mock('../utils/env.js', async (original) => ({ ...await original<typeof import('../utils/env.js')>(), getNodeManagerSecret: () => 'fixture-node-secret' }));
vi.mock('../sdk/index.js', () => ({ NodeApiClient: class {
  getArdentState = async () => ({ success: true, data: { installed: true, version: '2.2.0', owner: 'operator', checkedAt: '2026-11-08T00:00:00.000Z',
    profiles: [profile('lead'), profile('scratch')] } });
} }));
vi.mock('./ardent-command-owner.js', () => ({ ardentCommandOwners: async () => new Map(), commandReconciliationKey: () => null }));
const statuses = vi.fn(async (_nodeIds: string[]) => new Map([['node-1:lead', status]]));
vi.mock('./ardent-hivemem-renewal.js', () => ({ ardentHiveMemCredentialStatuses: (nodeIds: string[]) => statuses(nodeIds) }));

const { getArdentInstallation } = await import('./ardent-service.js');

describe('Ardent installation read', () => {
  it('adds each profile\'s Magnus-managed HiveMem credential status, null where Magnus manages none', async () => {
    const installation = await getArdentInstallation('node-1');
    expect(statuses).toHaveBeenCalledWith(['node-1']);
    expect(installation.profiles.map(item => [item.id, item.hivemem])).toEqual([['lead', status], ['scratch', null]]);
  });
});
