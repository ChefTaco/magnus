import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  hermesInstallation: { deleteMany: vi.fn(async () => undefined) },
  rolloutTarget: { deleteMany: vi.fn(async () => undefined) },
  skillInstallation: { deleteMany: vi.fn(async () => undefined) },
  cronJobExecution: { deleteMany: vi.fn(async () => undefined) },
  cronJob: { deleteMany: vi.fn(async () => undefined) },
  filePatchTask: { deleteMany: vi.fn(async () => undefined) },
  anomalyEvent: { deleteMany: vi.fn(async () => undefined) },
  engineeringMetricSample: { deleteMany: vi.fn(async () => undefined) },
  healthSnapshot: { deleteMany: vi.fn(async () => undefined) },
  logEntry: { deleteMany: vi.fn(async () => undefined) },
  remoteCommand: { deleteMany: vi.fn(async () => undefined) },
  agent: { deleteMany: vi.fn(async () => undefined) },
  node: { delete: vi.fn(async () => undefined) },
}));

vi.mock('../db/index.js', () => ({ getDb: () => dbMock }));

import { deleteNodeCascade } from './node-service.js';

describe('deleteNodeCascade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$transaction.mockImplementation(async (callback: (tx: typeof dbMock) => Promise<void>) => callback(dbMock));
  });

  it('removes Hermes snapshots before deleting their node', async () => {
    await deleteNodeCascade('node-five');

    expect(dbMock.hermesInstallation.deleteMany).toHaveBeenCalledWith({ where: { nodeId: 'node-five' } });
    expect(dbMock.node.delete).toHaveBeenCalledWith({ where: { id: 'node-five' } });
    expect(dbMock.hermesInstallation.deleteMany.mock.invocationCallOrder[0]!)
      .toBeLessThan(dbMock.node.delete.mock.invocationCallOrder[0]!);
    expect(dbMock.anomalyEvent.deleteMany.mock.invocationCallOrder[0]!)
      .toBeLessThan(dbMock.healthSnapshot.deleteMany.mock.invocationCallOrder[0]!);
    expect(dbMock.engineeringMetricSample.deleteMany).toHaveBeenCalledWith({ where: { nodeId: 'node-five' } });
    expect(dbMock.engineeringMetricSample.deleteMany.mock.invocationCallOrder[0]!)
      .toBeLessThan(dbMock.node.delete.mock.invocationCallOrder[0]!);
    expect(dbMock.$transaction).toHaveBeenCalledOnce();
  });

  it('rolls back the whole operation when a child deletion fails', async () => {
    const committed: string[] = [];
    const transactional = {
      ...dbMock,
      hermesInstallation: { deleteMany: vi.fn(async () => { committed.push('hermes'); }) },
      rolloutTarget: { deleteMany: vi.fn(async () => { throw new Error('injected failure'); }) },
      node: { delete: vi.fn(async () => { committed.push('node'); }) },
    };
    dbMock.$transaction.mockImplementationOnce(async (callback: (tx: typeof transactional) => Promise<void>) => {
      try { await callback(transactional); } catch (error) { committed.length = 0; throw error; }
    });

    await expect(deleteNodeCascade('node-five')).rejects.toThrow('injected failure');
    expect(committed).toEqual([]);
    expect(transactional.node.delete).not.toHaveBeenCalled();
  });
});
