import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ level: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findFirst: async ({ where }: { where: { id: string } }) =>
  ({ id: where.id, name: 'node-1', hostname: 'node-1.example.com', ipAddress: '192.0.2.10', port: 4100 }) } }) }));
vi.mock('../utils/env.js', async (original) => ({ ...await original<typeof import('../utils/env.js')>(), getNodeManagerSecret: () => 'fixture-node-secret' }));
vi.mock('../sdk/index.js', () => ({ NodeApiClient: class { ardentStudioLevel = mocks.level; } }));

const { requireArdentStudioAgent, resetArdentStudioCapabilities } = await import('./ardent-service.js');

beforeEach(() => {
  mocks.level.mockReset();
  resetArdentStudioCapabilities();
});

describe('Ardent Studio bridge level', () => {
  it('admits an agent at or above the level a feature needs', async () => {
    mocks.level.mockResolvedValue(2);
    await expect(requireArdentStudioAgent('node-1')).resolves.toBeUndefined();
    await expect(requireArdentStudioAgent('node-1', 2)).resolves.toBeUndefined();
    // A sufficient answer is cached.
    expect(mocks.level).toHaveBeenCalledTimes(1);
  });

  it('asks an agent upgrade of a level 1 agent for missions, and checks again after one', async () => {
    mocks.level.mockResolvedValue(1);
    await expect(requireArdentStudioAgent('node-1')).resolves.toBeUndefined();
    await expect(requireArdentStudioAgent('node-1', 2)).rejects.toMatchObject({ status: 409, code: 'AGENT_UPGRADE_REQUIRED', message: expect.stringMatching(/missions/) });
    mocks.level.mockResolvedValue(2);
    await expect(requireArdentStudioAgent('node-1', 2)).resolves.toBeUndefined();
    expect(mocks.level).toHaveBeenCalledTimes(3);
  });

  it('refuses an agent without the bridge and reports an unreachable one as unavailable', async () => {
    mocks.level.mockResolvedValue(0);
    await expect(requireArdentStudioAgent('node-1')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/sessions and streams/) });
    mocks.level.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(requireArdentStudioAgent('node-1')).rejects.toMatchObject({ status: 503 });
  });
});
