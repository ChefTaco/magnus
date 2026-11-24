import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ level: vi.fn(), resource: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findFirst: async ({ where }: { where: { id: string } }) =>
  ({ id: where.id, name: 'node-1', hostname: 'node-1.example.com', ipAddress: '192.0.2.10', port: 4100 }) } }) }));
vi.mock('../utils/env.js', async (original) => ({ ...await original<typeof import('../utils/env.js')>(), getNodeManagerSecret: () => 'fixture-node-secret' }));
vi.mock('../sdk/index.js', () => ({ NodeApiClient: class { ardentStudioLevel = mocks.level; getArdentProfileResource = mocks.resource; } }));

const { ardentAcceptsExecution, requireArdentProfileCapability, requireArdentStudioAgent, resetArdentStudioCapabilities } = await import('./ardent-service.js');

beforeEach(() => {
  mocks.level.mockReset();
  mocks.resource.mockReset();
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

  it('names skill installs when a level 2 agent is asked for one', async () => {
    mocks.level.mockResolvedValue(2);
    await expect(requireArdentStudioAgent('node-1', 3)).rejects.toMatchObject({ status: 409, code: 'AGENT_UPGRADE_REQUIRED', message: expect.stringMatching(/HiveSkills catalog skills/) });
    mocks.level.mockResolvedValue(3);
    await expect(requireArdentStudioAgent('node-1', 3)).resolves.toBeUndefined();
  });

  it('refuses an agent without the bridge and reports an unreachable one as unavailable', async () => {
    mocks.level.mockResolvedValue(0);
    await expect(requireArdentStudioAgent('node-1')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/sessions and streams/) });
    mocks.level.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(requireArdentStudioAgent('node-1')).rejects.toMatchObject({ status: 503 });
  });
});

describe('Ardent profile capabilities', () => {
  const current = { version: '3.2.0', profile: 'current', capabilities: { artifact_transfer: 2 }, recovery: { ready: 0, reconciling: 0, awaiting_decision: 0, unsupported: 0 } };
  const legacy = { version: '3.1.4', profile: 'legacy' };
  beforeEach(() => {
    mocks.level.mockResolvedValue(4);
    mocks.resource.mockImplementation(async (profile: string) => profile === 'current' ? current : legacy);
  });

  it('admits a 3.2.0 profile and refuses a 3.1.4 one with the capability and both versions', async () => {
    for (const gate of ['recovery', 'lineage', 'artifact_transfer'] as const) await expect(requireArdentProfileCapability('node-1', 'current', gate)).resolves.toBeUndefined();
    // The answer is remembered, so a download in chunks reads the status once.
    expect(mocks.resource).toHaveBeenCalledTimes(1);
    expect(mocks.resource).toHaveBeenCalledWith('current', 'status', undefined, undefined);
    await expect(requireArdentProfileCapability('node-1', 'legacy', 'recovery')).rejects.toMatchObject({ status: 409, code: 'unsupported_capability',
      details: { capability: 'ardent.recovery.v1', required_version: '3.2.0', installed_version: '3.1.4' } });
    await expect(requireArdentProfileCapability('node-1', 'legacy', 'artifact_transfer')).rejects.toMatchObject({ status: 409,
      details: { capability: 'artifact-transfer.v2', installed_version: '3.1.4' } });
    expect(await ardentAcceptsExecution('node-1', 'current')).toBe(true);
    expect(await ardentAcceptsExecution('node-1', 'legacy')).toBe(false);
  });

  it('needs a studio 4 agent first, and reports an unreadable profile as unavailable', async () => {
    mocks.level.mockResolvedValue(3);
    await expect(requireArdentProfileCapability('node-1', 'current', 'lineage')).rejects.toMatchObject({ status: 409, code: 'AGENT_UPGRADE_REQUIRED',
      message: expect.stringMatching(/recovery, lineage/) });
    expect(await ardentAcceptsExecution('node-1', 'current')).toBe(false);
    expect(mocks.resource).not.toHaveBeenCalled();
    mocks.level.mockResolvedValue(4);
    mocks.resource.mockRejectedValue(new Error('Ardent management listener identity differs or is unavailable'));
    await expect(requireArdentProfileCapability('node-1', 'current', 'lineage')).rejects.toMatchObject({ status: 503 });
    expect(await ardentAcceptsExecution('node-1', 'current')).toBe(false);
  });
});
