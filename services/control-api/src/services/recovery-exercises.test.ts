import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const nodeFindMany = vi.hoisted(() => vi.fn());
const exerciseFindFirst = vi.hoisted(() => vi.fn());
const exerciseFindUnique = vi.hoisted(() => vi.fn());
const exerciseCreate = vi.hoisted(() => vi.fn());
const queryRaw = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());
vi.mock('../db/index.js', () => ({ getDb: () => ({ $transaction: transaction }) }));

const transactionClient = () => ({
    $queryRaw: queryRaw,
    node: { findMany: nodeFindMany },
    engineeringRecoveryExercise: { findFirst: exerciseFindFirst, findUnique: exerciseFindUnique, create: exerciseCreate },
  });

const { assessRecoveryExercise, buildRecoveryExerciseRecord, loadRecoveryExerciseAssessmentEvidence,
  loadRecoveryRunnerTrust, recordRecoveryExercise,
  recordRecoveryExerciseFromDedicatedRunner,
  recoveryEvidenceSha256, recoveryExerciseCollectorSchema, recoveryExerciseContractSha256,
  recoveryExerciseInventoryIdentities, recoveryRunnerReceiptSigningBytes } = await import('./recovery-exercises.js');

const digest = (character: string) => character.repeat(64);
const now = new Date('2026-09-20T12:03:00.000Z');
const before = {
  state: [{ key: 'coordinator', valueSha256: digest('1') }],
  taskReceipts: [{ taskId: 'task-1', status: 'completed' as const, receiptSha256: digest('2') }],
  artifacts: [{ artifactId: 'artifact-1', sha256: digest('3') }],
};
const after = structuredClone(before);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const trust = {
  issuer: 'magnus-disposable-runner', keyId: 'runner-key-1', publicKey,
  publicKeySha256: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
};
const tempDirectory = mkdtempSync(join(tmpdir(), 'magnus-recovery-runner-'));
afterAll(() => rmSync(tempDirectory, { recursive: true, force: true }));

function makeInput(scenario: 'backup_restore' | 'rollback' | 'specialist_loss' | 'coordinator_loss' = 'coordinator_loss') {
  const targetId = 'disposable:restore-1';
  const beforeDigests = { stateSha256: recoveryEvidenceSha256(before.state), taskSha256: recoveryEvidenceSha256(before.taskReceipts),
    artifactSha256: recoveryEvidenceSha256(before.artifacts) };
  const afterDigests = { stateSha256: recoveryEvidenceSha256(after.state), taskSha256: recoveryEvidenceSha256(after.taskReceipts),
    artifactSha256: recoveryEvidenceSha256(after.artifacts) };
  const recoveredAt = '2026-09-20T07:02:00.000-05:00';
  const scenarioSubject = recoveryEvidenceSha256({ targetId, scenario, before: beforeDigests, after: afterDigests });
  const common = [
    { kind: 'target_identity', phase: 'before', observedAt: '2026-09-20T11:59:35.000Z', source: 'control-api:target',
      subjectSha256: recoveryEvidenceSha256({ targetId }), observation: { targetId, namespace: 'disposable' } },
    { kind: 'state_capture', phase: 'before', observedAt: '2026-09-20T11:59:40.000Z', source: 'control-api:state',
      subjectSha256: beforeDigests.stateSha256, observation: { entryCount: 1, aggregateSha256: beforeDigests.stateSha256 } },
    { kind: 'task_ledger_capture', phase: 'before', observedAt: '2026-09-20T11:59:41.000Z', source: 'control-api:tasks',
      subjectSha256: beforeDigests.taskSha256, observation: { entryCount: 1, aggregateSha256: beforeDigests.taskSha256 } },
    { kind: 'artifact_manifest_capture', phase: 'before', observedAt: '2026-09-20T11:59:42.000Z', source: 'control-api:artifacts',
      subjectSha256: beforeDigests.artifactSha256, observation: { entryCount: 1, aggregateSha256: beforeDigests.artifactSha256 } },
    { kind: 'state_capture', phase: 'after', observedAt: '2026-09-20T12:02:01.000Z', source: 'control-api:state',
      subjectSha256: afterDigests.stateSha256, observation: { entryCount: 1, aggregateSha256: afterDigests.stateSha256 } },
    { kind: 'task_ledger_capture', phase: 'after', observedAt: '2026-09-20T12:02:02.000Z', source: 'control-api:tasks',
      subjectSha256: afterDigests.taskSha256, observation: { entryCount: 1, aggregateSha256: afterDigests.taskSha256 } },
    { kind: 'artifact_manifest_capture', phase: 'after', observedAt: '2026-09-20T12:02:03.000Z', source: 'control-api:artifacts',
      subjectSha256: afterDigests.artifactSha256, observation: { entryCount: 1, aggregateSha256: afterDigests.artifactSha256 } },
    { kind: 'recovery_probe', phase: 'recovery', observedAt: '2026-09-20T12:02:04.000Z', source: 'control-api:health',
      subjectSha256: recoveryEvidenceSha256({ targetId, scenario, recoveredAt: '2026-09-20T12:02:00.000Z' }),
      observation: { targetId, scenario, ready: true, checkId: 'health-1' } },
  ];
  const scenarios = {
    backup_restore: [
      { kind: 'backup_snapshot', phase: 'before', observation: { backupId: 'backup-1', backupSha256: digest('4') } },
      { kind: 'restore_validation', phase: 'recovery', observation: { backupId: 'backup-1', restoredBackupSha256: digest('4'), restoreReady: true } },
    ],
    rollback: [
      { kind: 'release_baseline', phase: 'before', observation: { fromRevision: 'a'.repeat(40), toRevision: 'b'.repeat(40) } },
      { kind: 'rollback_validation', phase: 'recovery', observation: { fromRevision: 'a'.repeat(40), toRevision: 'b'.repeat(40), activeRevision: 'b'.repeat(40), rollbackReady: true } },
    ],
    specialist_loss: [
      { kind: 'specialist_identity', phase: 'before', observation: { specialistId: 'edge', originalPid: 101,
        workSha256: digest('5'), lossSignal: 'SIGKILL', lossConfirmed: true } },
      { kind: 'delegation_recovery', phase: 'recovery', observation: { specialistId: 'edge', successorId: 'magnus',
        originalPid: 101, successorPid: 102, workSha256: digest('5'), originalIsolated: true, successorReady: true } },
    ],
    coordinator_loss: [
      { kind: 'coordinator_identity', phase: 'before', observation: { coordinatorId: 'coordinator', originalPid: 201,
        leadershipPort: 43123, workSha256: digest('6'), originalEpoch: 1, lossSignal: 'SIGKILL', lossConfirmed: true } },
      { kind: 'leadership_recovery', phase: 'recovery', observation: { coordinatorId: 'coordinator', successorId: 'magnus',
        originalPid: 201, successorPid: 202, leadershipPort: 43123, workSha256: digest('6'), originalEpoch: 1,
        successorEpoch: 2, contenderRejected: true, originalIsolated: true, successorReady: true, splitBrainDetected: false } },
    ],
  } as const;
  const scenarioRows = scenarios[scenario].map((entry, index) => ({ ...entry, status: 'pass',
    observedAt: entry.phase === 'before' ? '2026-09-20T11:59:45.000Z' : '2026-09-20T12:02:05.000Z',
    source: `control-api:scenario-${index}`, subjectSha256: scenarioSubject }));
  return recoveryExerciseCollectorSchema.parse({ exerciseId: 'restore-1', targetId, scenario,
    startedAt: '2026-09-20T07:00:00.000-05:00', recoveredAt, recoveryPointAt: '2026-09-20T06:59:30.000-05:00',
    objectives: { rtoSeconds: 180, rpoSeconds: 60 }, before, after,
    runtimeEvidence: [...common, ...scenarioRows].map(entry => ({ ...entry, status: 'pass' })) });
}

function makeReceipt(input: ReturnType<typeof makeInput>, overrides: Record<string, unknown> = {}) {
  const unsigned = { schemaVersion: 1 as const, issuer: trust.issuer, keyId: trust.keyId, nonce: 'receipt-nonce-1',
    issuedAt: '2026-09-20T12:02:10.000Z', expiresAt: '2026-09-20T12:10:00.000Z',
    exerciseContractSha256: recoveryExerciseContractSha256(input), ...overrides };
  return { ...unsigned, signature: sign(null, recoveryRunnerReceiptSigningBytes(unsigned), privateKey).toString('base64') };
}

function makeRecord(input = makeInput()) {
  return buildRecoveryExerciseRecord(input, makeReceipt(input), trust, digest('8'), now);
}

describe('durable recovery exercises', () => {
  beforeEach(() => {
    transaction.mockReset().mockImplementation(async callback => callback(transactionClient()));
    queryRaw.mockReset().mockImplementation((query: TemplateStringsArray) =>
      String(query).includes('pg_roles') ? Promise.resolve([{
        sessionUser: 'magnus_recovery_runner', currentUser: 'magnus_recovery_runner',
        superuser: false, createDb: false, createRole: false, inheritPrivileges: false,
        replication: false, bypassRls: false, hasRoleMembership: false,
        canConnect: true, canCreateDatabaseObjects: false, canCreateTemporaryTables: false,
        canUseSchema: true, canCreateSchemaObjects: false, canReadNodes: true,
        canReadExercises: true, canInsertExercises: true, hasUnexpectedTablePrivilege: false,
      }]) : Promise.resolve([{ snapshot: '100:200:' }]));
    nodeFindMany.mockReset().mockResolvedValue([]);
    exerciseFindFirst.mockReset().mockResolvedValue(null);
    exerciseFindUnique.mockReset().mockResolvedValue(null);
    exerciseCreate.mockReset().mockImplementation(({ data }) => Promise.resolve(data));
  });

  it('verifies only a signed, snapshot-bound receipt and normalizes offset timestamps', () => {
    const record = makeRecord();
    expect(record.recoveredAt.toISOString()).toBe('2026-09-20T12:02:00.000Z');
    expect(record).toMatchObject({ runnerIssuer: trust.issuer, runnerKeyId: trust.keyId,
      runnerReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/), inventorySnapshotSha256: digest('8') });
    expect(assessRecoveryExercise('restore-1', record, false, now.getTime(), digest('9'), trust)).toMatchObject({
      verified: true, runnerReceiptValid: true, scenarioSemanticsValid: true, inventorySnapshotsBound: true,
      evidenceIntegrityValid: true, runtimeEvidenceComplete: true, hashesPreserved: true,
      measured: { rtoSeconds: 120, rpoSeconds: 30 }, provenance: 'magnus_recovery_exercise_store',
    });
  });

  it('fails closed on receipt, record, runtime, inventory, and production tampering', () => {
    const record = makeRecord();
    expect(assessRecoveryExercise('restore-1', record, true, now.getTime(), digest('9'), trust)).toMatchObject({ verified: false, isolated: false });
    expect(assessRecoveryExercise('restore-1', record, false, now.getTime(), null, trust)).toMatchObject({ verified: false, inventorySnapshotsBound: false });
    expect(assessRecoveryExercise('restore-1', { ...record, runnerReceiptSha256: digest('f') }, false, now.getTime(), digest('9'), trust))
      .toMatchObject({ verified: false, runnerReceiptValid: false, evidenceIntegrityValid: false });
    const runtime = JSON.parse(record.runtimeEvidenceJson) as Array<{ observation: Record<string, unknown> }>;
    runtime[0]!.observation['targetId'] = 'disposable:tampered';
    expect(assessRecoveryExercise('restore-1', { ...record, runtimeEvidenceJson: JSON.stringify(runtime) }, false, now.getTime(), digest('9'), trust))
      .toMatchObject({ verified: false, evidenceIntegrityValid: false });
  });

  it('requires exact scenario semantics and prevents relabeling generic evidence', () => {
    for (const scenario of ['backup_restore', 'rollback', 'specialist_loss', 'coordinator_loss'] as const)
      expect(recoveryExerciseCollectorSchema.parse(makeInput(scenario)).scenario).toBe(scenario);
    const backup = makeInput('backup_restore');
    expect(() => recoveryExerciseCollectorSchema.parse({ ...backup, scenario: 'rollback' })).toThrow(/rollback|semantics/i);
    const badBackup = structuredClone(backup);
    const restore = badBackup.runtimeEvidence.find(entry => entry.kind === 'restore_validation')!;
    restore.observation = { ...restore.observation, restoredBackupSha256: digest('9') };
    expect(() => recoveryExerciseCollectorSchema.parse(badBackup)).toThrow(/Restored backup/);
    const splitBrain = makeInput('coordinator_loss');
    const leadership = splitBrain.runtimeEvidence.find(entry => entry.kind === 'leadership_recovery')!;
    leadership.observation = { ...leadership.observation, splitBrainDetected: true };
    expect(() => recoveryExerciseCollectorSchema.parse(splitBrain)).toThrow(/Invalid leadership_recovery/);
  });

  it('rejects forged, stale, wrong-key, and replayed receipts', async () => {
    const input = makeInput();
    const forged = { ...makeReceipt(input), signature: Buffer.alloc(64).toString('base64') };
    expect(() => buildRecoveryExerciseRecord(input, forged, trust, digest('8'), now)).toThrow(/receipt/i);
    const stale = makeReceipt(input, { issuedAt: '2026-09-20T11:00:00.000Z', expiresAt: '2026-09-20T13:00:00.000Z' });
    expect(() => buildRecoveryExerciseRecord(input, stale, trust, digest('8'), now)).toThrow(/receipt/i);
    expect(() => buildRecoveryExerciseRecord(input, makeReceipt(input), { ...trust, keyId: 'wrong-key' }, digest('8'), now)).toThrow(/receipt/i);
    exerciseFindFirst.mockResolvedValueOnce({ id: 'used' });
    await expect(recordRecoveryExercise(input, makeReceipt(input), now, trust)).rejects.toMatchObject({ code: 'RECOVERY_RUNNER_RECEIPT_REPLAY' });
    expect(exerciseCreate).not.toHaveBeenCalled();
  });

  it('binds collection to a coherent serializable inventory snapshot and both target identities', async () => {
    const input = makeInput(); const receipt = makeReceipt(input);
    expect(recoveryExerciseInventoryIdentities(input.targetId)).toEqual(['disposable:restore-1', 'restore-1']);
    nodeFindMany.mockResolvedValueOnce([{ id: 'node-1', name: 'restore-1', hostname: 'other', ipAddress: '10.0.0.1' }]);
    await expect(recordRecoveryExercise(input, receipt, now, trust)).rejects.toMatchObject({ code: 'RECOVERY_EXERCISE_PRODUCTION_TARGET' });
    nodeFindMany.mockResolvedValueOnce([]);
    await expect(recordRecoveryExercise(input, receipt, now, trust)).resolves.toMatchObject({ id: 'restore-1' });
    expect(exerciseCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ inventorySnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) });
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('requires the exact connected least-privilege role for the dedicated runner sink', async () => {
    const input = makeInput(); const receipt = makeReceipt(input);
    await expect(recordRecoveryExerciseFromDedicatedRunner(input, receipt, now, trust))
      .resolves.toMatchObject({ id: 'restore-1' });
    queryRaw.mockImplementationOnce(async () => [{
      sessionUser: 'magnus_recovery_runner', currentUser: 'magnus_recovery_runner',
      superuser: false, createDb: false, createRole: false, inheritPrivileges: false,
      replication: false, bypassRls: false, hasRoleMembership: true,
      canConnect: true, canCreateDatabaseObjects: false, canCreateTemporaryTables: false,
      canUseSchema: true, canCreateSchemaObjects: false, canReadNodes: true,
      canReadExercises: true, canInsertExercises: true, hasUnexpectedTablePrivilege: true,
    }]);
    await expect(recordRecoveryExerciseFromDedicatedRunner(input, receipt, now, trust))
      .rejects.toMatchObject({ code: 'RECOVERY_RUNNER_DATABASE_ROLE_INVALID' });
  });

  it('binds assessment to one repeatable-read inventory snapshot', async () => {
    exerciseFindUnique.mockResolvedValueOnce(makeRecord());
    const result = await loadRecoveryExerciseAssessmentEvidence('restore-1');
    expect(result).toMatchObject({ productionIdentityFound: false,
      inventorySnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
  });

  it('loads only a stable single-link 0600 Ed25519 trust file', () => {
    const path = join(tempDirectory, 'runner-key.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, issuer: trust.issuer, keyId: trust.keyId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) }), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(loadRecoveryRunnerTrust(path)).toMatchObject({ issuer: trust.issuer, keyId: trust.keyId, publicKeySha256: trust.publicKeySha256 });
    const symlink = join(tempDirectory, 'runner-key-link.json'); symlinkSync(path, symlink);
    expect(() => loadRecoveryRunnerTrust(symlink)).toThrow();
    const hardlink = join(tempDirectory, 'runner-key-hard.json'); linkSync(path, hardlink);
    expect(() => loadRecoveryRunnerTrust(path)).toThrow(/Unsafe/);
  });
});
