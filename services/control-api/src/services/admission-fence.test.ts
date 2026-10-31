import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const fixture = vi.hoisted(() => {
  const row = { nodeId: 'node-1', nodeFqdn: 'magnus.example', releaseId: '', closedAt: new Date() };
  const tx = {
    $executeRaw: vi.fn(),
    node: { findUnique: vi.fn().mockResolvedValue({ hostname: 'magnus.example' }) },
    admissionFence: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(async ({ data }) => ({ ...row, ...data })), delete: vi.fn() },
    commandResourceLease: { count: vi.fn().mockResolvedValue(0) },
    resourceParticipantWork: { count: vi.fn().mockResolvedValue(0) },
    managedCronOccurrence: { count: vi.fn().mockResolvedValue(0) },
    sharedResourceLease: { count: vi.fn().mockResolvedValue(0) },
  };
  const db = { $transaction: vi.fn(async callback => callback(tx)) };
  return { db, tx, lock: vi.fn() };
});
vi.mock('../db/index.js', () => ({ getDb: () => fixture.db }));
vi.mock('./resource-node-lock.js', () => ({ lockResourceNode: fixture.lock }));
const { assertNodeAdmissionOpen, assertSharedAdmissionOpen, closeNodeAdmission, releaseNodeAdmission } = await import('./admission-fence.js');

describe('node-scoped release Control API fence', () => {
  it('closes exact node admission under its reservation lock and rejects a different release', async () => {
    const release = randomUUID();
    const closed = await closeNodeAdmission('node-1', 'magnus.example', release);
    expect(closed).toMatchObject({ nodeId: 'node-1', releaseId: release, coverage: 'control-api-node-reservations' });
    expect(fixture.lock).toHaveBeenCalledWith(fixture.tx, 'node-1');
    expect(fixture.tx.$executeRaw).toHaveBeenCalledOnce();
    fixture.tx.admissionFence.findUnique.mockResolvedValueOnce({ ...closed });
    await expect(closeNodeAdmission('node-1', 'magnus.example', randomUUID())).rejects.toMatchObject({ code: 'RELEASE_FENCE_CONFLICT' });
  });

  it('blocks reservation and retains the fence while any work is unknown', async () => {
    const release = randomUUID();
    fixture.tx.admissionFence.findUnique.mockResolvedValue({ nodeId: 'node-1', nodeFqdn: 'magnus.example', releaseId: release });
    await expect(assertNodeAdmissionOpen(fixture.tx as never, 'node-1')).rejects.toMatchObject({ code: 'ADMISSION_FENCED' });
    fixture.tx.resourceParticipantWork.count.mockResolvedValueOnce(1);
    await expect(releaseNodeAdmission('node-1', 'magnus.example', release)).rejects.toMatchObject({ code: 'ADMISSION_WORK_UNSETTLED' });
    expect(fixture.tx.admissionFence.delete).not.toHaveBeenCalled();
  });

  it('blocks global shared admission while any managed node fence is closed', async () => {
    fixture.tx.admissionFence.findFirst.mockResolvedValueOnce({ nodeId: 'other-node' });
    await expect(assertSharedAdmissionOpen(fixture.tx as never)).rejects.toMatchObject({ code: 'ADMISSION_FENCED' });
    await expect(assertSharedAdmissionOpen(fixture.tx as never)).resolves.toBeUndefined();
  });

  it('retains the fence while any global shared lease is held', async () => {
    const release = randomUUID();
    fixture.tx.admissionFence.findUnique.mockResolvedValue({ nodeId: 'node-1', nodeFqdn: 'magnus.example', releaseId: release });
    fixture.tx.sharedResourceLease.count.mockResolvedValueOnce(1);
    await expect(releaseNodeAdmission('node-1', 'magnus.example', release)).rejects.toMatchObject({ code: 'ADMISSION_WORK_UNSETTLED' });
    expect(fixture.tx.sharedResourceLease.count).toHaveBeenCalledWith({ where: { state: { in: ['reserved', 'running', 'unknown'] } } });
    expect(fixture.tx.admissionFence.delete).not.toHaveBeenCalled();
  });

  it('releases only the same fence after node-local held work has settled', async () => {
    const release = randomUUID();
    fixture.tx.admissionFence.findUnique.mockResolvedValue({ nodeId: 'node-1', nodeFqdn: 'magnus.example', releaseId: release });
    const result = await releaseNodeAdmission('node-1', 'magnus.example', release);
    expect(result).toMatchObject({ closed: false, releaseId: release });
    expect(fixture.tx.admissionFence.delete).toHaveBeenCalledWith({ where: { nodeId: 'node-1' } });
    await expect(releaseNodeAdmission('node-1', 'magnus.example', randomUUID())).rejects.toMatchObject({ code: 'RELEASE_FENCE_CONFLICT' });
  });
});
