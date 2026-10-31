import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  cpSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import {
  loadRecoveryRunnerTrust,
  recordRecoveryExerciseFromDedicatedRunner,
  recoveryEvidenceSha256,
  recoveryExerciseCollectorSchema,
  recoveryExerciseContractSha256,
  recoveryRunnerReceiptSigningBytes,
  type RecoveryExerciseCollectorInput,
  type RecoveryRunnerReceipt,
  type RecoveryRunnerTrust,
} from './recovery-exercises.js';

const scenarioSchema = z.enum(['backup_restore', 'rollback', 'specialist_loss', 'coordinator_loss']);
export type DisposableRecoveryScenario = z.infer<typeof scenarioSchema>;

const fixtureNamePattern = /^magnus-disposable-[a-zA-Z0-9]{6}$/;
const fixtureOwnerFile = '.magnus-disposable-owner.json';
export const DISPOSABLE_RECOVERY_ORPHAN_AGE_MS = 60 * 60_000;

const fixtureOwnerSchema = z.object({
  schemaVersion: z.literal(1),
  fixtureName: z.string().regex(fixtureNamePattern),
  runnerPid: z.number().int().positive(),
  runnerBootId: z.string().guid(),
  runnerStartTimeTicks: z.string().regex(/^[0-9]+$/),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

interface LinuxProcessIdentity {
  bootId: string;
  startTimeTicks: string;
}

export interface DisposableRecoveryReapHooks {
  afterQuarantine?: (originalPath: string, quarantinePath: string) => void;
}

const privateKeyFileSchema = z.object({
  schemaVersion: z.literal(1),
  issuer: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/),
  keyId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/),
  privateKeyPem: z.string().min(64).max(8_192),
}).strict();

type Snapshot = RecoveryExerciseCollectorInput['before'];
type RuntimeEvidence = RecoveryExerciseCollectorInput['runtimeEvidence'][number];

export interface DisposableRecoveryRunnerOptions {
  root: string;
  privateKeyFile: string;
  publicKeyFile: string;
  now?: () => Date;
}

export interface DisposableRecoveryRun {
  input: RecoveryExerciseCollectorInput;
  receipt: RecoveryRunnerReceipt;
  trust: RecoveryRunnerTrust;
}

export type RecoveryExerciseSink = typeof recordRecoveryExerciseFromDedicatedRunner;

export interface DisposableRecoveryReapResult {
  reaped: string[];
  preservedYoung: string[];
  preservedActive: string[];
  preservedUnsafe: string[];
}

export function assertDedicatedRecoveryDatabaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error('DATABASE_URL is required for the dedicated recovery runner');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== 'magnus_recovery_runner')
    throw new Error('DATABASE_URL must use the dedicated magnus_recovery_runner PostgreSQL role');
  if (!parsed.password || !parsed.hostname || !parsed.pathname || parsed.pathname === '/')
    throw new Error('DATABASE_URL must include the dedicated role credential, host, and database');
  return raw;
}

interface ScenarioRow {
  kind: RuntimeEvidence['kind'];
  phase: RuntimeEvidence['phase'];
  observedAt: Date;
  observation: RuntimeEvidence['observation'];
}

interface ScenarioResult {
  startedAt: Date;
  recoveredAt: Date;
  rows: ScenarioRow[];
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') throw new Error('Recovery runner requires a POSIX user identity');
  return process.getuid();
}

function readStablePrivateKey(path: string): z.infer<typeof privateKeyFileSchema> & { privateKey: KeyObject } {
  let descriptor: number | undefined;
  let contents = '';
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 16_384n
      || (Number(before.mode) & 0o077) !== 0 || Number(before.uid) !== currentUid())
      throw new Error('Unsafe recovery runner private-key file');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = fstatSync(descriptor, { bigint: true });
    if (bytesRead !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || before.nlink !== after.nlink || after.nlink !== 1n || before.mode !== after.mode
      || before.uid !== after.uid || before.gid !== after.gid || (Number(after.mode) & 0o077) !== 0)
      throw new Error('Recovery runner private-key file changed while reading');
    contents = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const configured = privateKeyFileSchema.parse(JSON.parse(contents));
  const privateKey = createPrivateKey(configured.privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Recovery runner private key must be Ed25519');
  return { ...configured, privateKey };
}

function assertSafeRoot(path: string): string {
  const resolved = resolve(path);
  const state = lstatSync(resolved, { bigint: true });
  if (!state.isDirectory() || state.nlink < 1n || (Number(state.mode) & 0o022) !== 0
    || Number(state.uid) !== currentUid())
    throw new Error('Disposable recovery runner root must be an owner-controlled directory');
  return resolved;
}

function linuxBootId(): string {
  return z.string().guid().parse(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
}

function linuxProcessStartTimeTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
  const commandEnd = stat.lastIndexOf(') ');
  if (commandEnd < 0) throw new Error('Linux process stat is malformed');
  const fieldsAfterCommand = stat.slice(commandEnd + 2).split(' ');
  const startTimeTicks = fieldsAfterCommand[19];
  if (!startTimeTicks || !/^[0-9]+$/.test(startTimeTicks))
    throw new Error('Linux process start time is malformed');
  return startTimeTicks;
}

function linuxProcessIdentity(pid: number): LinuxProcessIdentity {
  return { bootId: linuxBootId(), startTimeTicks: linuxProcessStartTimeTicks(pid) };
}

function processIdentityState(owner: z.infer<typeof fixtureOwnerSchema>): 'alive' | 'dead' | 'unknown' {
  let bootId: string;
  try {
    bootId = linuxBootId();
  } catch {
    return 'unknown';
  }
  if (bootId !== owner.runnerBootId) return 'dead';
  try {
    return linuxProcessStartTimeTicks(owner.runnerPid) === owner.runnerStartTimeTicks ? 'alive' : 'dead';
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'dead' : 'unknown';
  }
}

function readFixtureOwner(path: string) {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 4_096n
      || (Number(before.mode) & 0o077) !== 0 || Number(before.uid) !== currentUid())
      throw new Error('Unsafe disposable fixture owner marker');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = fstatSync(descriptor, { bigint: true });
    if (bytesRead !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || before.nlink !== after.nlink || after.nlink !== 1n || before.mode !== after.mode
      || before.uid !== after.uid || before.gid !== after.gid || (Number(after.mode) & 0o077) !== 0)
      throw new Error('Disposable fixture owner marker changed while reading');
    return fixtureOwnerSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeFixtureOwner(fixtureRoot: string): void {
  const fixtureName = basename(fixtureRoot);
  const processIdentity = linuxProcessIdentity(process.pid);
  const finalPath = join(fixtureRoot, fixtureOwnerFile);
  const temporaryPath = join(fixtureRoot, `${fixtureOwnerFile}.${randomUUID()}.tmp`);
  let fileDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let renamed = false;
  try {
    fileDescriptor = openSync(temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(fileDescriptor, JSON.stringify({
      schemaVersion: 1,
      fixtureName,
      runnerPid: process.pid,
      runnerBootId: processIdentity.bootId,
      runnerStartTimeTicks: processIdentity.startTimeTicks,
      createdAt: new Date().toISOString(),
    }) + '\n');
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporaryPath, finalPath);
    renamed = true;
    directoryDescriptor = openSync(fixtureRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    fsyncSync(directoryDescriptor);
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    if (!renamed) rmSync(temporaryPath, { force: true });
  }
}

/**
 * Remove only expired directories in the runner-reserved namespace. The missing-marker
 * case covers termination in the small interval between mkdtemp and marker creation.
 */
export function reapOrphanedDisposableRecoveryFixtures(rootPath: string,
  nowMs = Date.now(), hooks: DisposableRecoveryReapHooks = {}): DisposableRecoveryReapResult {
  if (!isAbsolute(rootPath)) throw new Error('Recovery runner root must be absolute');
  const root = assertSafeRoot(rootPath);
  const result: DisposableRecoveryReapResult = {
    reaped: [], preservedYoung: [], preservedActive: [], preservedUnsafe: [],
  };
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (!fixtureNamePattern.test(entry.name)) continue;
    const fixtureRoot = join(root, entry.name);
    let initial;
    try {
      initial = lstatSync(fixtureRoot, { bigint: true });
      if (!initial.isDirectory() || Number(initial.uid) !== currentUid() || (Number(initial.mode) & 0o077) !== 0) {
        result.preservedUnsafe.push(entry.name);
        continue;
      }
      let createdAtMs = Number(initial.mtimeMs);
      try {
        const owner = readFixtureOwner(join(fixtureRoot, fixtureOwnerFile));
        if (owner.fixtureName !== entry.name) throw new Error('Disposable fixture owner marker does not match its directory');
        createdAtMs = Date.parse(owner.createdAt);
        const identityState = processIdentityState(owner);
        if (identityState !== 'dead') {
          if (identityState === 'unknown') result.preservedUnsafe.push(entry.name);
          else result.preservedActive.push(entry.name);
          continue;
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          result.preservedUnsafe.push(entry.name);
          continue;
        }
      }
      if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs
        || nowMs - createdAtMs < DISPOSABLE_RECOVERY_ORPHAN_AGE_MS) {
        result.preservedYoung.push(entry.name);
        continue;
      }
      const final = lstatSync(fixtureRoot, { bigint: true });
      if (!final.isDirectory() || final.dev !== initial.dev || final.ino !== initial.ino
        || final.uid !== initial.uid || final.mode !== initial.mode) {
        result.preservedUnsafe.push(entry.name);
        continue;
      }
      const quarantinePath = join(root, `${entry.name}.reap-${randomUUID()}`);
      try {
        renameSync(fixtureRoot, quarantinePath);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        result.preservedUnsafe.push(entry.name);
        continue;
      }
      hooks.afterQuarantine?.(fixtureRoot, quarantinePath);
      try {
        const quarantined = lstatSync(quarantinePath, { bigint: true });
        if (!quarantined.isDirectory() || quarantined.dev !== initial.dev || quarantined.ino !== initial.ino
          || quarantined.uid !== initial.uid || quarantined.mode !== initial.mode) {
          result.preservedUnsafe.push(entry.name);
          continue;
        }
        rmSync(quarantinePath, { recursive: true, force: true });
        result.reaped.push(entry.name);
      } catch {
        result.preservedUnsafe.push(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return result;
}

function walkFiles(root: string, relative = ''): Array<{ path: string; sha256: string }> {
  const directory = join(root, relative);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const output: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
      throw new Error('Disposable fixture contains an unsupported filesystem entry');
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...walkFiles(root, child));
    else output.push({ path: child, sha256: sha256(readFileSync(join(root, child))) });
  }
  return output;
}

function captureSnapshot(dataRoot: string): Snapshot {
  const state = walkFiles(join(dataRoot, 'state')).map(entry => ({ key: entry.path, valueSha256: entry.sha256 }));
  const tasks = z.array(z.object({ taskId: z.string(), status: z.enum(['completed', 'cancelled', 'failed']),
    receiptSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).parse(
      JSON.parse(readFileSync(join(dataRoot, 'task-receipts.json'), 'utf8')))
    .sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  const artifacts = walkFiles(join(dataRoot, 'artifacts')).map(entry => ({ artifactId: entry.path, sha256: entry.sha256 }));
  return { state, taskReceipts: tasks, artifacts };
}

function snapshotDigests(snapshot: Snapshot) {
  return {
    stateSha256: recoveryEvidenceSha256(snapshot.state),
    taskSha256: recoveryEvidenceSha256(snapshot.taskReceipts),
    artifactSha256: recoveryEvidenceSha256(snapshot.artifacts),
  };
}

function evidence(kind: RuntimeEvidence['kind'], phase: RuntimeEvidence['phase'], observedAt: Date,
  source: string, subjectSha256: string, observation: RuntimeEvidence['observation']): RuntimeEvidence {
  return { kind, phase, status: 'pass', observedAt: observedAt.toISOString(), source, subjectSha256, observation };
}

function seedFixture(dataRoot: string): void {
  mkdirSync(join(dataRoot, 'state'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dataRoot, 'artifacts'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataRoot, 'state', 'coordinator.json'), JSON.stringify({ leader: 'coordinator', epoch: 7 }) + '\n', { mode: 0o600 });
  writeFileSync(join(dataRoot, 'state', 'specialists.json'), JSON.stringify({ ready: ['canary', 'magnus', 'edge', 'guard'] }) + '\n', { mode: 0o600 });
  writeFileSync(join(dataRoot, 'artifacts', 'manifest.json'), JSON.stringify({ revision: 3, artifact: sha256('fixture-artifact') }) + '\n', { mode: 0o600 });
  writeFileSync(join(dataRoot, 'task-receipts.json'), JSON.stringify([
    { taskId: 'fixture-task', status: 'completed', receiptSha256: sha256('fixture-task-receipt') },
  ]) + '\n', { mode: 0o600 });
}

function observeProcessLoss(kind: 'specialist' | 'coordinator', role: string, payload: string) {
  const program = `
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const kind = process.argv[1]; const role = process.argv[2]; const payload = process.argv[3];
const workerProgram = \`
const {createHash}=require('node:crypto'); const net=require('node:net');
const kind=process.argv[1]; const role=process.argv[2]; const payload=process.argv[3];
const workSha256=createHash('sha256').update(payload).digest('hex');
if(kind==='coordinator'){
  const server=net.createServer();
  server.listen({host:'127.0.0.1',port:0,exclusive:true},()=>process.send({type:'accepted',role,pid:process.pid,workSha256,port:server.address().port,epoch:1}));
}else{process.send({type:'accepted',role,pid:process.pid,workSha256,port:0,epoch:0});setInterval(()=>{},1000)}
\`;
const child=spawn(process.execPath,['-e',workerProgram,kind,role,payload],{stdio:['ignore','ignore','ignore','ipc']});
const timeout=setTimeout(()=>{child.kill('SIGKILL');process.exit(2)},1500);
child.once('message',accepted=>{
  if(!accepted||accepted.type!=='accepted'||accepted.role!==role||accepted.pid!==child.pid)process.exit(3);
  child.once('exit',(code,signal)=>{
    clearTimeout(timeout);
    if(code!==null||signal!=='SIGKILL')process.exit(4);
    process.stdout.write(JSON.stringify({kind,role,pid:accepted.pid,workSha256:accepted.workSha256,
      port:accepted.port,epoch:accepted.epoch,lossSignal:signal}));
  });
  child.kill('SIGKILL');
});
`;
  const result = spawnSync(process.execPath, ['-e', program, kind, role, payload], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 4_096, windowsHide: true,
  });
  if (result.status !== 0 || result.signal || !result.stdout)
    throw new Error(`Disposable ${kind} original process loss was not observed`);
  const observed = z.object({
    kind: z.literal(kind), role: z.literal(role), pid: z.number().int().positive(),
    workSha256: z.string().regex(/^[a-f0-9]{64}$/), epoch: z.number().int().nonnegative(),
    port: z.number().int().nonnegative().max(65_535), lossSignal: z.literal('SIGKILL'),
  }).strict().parse(JSON.parse(result.stdout));
  if (observed.workSha256 !== sha256(payload)) throw new Error('Lost worker did not accept the bound work');
  if (kind === 'coordinator' && (observed.port < 1 || observed.epoch !== 1))
    throw new Error('Lost coordinator did not hold the initial leadership endpoint');
  if (kind === 'specialist' && (observed.port !== 0 || observed.epoch !== 0))
    throw new Error('Lost specialist returned coordinator state');
  return observed;
}

function runSuccessor(kind: 'specialist' | 'coordinator', role: string, payload: string,
  original: ReturnType<typeof observeProcessLoss>) {
  const program = `
const {createHash}=require('node:crypto'); const {spawnSync}=require('node:child_process'); const net=require('node:net');
const kind=process.argv[1]; const role=process.argv[2]; const payload=process.argv[3]; const port=Number(process.argv[4]); const epoch=Number(process.argv[5]);
const workSha256=createHash('sha256').update(payload).digest('hex');
if(kind==='specialist'){
  process.stdout.write(JSON.stringify({kind,role,pid:process.pid,workSha256,port:0,epoch:0,contenderRejected:false}));
}else{
  const server=net.createServer();
  server.once('error',()=>process.exit(2));
  server.listen({host:'127.0.0.1',port,exclusive:true},()=>{
    const contenderProgram="const net=require('node:net');const s=net.createServer();s.once('error',e=>process.exit(e&&e.code==='EADDRINUSE'?73:74));s.listen({host:'127.0.0.1',port:Number(process.argv[1]),exclusive:true},()=>process.exit(0))";
    const contender=spawnSync(process.execPath,['-e',contenderProgram,String(port)],{timeout:1000,stdio:'ignore'});
    const contenderRejected=contender.status===73;
    if(!contenderRejected)process.exit(3);
    process.stdout.write(JSON.stringify({kind,role,pid:process.pid,workSha256,port,epoch,contenderRejected}));
    server.close(()=>process.exit(0));
  });
}
`;
  const successorEpoch = kind === 'coordinator' ? original.epoch + 1 : 0;
  const result = spawnSync(process.execPath,
    ['-e', program, kind, role, payload, String(original.port), String(successorEpoch)],
    { encoding: 'utf8', timeout: 5_000, maxBuffer: 4_096, windowsHide: true });
  if (result.status !== 0 || result.signal || !result.stdout)
    throw new Error(`Disposable ${kind} successor did not complete bound work`);
  const observed = z.object({
    kind: z.literal(kind), role: z.literal(role), pid: z.number().int().positive(),
    workSha256: z.string().regex(/^[a-f0-9]{64}$/), epoch: z.number().int().nonnegative(),
    port: z.number().int().nonnegative().max(65_535), contenderRejected: z.boolean(),
  }).strict().parse(JSON.parse(result.stdout));
  if (observed.pid === original.pid || observed.workSha256 !== original.workSha256
    || observed.workSha256 !== sha256(payload))
    throw new Error('Disposable successor was not distinct and bound to the original work');
  if (kind === 'coordinator' && (observed.port !== original.port
    || observed.epoch !== original.epoch + 1 || !observed.contenderRejected))
    throw new Error('Disposable coordinator successor did not prove fenced leadership');
  if (kind === 'specialist' && (observed.port !== 0 || observed.epoch !== 0 || observed.contenderRejected))
    throw new Error('Disposable specialist successor returned coordinator state');
  return observed;
}

function performScenario(scenario: DisposableRecoveryScenario, root: string, now: () => Date): ScenarioResult {
  const dataRoot = join(root, 'data');
  const scratch = join(root, 'scenario');
  mkdirSync(scratch, { mode: 0o700 });
  if (scenario === 'backup_restore') {
    const backup = join(scratch, 'backup');
    cpSync(dataRoot, backup, { recursive: true, errorOnExist: true, force: false });
    const backupSha256 = recoveryEvidenceSha256(walkFiles(backup));
    const beforeObservedAt = now();
    const startedAt = now();
    rmSync(dataRoot, { recursive: true });
    cpSync(backup, dataRoot, { recursive: true, errorOnExist: true, force: false });
    const restoredSha256 = recoveryEvidenceSha256(walkFiles(dataRoot));
    if (backupSha256 !== restoredSha256) throw new Error('Disposable backup restore changed fixture bytes');
    const recoveredAt = now();
    const recoveryObservedAt = now();
    return { startedAt, recoveredAt, rows: [
      { kind: 'backup_snapshot', phase: 'before', observedAt: beforeObservedAt,
        observation: { backupId: basename(backup), backupSha256 } },
      { kind: 'restore_validation', phase: 'recovery', observedAt: recoveryObservedAt, observation: {
        backupId: basename(backup), restoredBackupSha256: restoredSha256, restoreReady: true,
      } },
    ] };
  }
  if (scenario === 'rollback') {
    const fromRevision = sha256('disposable-release-from').slice(0, 40);
    const toRevision = sha256('disposable-release-to').slice(0, 40);
    const candidate = join(scratch, 'release.candidate');
    const active = join(scratch, 'release.active');
    writeFileSync(active, `${fromRevision}\n`, { mode: 0o600 });
    if (readFileSync(active, 'utf8').trim() !== fromRevision)
      throw new Error('Disposable rollback baseline did not become active');
    writeFileSync(candidate, `${toRevision}\n`, { mode: 0o600 });
    const beforeObservedAt = now();
    const startedAt = now();
    renameSync(candidate, active);
    const activeRevision = readFileSync(active, 'utf8').trim();
    if (activeRevision !== toRevision) throw new Error('Disposable rollback target did not become active');
    const recoveredAt = now();
    const recoveryObservedAt = now();
    return { startedAt, recoveredAt, rows: [
      { kind: 'release_baseline', phase: 'before', observedAt: beforeObservedAt,
        observation: { fromRevision, toRevision } },
      { kind: 'rollback_validation', phase: 'recovery', observedAt: recoveryObservedAt, observation: {
        fromRevision, toRevision, activeRevision, rollbackReady: true,
      } },
    ] };
  }
  if (scenario === 'specialist_loss') {
    const specialistId = 'specialist-fixture';
    const successorId = 'magnus-fixture';
    const payload = 'specialist:delegated-task:bounded-work-v1';
    const original = observeProcessLoss('specialist', specialistId, payload);
    const beforeObservedAt = now();
    const startedAt = now();
    const successor = runSuccessor('specialist', successorId, payload, original);
    const recoveredAt = now();
    const recoveryObservedAt = now();
    const path = join(scratch, 'specialist-loss.json');
    writeFileSync(path, JSON.stringify({ specialistId, successorId, original, successor }), { mode: 0o600 });
    const observed = z.object({ specialistId: z.literal(specialistId), successorId: z.literal(successorId),
      original: z.object({ pid: z.number().int().positive(), role: z.literal(specialistId), workSha256: z.string() }).passthrough(),
      successor: z.object({ pid: z.number().int().positive(), role: z.literal(successorId), workSha256: z.string() }).passthrough(),
    }).strict().parse(JSON.parse(readFileSync(path, 'utf8')));
    return { startedAt, recoveredAt, rows: [
      { kind: 'specialist_identity', phase: 'before', observedAt: beforeObservedAt,
        observation: { specialistId: observed.specialistId, originalPid: original.pid,
          workSha256: original.workSha256, lossSignal: original.lossSignal, lossConfirmed: true } },
      { kind: 'delegation_recovery', phase: 'recovery', observedAt: recoveryObservedAt, observation: {
        specialistId: observed.specialistId, successorId: observed.successorId,
        originalPid: original.pid, successorPid: successor.pid, workSha256: successor.workSha256,
        originalIsolated: true, successorReady: true,
      } },
    ] };
  }
  const coordinatorId = 'coordinator-fixture';
  const successorId = 'magnus-fixture';
  const payload = 'coordinator:mission-plan:bounded-work-v1';
  const original = observeProcessLoss('coordinator', coordinatorId, payload);
  const beforeObservedAt = now();
  const startedAt = now();
  const successor = runSuccessor('coordinator', successorId, payload, original);
  const recoveredAt = now();
  const recoveryObservedAt = now();
  const path = join(scratch, 'coordinator-loss.json');
  writeFileSync(path, JSON.stringify({ coordinatorId, successorId, original, successor }), { mode: 0o600 });
  const observed = z.object({ coordinatorId: z.literal(coordinatorId), successorId: z.literal(successorId),
    original: z.object({ pid: z.number().int().positive(), role: z.literal(coordinatorId), epoch: z.number().int().positive(),
      port: z.number().int().positive(), workSha256: z.string(), lossSignal: z.literal('SIGKILL') }).passthrough(),
    successor: z.object({ pid: z.number().int().positive(), role: z.literal(successorId), epoch: z.number().int().positive(),
      contenderRejected: z.literal(true) }).passthrough() })
    .strict().parse(JSON.parse(readFileSync(path, 'utf8')));
  return { startedAt, recoveredAt, rows: [
    { kind: 'coordinator_identity', phase: 'before', observedAt: beforeObservedAt, observation: {
      coordinatorId: observed.coordinatorId, originalPid: original.pid, leadershipPort: original.port,
      workSha256: original.workSha256, originalEpoch: original.epoch,
      lossSignal: original.lossSignal, lossConfirmed: true,
    } },
    { kind: 'leadership_recovery', phase: 'recovery', observedAt: recoveryObservedAt, observation: {
      coordinatorId: observed.coordinatorId, successorId: observed.successorId,
      originalPid: original.pid, successorPid: successor.pid, leadershipPort: successor.port,
      workSha256: successor.workSha256, originalEpoch: original.epoch, successorEpoch: successor.epoch,
      contenderRejected: successor.contenderRejected,
      originalIsolated: true, successorReady: true, splitBrainDetected: false,
    } },
  ] };
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return recoveryEvidenceSha256(left) === recoveryEvidenceSha256(right);
}

function prepareDisposableRecoveryRun(rawScenario: string, options: DisposableRecoveryRunnerOptions): DisposableRecoveryRun & { cleanup: () => void } {
  const scenario = scenarioSchema.parse(rawScenario);
  if (!isAbsolute(options.root) || !isAbsolute(options.privateKeyFile) || !isAbsolute(options.publicKeyFile))
    throw new Error('Recovery runner root and key paths must be absolute');
  const root = assertSafeRoot(options.root);
  const privateIdentity = readStablePrivateKey(options.privateKeyFile);
  const trust = loadRecoveryRunnerTrust(options.publicKeyFile);
  const derivedPublicKey = createPublicKey(privateIdentity.privateKey);
  const derivedPublicKeySha256 = sha256(derivedPublicKey.export({ type: 'spki', format: 'der' }));
  if (privateIdentity.issuer !== trust.issuer || privateIdentity.keyId !== trust.keyId
    || derivedPublicKeySha256 !== trust.publicKeySha256)
    throw new Error('Recovery runner private identity does not match the configured public trust pin');

  const now = options.now ?? (() => new Date());
  reapOrphanedDisposableRecoveryFixtures(root);
  const exerciseId = `${scenario}-${randomUUID()}`;
  const fixtureRoot = mkdtempSync(join(root, 'magnus-disposable-'));
  const targetId = `disposable:${basename(fixtureRoot)}`;
  try {
    writeFixtureOwner(fixtureRoot);
    const dataRoot = join(fixtureRoot, 'data');
    seedFixture(dataRoot);
    const recoveryPointAt = now();
    const before = captureSnapshot(dataRoot);
    const beforeObservedAt = now();
    const scenarioResult = performScenario(scenario, fixtureRoot, now);
    const after = captureSnapshot(dataRoot);
    const afterObservedAt = now();
    if (!sameSnapshot(before, after)) throw new Error('Disposable exercise did not preserve fixture state');

    const beforeDigests = snapshotDigests(before);
    const afterDigests = snapshotDigests(after);
    const scenarioSubject = recoveryEvidenceSha256({ targetId, scenario, before: beforeDigests, after: afterDigests });
    const runtimeEvidence: RuntimeEvidence[] = [
      evidence('target_identity', 'before', beforeObservedAt, 'control-api:disposable-runner/target',
        recoveryEvidenceSha256({ targetId }), { targetId, namespace: 'disposable' }),
      evidence('state_capture', 'before', beforeObservedAt, 'control-api:disposable-runner/state',
        beforeDigests.stateSha256, { entryCount: before.state.length, aggregateSha256: beforeDigests.stateSha256 }),
      evidence('task_ledger_capture', 'before', beforeObservedAt, 'control-api:disposable-runner/tasks',
        beforeDigests.taskSha256, { entryCount: before.taskReceipts.length, aggregateSha256: beforeDigests.taskSha256 }),
      evidence('artifact_manifest_capture', 'before', beforeObservedAt, 'control-api:disposable-runner/artifacts',
        beforeDigests.artifactSha256, { entryCount: before.artifacts.length, aggregateSha256: beforeDigests.artifactSha256 }),
      evidence('state_capture', 'after', afterObservedAt, 'control-api:disposable-runner/state',
        afterDigests.stateSha256, { entryCount: after.state.length, aggregateSha256: afterDigests.stateSha256 }),
      evidence('task_ledger_capture', 'after', afterObservedAt, 'control-api:disposable-runner/tasks',
        afterDigests.taskSha256, { entryCount: after.taskReceipts.length, aggregateSha256: afterDigests.taskSha256 }),
      evidence('artifact_manifest_capture', 'after', afterObservedAt, 'control-api:disposable-runner/artifacts',
        afterDigests.artifactSha256, { entryCount: after.artifacts.length, aggregateSha256: afterDigests.artifactSha256 }),
      evidence('recovery_probe', 'recovery', afterObservedAt, 'control-api:disposable-runner/health',
        recoveryEvidenceSha256({ targetId, scenario, recoveredAt: scenarioResult.recoveredAt.toISOString() }),
        { targetId, scenario, ready: true, checkId: `probe-${scenario}` }),
      ...scenarioResult.rows.map((row, index) => evidence(
        row.kind, row.phase, row.observedAt,
        `control-api:disposable-runner/scenario-${index}`, scenarioSubject,
        row.observation,
      )),
    ];
    const input = recoveryExerciseCollectorSchema.parse({
      exerciseId,
      targetId,
      scenario,
      startedAt: scenarioResult.startedAt.toISOString(),
      recoveredAt: scenarioResult.recoveredAt.toISOString(),
      recoveryPointAt: recoveryPointAt.toISOString(),
      objectives: { rtoSeconds: 300, rpoSeconds: 60 },
      before,
      after,
      runtimeEvidence,
    });
    const issuedAt = now();
    const unsigned = {
      schemaVersion: 1 as const,
      issuer: trust.issuer,
      keyId: trust.keyId,
      nonce: `nonce-${randomBytes(24).toString('hex')}`,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 10 * 60_000).toISOString(),
      exerciseContractSha256: recoveryExerciseContractSha256(input),
    };
    const receipt = {
      ...unsigned,
      signature: sign(null, recoveryRunnerReceiptSigningBytes(unsigned), privateIdentity.privateKey).toString('base64'),
    };
    return { input, receipt, trust, cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Build a fully observed contract for validation without retaining its temporary fixture. */
export function buildDisposableRecoveryRun(rawScenario: string, options: DisposableRecoveryRunnerOptions): DisposableRecoveryRun {
  const { cleanup, ...run } = prepareDisposableRecoveryRun(rawScenario, options);
  cleanup();
  return run;
}

export async function runDisposableRecoveryExercise(rawScenario: string, options: DisposableRecoveryRunnerOptions,
  sink: RecoveryExerciseSink = recordRecoveryExerciseFromDedicatedRunner) {
  const run = prepareDisposableRecoveryRun(rawScenario, options);
  try {
    return await sink(run.input, run.receipt, options.now?.() ?? new Date(), run.trust);
  } finally {
    run.cleanup();
  }
}
