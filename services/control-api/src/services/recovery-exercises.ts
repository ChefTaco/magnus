import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import { getDb, type Prisma } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const disposableTarget = z.string().regex(/^disposable:[a-zA-Z0-9._/-]{1,140}$/);
const isoDate = z.string().datetime({ offset: true });
const runnerSignature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);

const stateEntrySchema = z.object({ key: id, valueSha256: digest }).strict();
const taskEntrySchema = z.object({
  taskId: id,
  status: z.enum(['completed', 'cancelled', 'failed']),
  receiptSha256: digest,
}).strict();
const artifactEntrySchema = z.object({ artifactId: id, sha256: digest }).strict();

export const recoveryEvidenceSnapshotSchema = z.object({
  state: z.array(stateEntrySchema).min(1).max(200),
  taskReceipts: z.array(taskEntrySchema).max(500),
  artifacts: z.array(artifactEntrySchema).max(500),
}).strict().superRefine((value, ctx) => {
  for (const [path, values] of [
    ['state', value.state.map(entry => entry.key)],
    ['taskReceipts', value.taskReceipts.map(entry => entry.taskId)],
    ['artifacts', value.artifacts.map(entry => entry.artifactId)],
  ] as const) {
    if (new Set(values).size !== values.length)
      ctx.addIssue({ code: 'custom', message: `Duplicate ${path} identity`, path: [path] });
  }
});

const runtimeObservationSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/),
  z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
).refine(value => Object.keys(value).length <= 20 && JSON.stringify(value).length <= 4_000,
  'Runtime observation is too large');

const runtimeObservationSchemas = {
  target_identity: z.object({ targetId: disposableTarget, namespace: z.literal('disposable') }).strict(),
  state_capture: z.object({ entryCount: z.number().int().positive().max(200), aggregateSha256: digest }).strict(),
  task_ledger_capture: z.object({ entryCount: z.number().int().nonnegative().max(500), aggregateSha256: digest }).strict(),
  artifact_manifest_capture: z.object({ entryCount: z.number().int().nonnegative().max(500), aggregateSha256: digest }).strict(),
  recovery_probe: z.object({ targetId: disposableTarget,
    scenario: z.enum(['backup_restore', 'rollback', 'specialist_loss', 'coordinator_loss']),
    ready: z.literal(true), checkId: id }).strict(),
  backup_snapshot: z.object({ backupId: id, backupSha256: digest }).strict(),
  restore_validation: z.object({ backupId: id, restoredBackupSha256: digest, restoreReady: z.literal(true) }).strict(),
  release_baseline: z.object({ fromRevision: z.string().regex(/^[a-f0-9]{40}$/),
    toRevision: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  rollback_validation: z.object({ fromRevision: z.string().regex(/^[a-f0-9]{40}$/),
    toRevision: z.string().regex(/^[a-f0-9]{40}$/), activeRevision: z.string().regex(/^[a-f0-9]{40}$/),
    rollbackReady: z.literal(true) }).strict(),
  specialist_identity: z.object({ specialistId: id, originalPid: z.number().int().positive(), workSha256: digest,
    lossSignal: z.literal('SIGKILL'), lossConfirmed: z.literal(true) }).strict(),
  delegation_recovery: z.object({ specialistId: id, successorId: id,
    originalPid: z.number().int().positive(), successorPid: z.number().int().positive(), workSha256: digest,
    originalIsolated: z.literal(true), successorReady: z.literal(true) }).strict(),
  coordinator_identity: z.object({ coordinatorId: id, originalPid: z.number().int().positive(),
    leadershipPort: z.number().int().positive().max(65_535), workSha256: digest,
    originalEpoch: z.number().int().positive(), lossSignal: z.literal('SIGKILL'), lossConfirmed: z.literal(true) }).strict(),
  leadership_recovery: z.object({ coordinatorId: id, successorId: id,
    originalPid: z.number().int().positive(), successorPid: z.number().int().positive(),
    leadershipPort: z.number().int().positive().max(65_535), workSha256: digest,
    originalEpoch: z.number().int().positive(), successorEpoch: z.number().int().positive(),
    contenderRejected: z.literal(true), originalIsolated: z.literal(true),
    successorReady: z.literal(true), splitBrainDetected: z.literal(false) }).strict(),
} as const;

const runtimeEvidenceInputSchema = z.object({
  kind: z.enum(['target_identity', 'state_capture', 'task_ledger_capture', 'artifact_manifest_capture', 'recovery_probe',
    'backup_snapshot', 'restore_validation', 'release_baseline', 'rollback_validation',
    'specialist_identity', 'delegation_recovery', 'coordinator_identity', 'leadership_recovery']),
  phase: z.enum(['before', 'after', 'recovery']),
  status: z.enum(['pass', 'fail']),
  observedAt: isoDate,
  source: z.string().regex(/^control-api:[a-zA-Z0-9._/-]{1,140}$/),
  subjectSha256: digest,
  observation: runtimeObservationSchema,
}).strict();
const storedRuntimeEvidenceSchema = runtimeEvidenceInputSchema.extend({ evidenceSha256: digest }).strict();

const requiredRuntimeEvidence = [
  ['target_identity', 'before'],
  ['state_capture', 'before'],
  ['task_ledger_capture', 'before'],
  ['artifact_manifest_capture', 'before'],
  ['state_capture', 'after'],
  ['task_ledger_capture', 'after'],
  ['artifact_manifest_capture', 'after'],
  ['recovery_probe', 'recovery'],
] as const;

const scenarioRuntimeEvidence = {
  backup_restore: [['backup_snapshot', 'before'], ['restore_validation', 'recovery']],
  rollback: [['release_baseline', 'before'], ['rollback_validation', 'recovery']],
  specialist_loss: [['specialist_identity', 'before'], ['delegation_recovery', 'recovery']],
  coordinator_loss: [['coordinator_identity', 'before'], ['leadership_recovery', 'recovery']],
} as const;

const recoveryRunnerTrustFileSchema = z.object({
  schemaVersion: z.literal(1),
  issuer: id,
  keyId: id,
  publicKeyPem: z.string().min(64).max(4_096),
}).strict();

const recoveryRunnerReceiptUnsignedSchema = z.object({
  schemaVersion: z.literal(1),
  issuer: id,
  keyId: id,
  nonce: id,
  issuedAt: isoDate,
  expiresAt: isoDate,
  exerciseContractSha256: digest,
}).strict();
export const recoveryRunnerReceiptSchema = recoveryRunnerReceiptUnsignedSchema.extend({ signature: runnerSignature }).strict();
export type RecoveryRunnerReceipt = z.infer<typeof recoveryRunnerReceiptSchema>;

export interface RecoveryRunnerTrust {
  issuer: string;
  keyId: string;
  publicKey: KeyObject;
  publicKeySha256: string;
}

/** Include the disposable namespace value and its underlying identity in fleet collision checks. */
export function recoveryExerciseInventoryIdentities(targetId: string): string[] {
  const parsed = disposableTarget.parse(targetId);
  return [parsed, parsed.slice('disposable:'.length)];
}

export const recoveryExerciseCollectorSchema = z.object({
  exerciseId: id,
  targetId: disposableTarget,
  scenario: z.enum(['backup_restore', 'rollback', 'specialist_loss', 'coordinator_loss']),
  startedAt: isoDate,
  recoveredAt: isoDate,
  recoveryPointAt: isoDate,
  objectives: z.object({
    rtoSeconds: z.number().int().positive().max(86_400),
    rpoSeconds: z.number().int().nonnegative().max(86_400),
  }).strict(),
  before: recoveryEvidenceSnapshotSchema,
  after: recoveryEvidenceSnapshotSchema,
  runtimeEvidence: z.array(runtimeEvidenceInputSchema).min(10).max(100),
}).strict().superRefine((value, ctx) => {
  const bindings = new Set(value.runtimeEvidence.map(entry => `${entry.kind}:${entry.phase}`));
  if (bindings.size !== value.runtimeEvidence.length)
    ctx.addIssue({ code: 'custom', message: 'Runtime evidence kind/phase bindings must be unique', path: ['runtimeEvidence'] });
  const scenarioBindings = scenarioRuntimeEvidence[value.scenario];
  const allowedBindings = [...requiredRuntimeEvidence, ...scenarioBindings];
  for (const [kind, phase] of allowedBindings) {
    if (!bindings.has(`${kind}:${phase}`))
      ctx.addIssue({ code: 'custom', message: `Missing ${phase} ${kind} runtime evidence`, path: ['runtimeEvidence'] });
  }
  const allowedScenarioKinds = new Set<string>(scenarioBindings.map(([kind]) => kind));
  const allScenarioKinds = new Set<string>(Object.values(scenarioRuntimeEvidence).flat().map(([kind]) => kind));
  if (value.runtimeEvidence.some(entry => allScenarioKinds.has(entry.kind) && !allowedScenarioKinds.has(entry.kind)))
    ctx.addIssue({ code: 'custom', message: `Runtime evidence does not match ${value.scenario} semantics`, path: ['runtimeEvidence'] });
  const allowedPairs = new Set(allowedBindings.map(([kind, phase]) => `${kind}:${phase}`));
  const beforeDigests = snapshotDigests(sortedSnapshot(value.before));
  const afterDigests = snapshotDigests(sortedSnapshot(value.after));
  for (const [index, entry] of value.runtimeEvidence.entries()) {
    const parsed = runtimeObservationSchemas[entry.kind].safeParse(entry.observation);
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: `Invalid ${entry.kind} observation`, path: ['runtimeEvidence', index, 'observation'] });
      continue;
    }
    if (!allowedPairs.has(`${entry.kind}:${entry.phase}`))
      ctx.addIssue({ code: 'custom', message: `Invalid ${entry.phase} phase for ${entry.kind}`, path: ['runtimeEvidence', index, 'phase'] });
    const observation = parsed.data as Record<string, unknown>;
    const expected = entry.phase === 'before' ? beforeDigests : afterDigests;
    if (entry.kind === 'target_identity' && observation['targetId'] !== value.targetId)
      ctx.addIssue({ code: 'custom', message: 'Target identity observation does not match targetId', path: ['runtimeEvidence', index] });
    if (entry.kind === 'state_capture'
      && (observation['aggregateSha256'] !== expected.stateSha256
        || observation['entryCount'] !== (entry.phase === 'before' ? value.before.state.length : value.after.state.length)))
      ctx.addIssue({ code: 'custom', message: 'State observation does not match captured state', path: ['runtimeEvidence', index] });
    if (entry.kind === 'task_ledger_capture'
      && (observation['aggregateSha256'] !== expected.taskSha256
        || observation['entryCount'] !== (entry.phase === 'before' ? value.before.taskReceipts.length : value.after.taskReceipts.length)))
      ctx.addIssue({ code: 'custom', message: 'Task observation does not match captured receipts', path: ['runtimeEvidence', index] });
    if (entry.kind === 'artifact_manifest_capture'
      && (observation['aggregateSha256'] !== expected.artifactSha256
        || observation['entryCount'] !== (entry.phase === 'before' ? value.before.artifacts.length : value.after.artifacts.length)))
      ctx.addIssue({ code: 'custom', message: 'Artifact observation does not match captured manifest', path: ['runtimeEvidence', index] });
    if (entry.kind === 'recovery_probe'
      && (observation['targetId'] !== value.targetId || observation['scenario'] !== value.scenario))
      ctx.addIssue({ code: 'custom', message: 'Recovery probe does not match target and scenario', path: ['runtimeEvidence', index] });
  }
  const scenarioObservation = (kind: string) => value.runtimeEvidence.find(entry => entry.kind === kind)?.observation as Record<string, unknown> | undefined;
  if (value.scenario === 'backup_restore') {
    const before = scenarioObservation('backup_snapshot'); const after = scenarioObservation('restore_validation');
    if (before && after && (before['backupId'] !== after['backupId'] || before['backupSha256'] !== after['restoredBackupSha256']))
      ctx.addIssue({ code: 'custom', message: 'Restored backup does not match the captured backup', path: ['runtimeEvidence'] });
  } else if (value.scenario === 'rollback') {
    const before = scenarioObservation('release_baseline'); const after = scenarioObservation('rollback_validation');
    if (before && after && (before['fromRevision'] === before['toRevision'] || before['fromRevision'] !== after['fromRevision']
      || before['toRevision'] !== after['toRevision'] || after['activeRevision'] !== before['toRevision']))
      ctx.addIssue({ code: 'custom', message: 'Rollback validation does not match the exact from/to revisions', path: ['runtimeEvidence'] });
  } else if (value.scenario === 'specialist_loss') {
    const before = scenarioObservation('specialist_identity'); const after = scenarioObservation('delegation_recovery');
    if (before && after && (before['specialistId'] !== after['specialistId'] || after['successorId'] === before['specialistId']
      || before['originalPid'] !== after['originalPid'] || before['originalPid'] === after['successorPid']
      || before['workSha256'] !== after['workSha256']))
      ctx.addIssue({ code: 'custom', message: 'Specialist recovery does not bind a distinct successor', path: ['runtimeEvidence'] });
  } else {
    const before = scenarioObservation('coordinator_identity'); const after = scenarioObservation('leadership_recovery');
    if (before && after && (before['coordinatorId'] !== after['coordinatorId'] || after['successorId'] === before['coordinatorId']
      || before['originalPid'] !== after['originalPid'] || before['originalPid'] === after['successorPid']
      || before['leadershipPort'] !== after['leadershipPort'] || before['workSha256'] !== after['workSha256']
      || after['successorEpoch'] !== Number(before['originalEpoch']) + 1
      || before['originalEpoch'] !== after['originalEpoch']))
      ctx.addIssue({ code: 'custom', message: 'Coordinator recovery does not bind isolated successor leadership', path: ['runtimeEvidence'] });
  }
});

export type RecoveryExerciseCollectorInput = z.infer<typeof recoveryExerciseCollectorSchema>;
type RecoveryEvidenceSnapshot = z.infer<typeof recoveryEvidenceSnapshotSchema>;
type RuntimeEvidenceInput = z.infer<typeof runtimeEvidenceInputSchema>;
type RuntimeEvidence = z.infer<typeof storedRuntimeEvidenceSchema>;

export interface RecoveryExerciseRecord {
  id: string;
  targetId: string;
  scenario: string;
  startedAt: Date;
  recoveredAt: Date;
  recoveryPointAt: Date;
  rtoObjectiveSeconds: number;
  rpoObjectiveSeconds: number;
  beforeStateSha256: string;
  beforeTaskSha256: string;
  beforeArtifactSha256: string;
  afterStateSha256: string;
  afterTaskSha256: string;
  afterArtifactSha256: string;
  beforeEvidenceJson: string;
  afterEvidenceJson: string;
  runtimeEvidenceJson: string;
  directEvidenceSha256: string;
  runnerIssuer: string;
  runnerKeyId: string;
  runnerPublicKeySha256: string;
  runnerNonce: string;
  runnerIssuedAt: Date;
  runnerExpiresAt: Date;
  runnerExerciseContractSha256: string;
  runnerReceiptJson: string;
  runnerReceiptSha256: string;
  inventorySnapshotSha256: string;
  recordSha256: string;
  createdAt: Date;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => codeUnitCompare(a, b)).map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
  return JSON.stringify(value);
}

function codeUnitCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function recoveryEvidenceSha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function loadRecoveryRunnerTrust(path = process.env['MAGNUS_RECOVERY_RUNNER_PUBLIC_KEY_FILE']): RecoveryRunnerTrust {
  if (!path) throw new Error('MAGNUS_RECOVERY_RUNNER_PUBLIC_KEY_FILE is not configured');
  let descriptor: number | undefined;
  let contents = '';
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 8_192n || (Number(before.mode) & 0o022))
      throw new Error('Unsafe recovery runner public-key file');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = fstatSync(descriptor, { bigint: true });
    if (bytesRead !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.nlink !== 1n || before.nlink !== after.nlink || before.mode !== after.mode
      || before.uid !== after.uid || before.gid !== after.gid || (Number(after.mode) & 0o022))
      throw new Error('Recovery runner public-key file changed while reading');
    contents = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const configured = recoveryRunnerTrustFileSchema.parse(JSON.parse(contents));
  const publicKey = createPublicKey(configured.publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Recovery runner key must be Ed25519');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  return { issuer: configured.issuer, keyId: configured.keyId, publicKey,
    publicKeySha256: createHash('sha256').update(publicKeyDer).digest('hex') };
}

function normalizedRunnerReceiptPayload(receipt: RecoveryRunnerReceipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    issuer: receipt.issuer,
    keyId: receipt.keyId,
    nonce: receipt.nonce,
    issuedAt: new Date(receipt.issuedAt).toISOString(),
    expiresAt: new Date(receipt.expiresAt).toISOString(),
    exerciseContractSha256: receipt.exerciseContractSha256,
  };
}

function sortedSnapshot(snapshot: RecoveryEvidenceSnapshot): RecoveryEvidenceSnapshot {
  return {
    state: [...snapshot.state].sort((a, b) => codeUnitCompare(a.key, b.key)),
    taskReceipts: [...snapshot.taskReceipts].sort((a, b) => codeUnitCompare(a.taskId, b.taskId)),
    artifacts: [...snapshot.artifacts].sort((a, b) => codeUnitCompare(a.artifactId, b.artifactId)),
  };
}

function sortedRuntimeEvidence(evidence: RuntimeEvidence[]): RuntimeEvidence[] {
  return [...evidence].sort((a, b) => codeUnitCompare(a.observedAt, b.observedAt)
    || codeUnitCompare(a.phase, b.phase) || codeUnitCompare(a.kind, b.kind) || codeUnitCompare(a.source, b.source));
}

function sortedRuntimeEvidenceInput(evidence: RuntimeEvidenceInput[]): RuntimeEvidenceInput[] {
  return [...evidence].sort((a, b) => codeUnitCompare(a.observedAt, b.observedAt)
    || codeUnitCompare(a.phase, b.phase) || codeUnitCompare(a.kind, b.kind) || codeUnitCompare(a.source, b.source));
}

function runtimeEvidenceDigest(evidence: RuntimeEvidenceInput): string {
  return recoveryEvidenceSha256(evidence);
}

function snapshotDigests(snapshot: RecoveryEvidenceSnapshot) {
  return {
    stateSha256: recoveryEvidenceSha256(snapshot.state),
    taskSha256: recoveryEvidenceSha256(snapshot.taskReceipts),
    artifactSha256: recoveryEvidenceSha256(snapshot.artifacts),
  };
}

function scenarioEvidenceSubject(targetId: string, scenario: string, before: ReturnType<typeof snapshotDigests>,
  after: ReturnType<typeof snapshotDigests>): string {
  return recoveryEvidenceSha256({ targetId, scenario, before, after });
}

function normalizedExerciseContract(input: RecoveryExerciseCollectorInput) {
  return {
    schemaVersion: 1,
    exerciseId: input.exerciseId,
    targetId: input.targetId,
    scenario: input.scenario,
    startedAt: new Date(input.startedAt).toISOString(),
    recoveredAt: new Date(input.recoveredAt).toISOString(),
    recoveryPointAt: new Date(input.recoveryPointAt).toISOString(),
    objectives: input.objectives,
    before: sortedSnapshot(input.before),
    after: sortedSnapshot(input.after),
    runtimeEvidence: sortedRuntimeEvidenceInput(input.runtimeEvidence).map(entry => ({
      ...entry,
      observedAt: new Date(entry.observedAt).toISOString(),
    })),
  };
}

export function recoveryExerciseContractSha256(raw: RecoveryExerciseCollectorInput): string {
  return recoveryEvidenceSha256(normalizedExerciseContract(recoveryExerciseCollectorSchema.parse(raw)));
}

export function recoveryRunnerReceiptSigningBytes(raw: z.input<typeof recoveryRunnerReceiptUnsignedSchema>): Buffer {
  const { signature: _signature, ...unsigned } = raw as z.input<typeof recoveryRunnerReceiptUnsignedSchema> & { signature?: unknown };
  const receipt = recoveryRunnerReceiptUnsignedSchema.parse(unsigned);
  return Buffer.from(canonical({ domain: 'magnus.recovery-runner.v1', ...normalizedRunnerReceiptPayload({
    ...receipt,
    signature: 'A'.repeat(86) + '==',
  }) }));
}

function verifyRecoveryRunnerReceipt(input: RecoveryExerciseCollectorInput, rawReceipt: RecoveryRunnerReceipt,
  trust: RecoveryRunnerTrust, now: Date): RecoveryRunnerReceipt {
  const receipt = recoveryRunnerReceiptSchema.parse(rawReceipt);
  const issuedAt = new Date(receipt.issuedAt);
  const expiresAt = new Date(receipt.expiresAt);
  const latestObservationAt = Math.max(new Date(input.recoveredAt).getTime(),
    ...input.runtimeEvidence.map(entry => new Date(entry.observedAt).getTime()));
  const timingValid = issuedAt.getTime() >= latestObservationAt
    && issuedAt.getTime() >= now.getTime() - 10 * 60_000
    && issuedAt.getTime() <= now.getTime()
    && expiresAt.getTime() > now.getTime()
    && expiresAt.getTime() <= issuedAt.getTime() + 15 * 60_000;
  const identityValid = receipt.issuer === trust.issuer && receipt.keyId === trust.keyId;
  const contractValid = receipt.exerciseContractSha256 === recoveryExerciseContractSha256(input);
  let signatureValid = false;
  try {
    signatureValid = verify(null, recoveryRunnerReceiptSigningBytes(receipt), trust.publicKey,
      Buffer.from(receipt.signature, 'base64'));
  } catch { signatureValid = false; }
  if (!timingValid || !identityValid || !contractValid || !signatureValid)
    throw new HttpError(409, 'RECOVERY_RUNNER_RECEIPT_INVALID', 'Recovery runner receipt failed identity, freshness, contract, or signature verification');
  return { ...receipt, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

function recordPayload(record: Omit<RecoveryExerciseRecord, 'recordSha256'> | RecoveryExerciseRecord) {
  return {
    id: record.id,
    targetId: record.targetId,
    scenario: record.scenario,
    startedAt: record.startedAt.toISOString(),
    recoveredAt: record.recoveredAt.toISOString(),
    recoveryPointAt: record.recoveryPointAt.toISOString(),
    rtoObjectiveSeconds: record.rtoObjectiveSeconds,
    rpoObjectiveSeconds: record.rpoObjectiveSeconds,
    beforeStateSha256: record.beforeStateSha256,
    beforeTaskSha256: record.beforeTaskSha256,
    beforeArtifactSha256: record.beforeArtifactSha256,
    afterStateSha256: record.afterStateSha256,
    afterTaskSha256: record.afterTaskSha256,
    afterArtifactSha256: record.afterArtifactSha256,
    beforeEvidenceJson: record.beforeEvidenceJson,
    afterEvidenceJson: record.afterEvidenceJson,
    runtimeEvidenceJson: record.runtimeEvidenceJson,
    directEvidenceSha256: record.directEvidenceSha256,
    runnerIssuer: record.runnerIssuer,
    runnerKeyId: record.runnerKeyId,
    runnerPublicKeySha256: record.runnerPublicKeySha256,
    runnerNonce: record.runnerNonce,
    runnerIssuedAt: record.runnerIssuedAt.toISOString(),
    runnerExpiresAt: record.runnerExpiresAt.toISOString(),
    runnerExerciseContractSha256: record.runnerExerciseContractSha256,
    runnerReceiptJson: record.runnerReceiptJson,
    runnerReceiptSha256: record.runnerReceiptSha256,
    inventorySnapshotSha256: record.inventorySnapshotSha256,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Build the immutable row from an authenticated runner receipt. No assessment route accepts this input. */
export function buildRecoveryExerciseRecord(raw: RecoveryExerciseCollectorInput, rawReceipt: RecoveryRunnerReceipt,
  trust: RecoveryRunnerTrust, inventorySnapshotSha256: string, now = new Date()): RecoveryExerciseRecord {
  const input = recoveryExerciseCollectorSchema.parse(raw);
  const receipt = verifyRecoveryRunnerReceipt(input, rawReceipt, trust, now);
  digest.parse(inventorySnapshotSha256);
  const before = sortedSnapshot(input.before);
  const after = sortedSnapshot(input.after);
  const startedAt = new Date(input.startedAt);
  const recoveredAt = new Date(input.recoveredAt);
  const recoveryPointAt = new Date(input.recoveryPointAt);
  const runtimeEvidence = sortedRuntimeEvidence(input.runtimeEvidence.map(entry => {
    const normalized = { ...entry, observedAt: new Date(entry.observedAt).toISOString() };
    return { ...normalized, evidenceSha256: runtimeEvidenceDigest(normalized) };
  }));
  if (recoveryPointAt > startedAt || startedAt > recoveredAt || recoveredAt > now)
    throw new HttpError(409, 'RECOVERY_EXERCISE_CHRONOLOGY_INVALID', 'Recovery exercise chronology is invalid');
  const beforeDigests = snapshotDigests(before);
  const afterDigests = snapshotDigests(after);
  const scenarioSubject = scenarioEvidenceSubject(input.targetId, input.scenario, beforeDigests, afterDigests);
  const expectedSubject = (entry: RuntimeEvidence): string => {
    if (entry.kind === 'target_identity') return recoveryEvidenceSha256({ targetId: input.targetId });
    if (entry.kind === 'recovery_probe') return recoveryEvidenceSha256({ targetId: input.targetId,
      scenario: input.scenario, recoveredAt: recoveredAt.toISOString() });
    const values = entry.phase === 'before' ? beforeDigests : afterDigests;
    return entry.kind === 'state_capture' ? values.stateSha256
      : entry.kind === 'task_ledger_capture' ? values.taskSha256
        : entry.kind === 'artifact_manifest_capture' ? values.artifactSha256 : scenarioSubject;
  };
  if (runtimeEvidence.some(entry => entry.subjectSha256 !== expectedSubject(entry)))
    throw new HttpError(409, 'RECOVERY_EXERCISE_EVIDENCE_BINDING_INVALID', 'Runtime evidence is not bound to the collected target and snapshots');
  if (runtimeEvidence.some(entry => {
    const observedAt = new Date(entry.observedAt);
    return entry.phase === 'before'
      ? observedAt < recoveryPointAt || observedAt > startedAt
      : observedAt < recoveredAt || observedAt > now;
  })) throw new HttpError(409, 'RECOVERY_EXERCISE_EVIDENCE_TIME_INVALID', 'Runtime evidence falls outside the exercise record window');
  const partial: Omit<RecoveryExerciseRecord, 'recordSha256'> = {
    id: input.exerciseId,
    targetId: input.targetId,
    scenario: input.scenario,
    startedAt,
    recoveredAt,
    recoveryPointAt,
    rtoObjectiveSeconds: input.objectives.rtoSeconds,
    rpoObjectiveSeconds: input.objectives.rpoSeconds,
    beforeStateSha256: beforeDigests.stateSha256,
    beforeTaskSha256: beforeDigests.taskSha256,
    beforeArtifactSha256: beforeDigests.artifactSha256,
    afterStateSha256: afterDigests.stateSha256,
    afterTaskSha256: afterDigests.taskSha256,
    afterArtifactSha256: afterDigests.artifactSha256,
    beforeEvidenceJson: canonical(before),
    afterEvidenceJson: canonical(after),
    runtimeEvidenceJson: canonical(runtimeEvidence),
    directEvidenceSha256: recoveryEvidenceSha256(runtimeEvidence),
    runnerIssuer: receipt.issuer,
    runnerKeyId: receipt.keyId,
    runnerPublicKeySha256: trust.publicKeySha256,
    runnerNonce: receipt.nonce,
    runnerIssuedAt: new Date(receipt.issuedAt),
    runnerExpiresAt: new Date(receipt.expiresAt),
    runnerExerciseContractSha256: receipt.exerciseContractSha256,
    runnerReceiptJson: canonical(receipt),
    runnerReceiptSha256: recoveryEvidenceSha256(receipt),
    inventorySnapshotSha256,
    createdAt: now,
  };
  return { ...partial, recordSha256: recoveryEvidenceSha256(recordPayload(partial)) };
}

interface InventoryIdentityRow { id: string; name: string; hostname: string; ipAddress: string; }
interface InventorySnapshotEvidence {
  complete: boolean;
  sha256: string | null;
  nodes: InventoryIdentityRow[];
}

interface DedicatedRunnerRoleEvidence {
  sessionUser: string;
  currentUser: string;
  superuser: boolean;
  createDb: boolean;
  createRole: boolean;
  inheritPrivileges: boolean;
  replication: boolean;
  bypassRls: boolean;
  hasRoleMembership: boolean;
  canConnect: boolean;
  canCreateDatabaseObjects: boolean;
  canCreateTemporaryTables: boolean;
  canUseSchema: boolean;
  canCreateSchemaObjects: boolean;
  canReadNodes: boolean;
  canReadExercises: boolean;
  canInsertExercises: boolean;
  hasUnexpectedTablePrivilege: boolean;
}

async function assertDedicatedRunnerDatabaseRole(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<DedicatedRunnerRoleEvidence[]>`
    SELECT session_user AS "sessionUser", current_user AS "currentUser",
      role.rolsuper AS "superuser", role.rolcreatedb AS "createDb",
      role.rolcreaterole AS "createRole", role.rolinherit AS "inheritPrivileges",
      role.rolreplication AS "replication", role.rolbypassrls AS "bypassRls",
      EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member = role.oid) AS "hasRoleMembership",
      has_database_privilege(current_user, current_database(), 'CONNECT') AS "canConnect",
      has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabaseObjects",
      has_database_privilege(current_user, current_database(), 'TEMPORARY') AS "canCreateTemporaryTables",
      has_schema_privilege(current_user, 'public', 'USAGE') AS "canUseSchema",
      has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateSchemaObjects",
      has_table_privilege(current_user, 'public.nodes', 'SELECT') AS "canReadNodes",
      has_table_privilege(current_user, 'public.engineering_recovery_exercises', 'SELECT') AS "canReadExercises",
      has_table_privilege(current_user, 'public.engineering_recovery_exercises', 'INSERT') AS "canInsertExercises",
      EXISTS (
        SELECT 1 FROM pg_class item
        JOIN pg_namespace namespace ON namespace.oid = item.relnamespace
        WHERE namespace.nspname = 'public' AND item.relkind IN ('r', 'p')
          AND (
            (item.relname = 'nodes' AND (
              has_table_privilege(current_user, item.oid, 'INSERT')
              OR has_table_privilege(current_user, item.oid, 'UPDATE')
              OR has_table_privilege(current_user, item.oid, 'DELETE')
              OR has_table_privilege(current_user, item.oid, 'TRUNCATE')
              OR has_table_privilege(current_user, item.oid, 'REFERENCES')
              OR has_table_privilege(current_user, item.oid, 'TRIGGER')))
            OR (item.relname = 'engineering_recovery_exercises' AND (
              has_table_privilege(current_user, item.oid, 'UPDATE')
              OR has_table_privilege(current_user, item.oid, 'DELETE')
              OR has_table_privilege(current_user, item.oid, 'TRUNCATE')
              OR has_table_privilege(current_user, item.oid, 'REFERENCES')
              OR has_table_privilege(current_user, item.oid, 'TRIGGER')))
            OR (item.relname NOT IN ('nodes', 'engineering_recovery_exercises') AND (
              has_table_privilege(current_user, item.oid, 'SELECT')
              OR has_table_privilege(current_user, item.oid, 'INSERT')
              OR has_table_privilege(current_user, item.oid, 'UPDATE')
              OR has_table_privilege(current_user, item.oid, 'DELETE')
              OR has_table_privilege(current_user, item.oid, 'TRUNCATE')
              OR has_table_privilege(current_user, item.oid, 'REFERENCES')
              OR has_table_privilege(current_user, item.oid, 'TRIGGER')))
          )
      ) AS "hasUnexpectedTablePrivilege"
    FROM pg_roles role WHERE role.rolname = current_user`;
  const role = rows[0];
  if (!role || role.sessionUser !== 'magnus_recovery_runner' || role.currentUser !== 'magnus_recovery_runner'
    || role.superuser || role.createDb || role.createRole || role.inheritPrivileges
    || role.replication || role.bypassRls || role.hasRoleMembership
    || !role.canConnect || role.canCreateDatabaseObjects || role.canCreateTemporaryTables
    || !role.canUseSchema || role.canCreateSchemaObjects || !role.canReadNodes
    || !role.canReadExercises || !role.canInsertExercises || role.hasUnexpectedTablePrivilege)
    throw new HttpError(403, 'RECOVERY_RUNNER_DATABASE_ROLE_INVALID',
      'Recovery runner database session is not the exact least-privilege role');
}

async function captureInventorySnapshot(tx: Prisma.TransactionClient): Promise<InventorySnapshotEvidence> {
  const snapshotRows = await tx.$queryRaw<Array<{ snapshot: string }>>`SELECT txid_current_snapshot()::text AS snapshot`;
  const nodes = await tx.node.findMany({ select: { id: true, name: true, hostname: true, ipAddress: true },
    orderBy: { id: 'asc' }, take: 10_001 });
  if (nodes.length > 10_000 || !snapshotRows[0]?.snapshot) return { complete: false, sha256: null, nodes: [] };
  const normalized = [...nodes].sort((a, b) => codeUnitCompare(a.id, b.id)
    || codeUnitCompare(a.name, b.name) || codeUnitCompare(a.hostname, b.hostname) || codeUnitCompare(a.ipAddress, b.ipAddress));
  return { complete: true, sha256: recoveryEvidenceSha256({ databaseSnapshot: snapshotRows[0].snapshot, nodes: normalized }), nodes: normalized };
}

function inventoryHasProductionIdentity(snapshot: InventorySnapshotEvidence, targetId: string): boolean {
  const parsed = disposableTarget.safeParse(targetId);
  if (!parsed.success) return true;
  const identities = new Set(recoveryExerciseInventoryIdentities(parsed.data));
  return snapshot.nodes.some(node => identities.has(node.id) || identities.has(node.name)
    || identities.has(node.hostname) || identities.has(node.ipAddress));
}

/** Internal authenticated runner sink. There is deliberately no public mutation route for this operation. */
async function recordRecoveryExerciseInternal(raw: RecoveryExerciseCollectorInput, receipt: RecoveryRunnerReceipt,
  now: Date, trust: RecoveryRunnerTrust, requireDedicatedRole: boolean): Promise<RecoveryExerciseRecord> {
  return getDb().$transaction(async tx => {
    if (requireDedicatedRole) await assertDedicatedRunnerDatabaseRole(tx);
    const inventory = await captureInventorySnapshot(tx);
    if (!inventory.complete || !inventory.sha256)
      throw new HttpError(409, 'RECOVERY_EXERCISE_INVENTORY_INCOMPLETE', 'A complete coherent inventory snapshot is required');
    if (inventoryHasProductionIdentity(inventory, raw.targetId))
      throw new HttpError(409, 'RECOVERY_EXERCISE_PRODUCTION_TARGET', 'Recovery exercises cannot target production inventory');
    const record = buildRecoveryExerciseRecord(raw, receipt, trust, inventory.sha256, now);
    const replay = await tx.engineeringRecoveryExercise.findFirst({
      where: { OR: [{ runnerNonce: record.runnerNonce }, { runnerReceiptSha256: record.runnerReceiptSha256 }] },
      select: { id: true },
    });
    if (replay) throw new HttpError(409, 'RECOVERY_RUNNER_RECEIPT_REPLAY', 'Recovery runner receipt was already consumed');
    return tx.engineeringRecoveryExercise.create({ data: record });
  }, { isolationLevel: 'Serializable' });
}

export async function recordRecoveryExercise(raw: RecoveryExerciseCollectorInput, receipt: RecoveryRunnerReceipt,
  now = new Date(), trust = loadRecoveryRunnerTrust()): Promise<RecoveryExerciseRecord> {
  return recordRecoveryExerciseInternal(raw, receipt, now, trust, false);
}

/** CLI-only sink: proves the connected session is the exact constrained runner role before reading or inserting. */
export async function recordRecoveryExerciseFromDedicatedRunner(raw: RecoveryExerciseCollectorInput,
  receipt: RecoveryRunnerReceipt, now = new Date(), trust = loadRecoveryRunnerTrust()): Promise<RecoveryExerciseRecord> {
  return recordRecoveryExerciseInternal(raw, receipt, now, trust, true);
}

export async function loadRecoveryExerciseAssessmentEvidence(exerciseId: string) {
  return getDb().$transaction(async tx => {
    const record = await tx.engineeringRecoveryExercise.findUnique({ where: { id: exerciseId } });
    if (!record) return { record: undefined, productionIdentityFound: false, inventorySnapshotSha256: null };
    const inventory = await captureInventorySnapshot(tx);
    return { record, productionIdentityFound: inventory.complete && inventoryHasProductionIdentity(inventory, record.targetId),
      inventorySnapshotSha256: inventory.complete ? inventory.sha256 : null };
  }, { isolationLevel: 'RepeatableRead' });
}

export function assessRecoveryExercise(exerciseId: string, row: RecoveryExerciseRecord | undefined,
  productionIdentityFound: boolean, now = Date.now(), assessmentInventorySnapshotSha256: string | null = null,
  providedTrust?: RecoveryRunnerTrust) {
  const unavailable = (reason: string) => ({ schemaVersion: 3, verified: false,
    provenance: 'magnus_recovery_exercise_store' as const, exerciseId, reason });
  if (!row || row.id !== exerciseId) return unavailable('No Control API runtime exercise record exists for this exercise');
  let before: RecoveryEvidenceSnapshot; let after: RecoveryEvidenceSnapshot; let runtimeEvidence: RuntimeEvidence[];
  try {
    before = recoveryEvidenceSnapshotSchema.parse(JSON.parse(row.beforeEvidenceJson));
    after = recoveryEvidenceSnapshotSchema.parse(JSON.parse(row.afterEvidenceJson));
    runtimeEvidence = z.array(storedRuntimeEvidenceSchema).min(8).max(100).parse(JSON.parse(row.runtimeEvidenceJson));
  } catch { return unavailable('Stored exercise evidence is malformed'); }
  const beforeDigests = snapshotDigests(sortedSnapshot(before));
  const afterDigests = snapshotDigests(sortedSnapshot(after));
  const sortedEvidence = sortedRuntimeEvidence(runtimeEvidence);
  let runnerReceiptValid = false;
  let scenarioSemanticsValid = false;
  try {
    const trust = providedTrust ?? loadRecoveryRunnerTrust();
    const rawRuntimeEvidence = sortedEvidence.map(({ evidenceSha256: _evidenceSha256, ...entry }) => entry);
    const collectorInput = recoveryExerciseCollectorSchema.parse({
      exerciseId: row.id,
      targetId: row.targetId,
      scenario: row.scenario,
      startedAt: row.startedAt.toISOString(),
      recoveredAt: row.recoveredAt.toISOString(),
      recoveryPointAt: row.recoveryPointAt.toISOString(),
      objectives: { rtoSeconds: row.rtoObjectiveSeconds, rpoSeconds: row.rpoObjectiveSeconds },
      before,
      after,
      runtimeEvidence: rawRuntimeEvidence,
    });
    scenarioSemanticsValid = true;
    const receipt = recoveryRunnerReceiptSchema.parse(JSON.parse(row.runnerReceiptJson));
    const verifiedReceipt = verifyRecoveryRunnerReceipt(collectorInput, receipt, trust, row.createdAt);
    runnerReceiptValid = row.runnerIssuer === verifiedReceipt.issuer
      && row.runnerKeyId === verifiedReceipt.keyId
      && row.runnerPublicKeySha256 === trust.publicKeySha256
      && row.runnerNonce === verifiedReceipt.nonce
      && row.runnerIssuedAt.toISOString() === verifiedReceipt.issuedAt
      && row.runnerExpiresAt.toISOString() === verifiedReceipt.expiresAt
      && row.runnerExerciseContractSha256 === verifiedReceipt.exerciseContractSha256
      && row.runnerReceiptSha256 === recoveryEvidenceSha256(verifiedReceipt)
      && row.runnerReceiptJson === canonical(verifiedReceipt);
  } catch { runnerReceiptValid = false; }
  const evidenceIntegrityValid = beforeDigests.stateSha256 === row.beforeStateSha256
    && beforeDigests.taskSha256 === row.beforeTaskSha256
    && beforeDigests.artifactSha256 === row.beforeArtifactSha256
    && afterDigests.stateSha256 === row.afterStateSha256
    && afterDigests.taskSha256 === row.afterTaskSha256
    && afterDigests.artifactSha256 === row.afterArtifactSha256
    && sortedEvidence.every(({ evidenceSha256, ...entry }) => evidenceSha256 === runtimeEvidenceDigest(entry))
    && recoveryEvidenceSha256(sortedEvidence) === row.directEvidenceSha256
    && recoveryEvidenceSha256(recordPayload(row)) === row.recordSha256;
  const targetIsDisposable = disposableTarget.safeParse(row.targetId).success && !productionIdentityFound;
  const inventorySnapshotsBound = digest.safeParse(row.inventorySnapshotSha256).success
    && digest.safeParse(assessmentInventorySnapshotSha256).success;
  const started = row.startedAt.getTime(); const recovered = row.recoveredAt.getTime();
  const point = row.recoveryPointAt.getTime(); const created = row.createdAt.getTime();
  const chronologyValid = point <= started && started <= recovered && recovered <= created && created <= now + 30_000
    && sortedEvidence.every(entry => {
      const observed = Date.parse(entry.observedAt);
      return entry.phase === 'before'
        ? observed >= point && observed <= started
        : observed >= recovered && observed <= created && observed <= now + 30_000;
    });
  const expectedSubject = (entry: RuntimeEvidence): string => {
    if (entry.kind === 'target_identity') return recoveryEvidenceSha256({ targetId: row.targetId });
    if (entry.kind === 'recovery_probe') return recoveryEvidenceSha256({ targetId: row.targetId,
      scenario: row.scenario, recoveredAt: row.recoveredAt.toISOString() });
    const values = entry.phase === 'before' ? beforeDigests : afterDigests;
    return entry.kind === 'state_capture' ? values.stateSha256
      : entry.kind === 'task_ledger_capture' ? values.taskSha256
        : entry.kind === 'artifact_manifest_capture' ? values.artifactSha256
          : scenarioEvidenceSubject(row.targetId, row.scenario, beforeDigests, afterDigests);
  };
  const passedBindings = new Set(sortedEvidence.filter(entry => entry.status === 'pass'
    && entry.subjectSha256 === expectedSubject(entry)).map(entry => `${entry.kind}:${entry.phase}`));
  const scenarioBindings = row.scenario in scenarioRuntimeEvidence
    ? scenarioRuntimeEvidence[row.scenario as keyof typeof scenarioRuntimeEvidence] : [];
  const runtimeEvidenceComplete = [...requiredRuntimeEvidence, ...scenarioBindings]
    .every(([kind, phase]) => passedBindings.has(`${kind}:${phase}`))
    && sortedEvidence.every(entry => entry.status === 'pass' && entry.subjectSha256 === expectedSubject(entry));
  const hashesPreserved = row.beforeStateSha256 === row.afterStateSha256
    && row.beforeTaskSha256 === row.afterTaskSha256
    && row.beforeArtifactSha256 === row.afterArtifactSha256;
  const rtoSeconds = (recovered - started) / 1_000;
  const rpoSeconds = Math.max(0, (started - point) / 1_000);
  const objectivesMet = rtoSeconds <= row.rtoObjectiveSeconds && rpoSeconds <= row.rpoObjectiveSeconds;
  const verified = evidenceIntegrityValid && runnerReceiptValid && scenarioSemanticsValid && inventorySnapshotsBound
    && targetIsDisposable && chronologyValid && runtimeEvidenceComplete && hashesPreserved && objectivesMet;
  return {
    schemaVersion: 3,
    verified,
    provenance: 'magnus_recovery_exercise_store' as const,
    exerciseId: row.id,
    targetId: row.targetId,
    scenario: row.scenario,
    isolated: targetIsDisposable,
    productionIdentityFound,
    runnerReceiptValid,
    scenarioSemanticsValid,
    inventorySnapshotsBound,
    collectionInventorySnapshotSha256: row.inventorySnapshotSha256,
    assessmentInventorySnapshotSha256,
    evidenceIntegrityValid,
    runtimeEvidenceComplete,
    hashesPreserved,
    chronologyValid,
    objectivesMet,
    measured: { rtoSeconds, rpoSeconds },
    objectives: { rtoSeconds: row.rtoObjectiveSeconds, rpoSeconds: row.rpoObjectiveSeconds },
    ageMs: Math.max(0, now - created),
    directEvidenceSha256: row.directEvidenceSha256,
    recordSha256: row.recordSha256,
    reason: verified ? 'Direct disposable runtime evidence meets preservation and recovery objectives'
      : 'Exercise evidence failed isolation, integrity, chronology, preservation, runtime, or objective checks',
  };
}
