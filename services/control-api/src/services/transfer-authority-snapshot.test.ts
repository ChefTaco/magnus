import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    node: { findUnique: vi.fn().mockResolvedValue({ hostname: 'magnus.example.com' }) },
    commandResourceLease: { groupBy: vi.fn().mockResolvedValue([{ state: 'running', _count: { _all: 2 } }, { state: 'unknown', _count: { _all: 1 } }]) },
    resourceParticipantWork: { groupBy: vi.fn().mockResolvedValue([{ state: 'reserved', _count: { _all: 1 } }]) },
    managedCronOccurrence: { count: vi.fn().mockResolvedValue(3) },
    sharedResourceLease: { groupBy: vi.fn().mockResolvedValue([{ state: 'unknown', _count: { _all: 4 } }]) },
    resourceEnrollment: { findUnique: vi.fn().mockResolvedValue({ state: 'enrolled', epoch: 2, barrierId: 'barrier' }) },
    ardentScopeEnrollment: { findUnique: vi.fn().mockResolvedValue(null) },
    admissionFence: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
  };
  const db = { node: { findMany: vi.fn().mockResolvedValue([{ id: 'node-1', hostname: 'magnus.example.com' }]) },
    $transaction: vi.fn(async callback => callback(tx)) };
  return { db, tx, lock: vi.fn(), fetchProof: vi.fn().mockResolvedValue(null),
    verifyProof: vi.fn().mockReturnValue(null), fetchSchedulerProof: vi.fn().mockResolvedValue(null),
    verifySchedulerProof: vi.fn().mockReturnValue(null) };
});
vi.mock('../db/index.js', () => ({ getDb: () => fixture.db }));
vi.mock('./resource-node-lock.js', () => ({ lockResourceNode: fixture.lock }));
vi.mock('./host-local-writer.js', () => ({ fetchHostLocalWriterProof: fixture.fetchProof,
  verifyHostLocalWriterProof: fixture.verifyProof }));
vi.mock('./os-scheduler-writer.js', () => ({ fetchOsSchedulerWriterProof: fixture.fetchSchedulerProof,
  verifyOsSchedulerWriterProof: fixture.verifySchedulerProof }));
const { transferAuthoritySnapshot, INDEPENDENT_WRITER_CLASSES,
  evaluateIndependentWriterCoverage, evaluateTransferAuthority } = await import('./transfer-authority-snapshot.js');

describe('release authority inventory', () => {
  it('counts retained unknown effects and never promotes a read into a transfer fence', async () => {
    const proof = await transferAuthoritySnapshot('magnus.example.com', 'nonce');
    expect(proof.commandLeases).toEqual({ active: 2, unknown: 1 });
    expect(proof.participantWriters).toEqual({ active: 1, unknown: 0 });
    expect(proof.globalSharedLeases).toEqual({ active: 0, unknown: 4 });
    expect(proof.managedCronUnsettled).toBe(3);
    expect(proof.admissionFenced).toBe(false);
    expect(proof.controlApiNodeAdmission).toEqual({ closed: false, releaseId: null, closedAt: null });
    expect(proof.controlApiSharedAdmission).toEqual({ closed: false, coverage: 'control-api-shared-leases' });
    expect(proof.independentWritersCovered).toBe(false);
    expect(proof.independentWriterCoverage).toMatchObject({
      version: 1, nodeId: 'node-1', nodeFqdn: 'magnus.example.com',
      epoch: 2, barrierId: 'barrier', releaseId: null,
      mutationInventorySha256: null, scheduleInventorySha256: null, complete: false,
    });
    expect(Object.keys(proof.independentWriterCoverage.sourceClasses).sort())
      .toEqual([...INDEPENDENT_WRITER_CLASSES].sort());
    expect(Object.values(proof.independentWriterCoverage.sourceClasses)).toEqual(
      expect.arrayContaining([{ status: 'unverified', ownerReceiptSha256: null, admissionFenceSha256: null }]));
    expect(proof.transferAuthorityComplete).toBe(false);
    expect(proof.transferAuthority.blockers).toEqual(expect.arrayContaining([
      'exactArdentScope', 'nodeAdmissionClosed', 'sharedAdmissionClosed',
      'commandLeasesSettled', 'participantWritersSettled', 'sharedLeasesSettled',
      'managedCronSettled', 'independentWritersCovered',
    ]));
    expect(fixture.lock).toHaveBeenCalledWith(fixture.tx, 'node-1');
    expect(fixture.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(fixture.lock.mock.invocationCallOrder[0]!);
    expect(fixture.tx.sharedResourceLease.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { state: { in: ['reserved', 'running', 'unknown'] } },
    }));
  });

  it('cannot accept complete-looking digest fields without owning-service verification', () => {
    const sourceClasses = Object.fromEntries(INDEPENDENT_WRITER_CLASSES.map((source, index) =>
      [source, { status: 'verified', ownerReceiptSha256: '12345'[index]!.repeat(64),
        admissionFenceSha256: '6789a'[index]!.repeat(64) }]));
    const coverage = { sourceClasses, mutationInventorySha256: 'a'.repeat(64),
      scheduleInventorySha256: 'b'.repeat(64) } as Parameters<typeof evaluateIndependentWriterCoverage>[0];
    expect(evaluateIndependentWriterCoverage(coverage, false)).toMatchObject({
      complete: false, ownerVerified: false, missingClasses: [], inventoriesBound: true,
    });
    sourceClasses['foreign-writer'] = sourceClasses['host-local-mutations'];
    expect(evaluateIndependentWriterCoverage(coverage, true).complete).toBe(false);
    delete sourceClasses['foreign-writer'];
    sourceClasses['os-schedulers'] = sourceClasses['host-local-mutations'];
    expect(evaluateIndependentWriterCoverage(coverage, true).complete).toBe(false);
  });

  it('requires all authority gates, including exact scope and independent writers', () => {
    const input = {
      enrollment: { state: 'enrolled', epoch: 2, barrierId: 'barrier', ardentScopeActive: true },
      scope: { epoch: 2, barrierId: 'barrier' }, nodeAdmissionClosed: true,
      sharedAdmissionClosed: true, commandLeases: { active: 0, unknown: 0 },
      participantWriters: { active: 0, unknown: 0 }, globalSharedLeases: { active: 0, unknown: 0 },
      managedCronUnsettled: 0, independentWritersCovered: true,
    };
    expect(evaluateTransferAuthority(input)).toMatchObject({ complete: true, blockers: [] });
    expect(evaluateTransferAuthority({ ...input, scope: { epoch: 1, barrierId: 'barrier' } }))
      .toMatchObject({ complete: false, blockers: ['exactArdentScope'] });
    expect(evaluateTransferAuthority({ ...input, commandLeases: { active: 0, unknown: 1 },
      independentWritersCovered: false })).toMatchObject({ complete: false,
      blockers: ['commandLeasesSettled', 'independentWritersCovered'] });
  });

  it('denies ambiguous inventory identity', async () => {
    fixture.db.node.findMany.mockResolvedValueOnce([{ id: 'node-1' }, { id: 'node-2' }]);
    await expect(transferAuthoritySnapshot('magnus.example.com', 'nonce')).rejects.toMatchObject({ status: 409 });
  });

  it('reports global shared admission closed by another managed node without claiming independent coverage', async () => {
    fixture.tx.admissionFence.findFirst.mockResolvedValueOnce({ nodeId: 'other-node' });
    const proof = await transferAuthoritySnapshot('magnus.example.com', 'nonce');
    expect(proof.controlApiSharedAdmission).toEqual({ closed: true, coverage: 'control-api-shared-leases' });
    expect(proof.admissionFenced).toBe(false);
    expect(proof.transferAuthorityComplete).toBe(false);
  });

  it('a closed node fence does not claim coverage of independent writers', async () => {
    fixture.tx.admissionFence.findUnique.mockResolvedValueOnce({ releaseId: 'reviewed-release', closedAt: new Date() });
    const proof = await transferAuthoritySnapshot('magnus.example.com', 'nonce');
    expect(proof.controlApiNodeAdmission.closed).toBe(true);
    expect(proof.independentWriterCoverage.releaseId).toBe('reviewed-release');
    expect(proof.independentWriterCoverage.complete).toBe(false);
    expect(proof.independentWritersCovered).toBe(false);
  });

  it('promotes only the signed host-local class when the exact enrolled drain is verified', async () => {
    fixture.tx.resourceEnrollment.findUnique.mockResolvedValueOnce({ state: 'enrolled', epoch: 2, barrierId: 'barrier' });
    fixture.fetchProof.mockResolvedValueOnce({ signed: true });
    fixture.verifyProof.mockReturnValueOnce({ ownerReceiptSha256: 'c'.repeat(64),
      admissionFenceSha256: 'd'.repeat(64), mutationInventorySha256: 'e'.repeat(64) });
    const proof = await transferAuthoritySnapshot('magnus.example.com', 'nonce');
    expect(proof.independentWriterCoverage.sourceClasses['host-local-mutations']).toEqual({
      status: 'verified', ownerReceiptSha256: 'c'.repeat(64), admissionFenceSha256: 'd'.repeat(64),
    });
    expect(proof.independentWriterCoverage.mutationInventorySha256).toBe('e'.repeat(64));
    expect(proof.independentWritersCovered).toBe(false);
    expect(proof.transferAuthorityComplete).toBe(false);
    expect(fixture.verifyProof).toHaveBeenCalledWith({ signed: true }, expect.objectContaining({
      nodeId: 'node-1', epoch: 2, barrierId: 'barrier', nonce: 'nonce',
    }), expect.any(Number));
  });

  it('promotes only an exact signed OS scheduler source proof under enrollment', async () => {
    fixture.fetchSchedulerProof.mockResolvedValueOnce({ signed: true });
    fixture.verifySchedulerProof.mockReturnValueOnce({ ownerReceiptSha256: 'f'.repeat(64),
      admissionFenceSha256: 'a'.repeat(64), scheduleInventorySha256: 'b'.repeat(64) });
    const proof = await transferAuthoritySnapshot('magnus.example.com', 'nonce');
    expect(proof.independentWriterCoverage.sourceClasses['os-schedulers']).toEqual({
      status: 'verified', ownerReceiptSha256: 'f'.repeat(64), admissionFenceSha256: 'a'.repeat(64),
    });
    expect(proof.independentWriterCoverage.scheduleInventorySha256).toBe('b'.repeat(64));
    expect(proof.independentWriterCoverage.sourceClasses['native-hermes'].status).toBe('unverified');
    expect(proof.independentWritersCovered).toBe(false);
    expect(fixture.verifySchedulerProof).toHaveBeenCalledWith({ signed: true }, expect.objectContaining({
      nodeId: 'node-1', epoch: 2, barrierId: 'barrier', nonce: 'nonce',
    }), expect.any(Number));
  });
});
