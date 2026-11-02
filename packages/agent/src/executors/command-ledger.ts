import type { ManagedClaim } from '../security/managed-http.js';
/** Node-local admission and receipts. A crash never silently releases uncertainty. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { HOST_FQDN, NODE_MANAGER_SECRET, RESULT_SIGNING_SECRET } from '../env.js';
import { verifyCommandResult, verifyCommandReconciliation, type CommandReconciliationAssertion } from '../security/command-result-signature.js';
import { MANAGED_HTTP_COMMAND } from '../security/managed-http.js';

export const commandFenceSchema = z.object({
  version: z.literal(1),
  resourceKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/),
  fence: z.string().regex(/^[1-9][0-9]{0,18}$/),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
}).strict();
export type CommandFence = z.infer<typeof commandFenceSchema>;
export interface CommandIdentity {
  commandId: string; command: string; args: string[]; workingDirectory?: string;
  environment?: Record<string, string>; timeoutSeconds: number; coordination?: CommandFence;
}
export function isArdentScopedCommand(input: CommandIdentity, nodeId: string): boolean {
  return input.command === MANAGED_HTTP_COMMAND && input.args.length === 3
    && input.args[0] === 'POST' && input.args[1] === '/ardent/action'
    && /^[a-f0-9]{64}$/.test(input.args[2]!) && input.timeoutSeconds <= 900
    && !input.workingDirectory && Object.keys(input.environment ?? {}).length === 0
    && input.coordination?.resourceKey === `node:${nodeId}:ardent`;
}
export interface CommandReceiptResult {
  commandId: string; exitCode: number; stdout: string; stderr: string; durationMs: number;
  truncated: boolean; signature: string;
  coordination?: CommandFence & { requestSha256: string };
  completion?: { registryVersion:1; registrySha256:string; descriptorId:string };
}
const resultSchema = z.object({
  commandId: z.string(), exitCode: z.number().int(), stdout: z.string(), stderr: z.string(),
  durationMs: z.number().int().nonnegative(), truncated: z.boolean(), signature: z.string().regex(/^[a-f0-9]{64}$/),
  coordination: commandFenceSchema.extend({ requestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  completion: z.object({ registryVersion: z.literal(1), registrySha256: z.string().regex(/^[a-f0-9]{64}$/),
    descriptorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/) }).strict().optional(),
}).strict();
export const commandReconciliationSchema = z.object({
  nodeFqdn: z.string().min(1).max(253),
  commandId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  coordination: commandFenceSchema.optional(),
  disposition: z.enum(['effects_verified', 'no_effect_verified']),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvalRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/),
  decisionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const lockSchema = z.object({ commandId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  nonce: z.string().guid(), pid: z.number().int().positive() }).strict();
const receiptSchema = z.object({
  version: z.literal(1), commandId: z.string(), requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['running', 'completed', 'reconciled']), acceptedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(), coordination: commandFenceSchema.optional(),
  result: resultSchema.optional(), reconciliation: commandReconciliationSchema.optional(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
export type CommandAdmissionCode = 'RESOURCE_BUSY' | 'OUTCOME_UNKNOWN' | 'IDEMPOTENCY_CONFLICT' | 'STALE_FENCE' | 'LEASE_EXPIRED'
  | 'LEDGER_UNAVAILABLE' | 'INVALID_RECONCILIATION' | 'UNMANAGED_MUTATION' | 'RESOURCE_CLAIM_INVALID';
export class CommandAdmissionError extends Error {
  /** The callback demonstrably never ran and this command id has no receipt: a certain refusal. */
  notStarted: boolean;
  /** STALE_FENCE: the fence this ledger already accepted for the key, so the server can move past it. */
  readonly highWater?: { resourceKey: string; fence: string };
  constructor(readonly code: CommandAdmissionCode, message: string,
    details: { notStarted?: boolean; highWater?: { resourceKey: string; fence: string } } = {}) {
    super(message);
    this.notStarted = details.notStarted ?? false;
    if (details.highWater) this.highWater = details.highWater;
  }
}
const enrollmentMarkerSchema = z.object({ version: z.literal(1), nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253) }).strict();
export type EnrollmentMarker = { state: 'absent' | 'present' | 'unknown'; marker: z.infer<typeof enrollmentMarkerSchema> | null; error?: string };
export interface CommandTrace { ledgerExists: boolean; receipt: boolean; activeLock: boolean; fenceHighWater: string | null; marker: EnrollmentMarker }
/** Read-only view of the ledger for preflight checks and heartbeats. */
export interface LedgerHealth {
  readable: boolean;
  activeLock: { commandId: string; receipt: string } | null;
  nonTerminalReceipts: number;
  unresolvedReceipts: number;
  truncated: boolean;
  fenceHighWater: Record<string, string>;
  error: string | null;
}
/** Bounds one scan: receipts are never pruned, and a heartbeat must stay cheap. */
const HEALTH_SCAN_LIMIT = 5000;
const HEALTH_FENCE_LIMIT = 64;
/** `state` precedes the potentially large result in every receipt this ledger writes. */
const RECEIPT_STATE = /"state":"([a-z]+)"/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function commandRequestDigest(input: CommandIdentity): string {
  return hash(JSON.stringify({ commandId: input.commandId, command: input.command, args: input.args,
    workingDirectory: input.workingDirectory ?? null,
    environment: Object.fromEntries(Object.entries(input.environment ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    timeoutSeconds: input.timeoutSeconds, coordination: input.coordination ? {
      version: 1, resourceKey: input.coordination.resourceKey, fence: input.coordination.fence, expiresAt: input.coordination.expiresAt,
    } : null }));
}

export class CommandLedger {
  private readonly active = new Set<string>();
  constructor(readonly root = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/command-receipts'),
    private readonly authority = { resultSecret: RESULT_SIGNING_SECRET,
      reconciliationSecret: process.env['COMMAND_RECONCILIATION_SECRET'] ?? '', nodeFqdn: HOST_FQDN }) {}

  /** Linux flock locks the open file description, retained by this parent FD after
   * the helper exits. Kernel cleanup after a crash releases only this mutex: the
   * durable claim still prevents an uncertain command from being repeated. */
  private async acquire() {
    await this.initialize();
    if (process.platform !== 'linux') throw new Error('Command ledger requires Linux advisory locking');
    const handle = await open(join(this.root, 'execution.flock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.nlink !== 1) throw new Error('Invalid command mutex');
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'],
          { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
        child.once('error', reject); child.once('exit', resolve);
      });
      if (code === 1) throw new CommandAdmissionError('RESOURCE_BUSY', 'A node command or reconciliation owns the execution slot');
      if (code !== 0) throw new Error('Command mutex unavailable');
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  private async releaseClaim() {
    await unlink(join(this.root, 'active.lock')); await this.syncDirectory();
  }
  /** Called only while holding the kernel mutex. An existing running receipt is
   * never dismissed using process status, elapsed time, or an expired lease. */
  private async recoverClaim() {
    const raw = await this.read<unknown>('active.lock');
    if (raw === undefined) return;
    const claim = lockSchema.parse(raw);
    const receipt = await this.receipt(claim.commandId);
    if (receipt && receipt.state !== 'completed' && receipt.state !== 'reconciled') {
      throw new CommandAdmissionError('RESOURCE_BUSY', 'An earlier node command has an unresolved outcome');
    }
    // No receipt means execution was never admitted: callback starts only after
    // its running receipt is durably synced. Completed receipts are HMAC checked.
    await this.releaseClaim();
  }
  private async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Private ledger directory required');
  }
  private async syncDirectory() {
    const dir = await open(this.root, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
  }
  private async read<T>(name: string): Promise<T | undefined> {
    let file;
    try { file = await open(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || stat.mode & 0o077 || stat.nlink !== 1) throw new Error('Invalid private ledger record');
      return JSON.parse(await file.readFile('utf8')) as T;
    } finally { await file.close(); }
  }
  private async write(name: string, value: unknown) {
    const temporary = join(this.root, '.write-'+randomUUID());
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(this.root, name)); await this.syncDirectory();
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  private receiptName(id: string) { return 'receipt-'+hash(id)+'.json'; }
  async receipt(id: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error('Invalid command identifier');
    await this.initialize();
    const raw = await this.read<unknown>(this.receiptName(id));
    if (raw === undefined) return null;
    const row = receiptSchema.parse(raw);
    if (row.commandId !== id || (row.state === 'completed' && (!row.result || row.finishedAt === undefined))
      || (row.state === 'running' && (row.result || row.finishedAt !== undefined || row.reconciliation))
      || (row.state === 'completed' && row.reconciliation)
      || (row.state === 'reconciled' && (!row.reconciliation || row.result || row.finishedAt === undefined))) throw new Error('Invalid receipt');
    if (row.reconciliation) this.checkReconciliation(row, row.reconciliation, false);
    if (row.result) this.checkResult(row.result, id, row.requestSha256, row.coordination);
    return { ...row, state: row.state !== 'running' ? row.state : this.active.has(id) ? 'running' : 'unknown' };
  }
  private checkResult(result: CommandReceiptResult, id: string, digest: string, fence?: CommandFence) {
    resultSchema.parse(result);
    if (!verifyCommandResult(result, this.authority.resultSecret)) throw new Error('Invalid result signature');
    if (result.commandId !== id || (fence ? !result.coordination
      || result.coordination.requestSha256 !== digest
      || result.coordination.resourceKey !== fence.resourceKey || result.coordination.fence !== fence.fence
      || result.coordination.expiresAt !== fence.expiresAt : result.coordination !== undefined)) throw new Error('Result binding differs');
  }
  private checkReconciliation(row: { commandId: string; requestSha256: string; coordination?: CommandFence }, assertion: CommandReconciliationAssertion, fresh: boolean) {
    commandReconciliationSchema.parse(assertion);
    const expected = row.coordination;
    const actual = assertion.coordination;
    if (!verifyCommandReconciliation(assertion, this.authority.reconciliationSecret)
      || this.authority.reconciliationSecret === this.authority.resultSecret
      || this.authority.reconciliationSecret === NODE_MANAGER_SECRET
      || assertion.nodeFqdn !== this.authority.nodeFqdn || assertion.commandId !== row.commandId
      || assertion.requestSha256 !== row.requestSha256
      || (expected ? !actual || expected.version !== actual.version || expected.resourceKey !== actual.resourceKey
        || expected.fence !== actual.fence || expected.expiresAt !== actual.expiresAt : actual !== undefined)
      || (fresh && (assertion.expiresAt <= Date.now() || assertion.expiresAt > Date.now() + 300_000))) {
      throw new CommandAdmissionError('INVALID_RECONCILIATION', 'Reconciliation authority, target, scope, or validity does not match the claim');
    }
  }

  /** Records a service/operator attestation of verified effects; it does not run
   * remediation, independently prove the evidence, or authorize replay. */
  async reconcile(input: CommandReconciliationAssertion) {
    let mutex;
    try {
      const assertion = commandReconciliationSchema.parse(input);
      mutex = await this.acquire();
      const row = await this.receipt(assertion.commandId);
      if (!row) throw new CommandAdmissionError('INVALID_RECONCILIATION', 'No accepted command matches this reconciliation');
      this.checkReconciliation(row, assertion, row.state !== 'reconciled');
      if (row.state === 'completed') throw new CommandAdmissionError('INVALID_RECONCILIATION', 'Command already has a completed result');
      if (row.state === 'reconciled') {
        if (row.reconciliation?.signature !== assertion.signature) throw new CommandAdmissionError('INVALID_RECONCILIATION', 'Command already has another reconciliation decision');
      } else {
        const lock = lockSchema.parse(await this.read<unknown>('active.lock'));
        if (lock.commandId !== assertion.commandId) throw new CommandAdmissionError('INVALID_RECONCILIATION', 'Command does not own the unresolved execution slot');
        await this.write(this.receiptName(assertion.commandId), { ...row, state: 'reconciled', finishedAt: Date.now(), reconciliation: assertion });
      }
      const claim = await this.read<unknown>('active.lock');
      if (claim && lockSchema.parse(claim).commandId === assertion.commandId) await this.releaseClaim();
      return (await this.receipt(assertion.commandId))!;
    } catch (error) {
      if (error instanceof CommandAdmissionError) throw error;
      throw new CommandAdmissionError('LEDGER_UNAVAILABLE', 'Reconciliation could not be persisted; inspect the receipt before retrying the same decision');
    } finally { await mutex?.close(); }
  }

  async managedEnrollment(): Promise<{ version: 1; nodeId: string; nodeFqdn: string } | null> {
    await this.initialize();
    const value = await this.read<unknown>('managed-enrollment.json');
    if (value === undefined) return null;
    return enrollmentMarkerSchema.parse(value);
  }

  /** A drain cannot equate an idle process or expired fence with settled effects. */
  async drainSnapshot(): Promise<{ activeCount: number; unknownCount: number; evidenceSha256: string }> {
    const mutex = await this.acquire();
    try {
      const raw = await this.read<unknown>('active.lock');
      if (raw === undefined) return { activeCount: 0, unknownCount: 0, evidenceSha256: hash('no-command-owner') };
      const claim = lockSchema.parse(raw);
      const row = await this.receipt(claim.commandId);
      // The claim can precede its durable receipt; no callback starts in this gap.
      const activeCount = row?.state === 'running' ? 1 : 0;
      const unknownCount = row?.state === 'unknown' ? 1 : 0;
      return { activeCount, unknownCount, evidenceSha256: hash(JSON.stringify({ claim, receipt: row ?? null })) };
    } finally { await mutex.close(); }
  }

  /** Adopt independently observed supervisor completion without executing again. */
  async adoptRecoveredResult(commandId: string, digest: string, result: CommandReceiptResult) {
    const mutex = await this.acquire();
    try {
      const row = await this.receipt(commandId);
      if (!row || row.requestSha256 !== digest || row.state === 'reconciled') throw new Error('Recovery identity is unavailable or reconciled');
      this.checkResult(result, commandId, digest, row.coordination);
      if (row.state === 'completed') {
        if (row.result?.signature !== result.signature) throw new Error('Recovery conflicts with existing result');
        return row;
      }
      const claim = lockSchema.parse(await this.read<unknown>('active.lock'));
      if (claim.commandId !== commandId) throw new Error('Recovery does not own the unresolved slot');
      await this.write(this.receiptName(commandId), { ...row, state: 'completed', finishedAt: Date.now(), result });
      await this.releaseClaim();
      return (await this.receipt(commandId))!;
    } finally { await mutex.close(); }
  }

  /** Terminalize only centrally authorized recovery evidence. This path never
   * invokes a command callback and may create the receipt when the process died
   * before its first durable node-ledger write. */
  async settleRecoveredResult(input: CommandIdentity, result: CommandReceiptResult, enrollment: ManagedClaim) {
    input = structuredClone(input); const digest = commandRequestDigest(input); const mutex = await this.acquire();
    try {
      if (this.authority.resultSecret.length < 32) throw new Error('Result signing unavailable');
      const row = await this.receipt(input.commandId);
      if (row) {
        if (row.requestSha256 !== digest || row.state === 'reconciled') throw new Error('Recovery identity is unavailable or reconciled');
        this.checkResult(result, input.commandId, digest, row.coordination);
        if (row.state === 'completed') {
          if (row.result?.signature !== result.signature) throw new Error('Recovery conflicts with existing result');
          return row;
        }
        if (row.state === 'running') throw new CommandAdmissionError('RESOURCE_BUSY', 'The original command is still active');
        const claim = lockSchema.parse(await this.read<unknown>('active.lock'));
        if (claim.commandId !== input.commandId) throw new Error('Recovery does not own the unresolved slot');
        await this.write(this.receiptName(input.commandId), { ...row, state: 'completed', finishedAt: Date.now(), result });
        await this.releaseClaim(); return (await this.receipt(input.commandId))!;
      }
      // An active lock without a receipt proves its callback never started.
      await this.recoverClaim();
      const enrolled = await this.managedEnrollment();
      if ((enrolled && (enrollment.nodeId !== enrolled.nodeId || enrollment.nodeFqdn !== enrolled.nodeFqdn))
        || enrollment.nodeFqdn !== this.authority.nodeFqdn || input.coordination?.resourceKey !== `node:${enrollment.nodeId}`)
        throw new CommandAdmissionError('UNMANAGED_MUTATION', 'Recovery requires its authoritative enrolled resource claim');
      const fence = input.coordination;
      if (!fence) throw new Error('Recovery requires its retained resource fence');
      commandFenceSchema.parse(fence);
      const fenceName = 'fence-'+hash(fence.resourceKey)+'.json';
      const prior = await this.read<{resourceKey: string; fence: string}>(fenceName);
      if (prior && (prior.resourceKey !== fence.resourceKey || !/^[1-9][0-9]{0,18}$/.test(prior.fence))) throw new Error('Invalid fencing record');
      if (!prior || BigInt(fence.fence) > BigInt(prior.fence))
        await this.write(fenceName, { resourceKey: fence.resourceKey, fence: fence.fence });
      else if (prior && BigInt(fence.fence) < BigInt(prior.fence))
        throw new CommandAdmissionError('STALE_FENCE', 'A successor fence already owns this resource',
          { highWater: { resourceKey: fence.resourceKey, fence: prior.fence } });
      if (!enrolled) await this.write('managed-enrollment.json', { version: 1, nodeId: enrollment.nodeId, nodeFqdn: enrollment.nodeFqdn });
      this.checkResult(result, input.commandId, digest, fence); const now = Date.now();
      await this.write(this.receiptName(input.commandId), { version: 1, commandId: input.commandId, requestSha256: digest,
        state: 'completed', acceptedAt: now, finishedAt: now, coordination: fence, result });
      return (await this.receipt(input.commandId))!;
    } finally { await mutex.close(); }
  }

  /**
   * The sticky marker as it is, without creating anything. An unreadable marker
   * is `unknown`, not absent: reporting nothing could hide a mismatch.
   */
  async enrollmentMarker(): Promise<EnrollmentMarker> {
    try {
      const raw = await this.read<unknown>('managed-enrollment.json');
      if (raw === undefined) return { state: 'absent', marker: null };
      return { state: 'present', marker: enrollmentMarkerSchema.parse(raw) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { state: 'absent', marker: null };
      return { state: 'unknown', marker: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * What this ledger holds about a command, read only and without the mutex. On its
   * own "no receipt" proves nothing: a ledger that is gone holds nothing either. So
   * this also says whether there is a ledger, what fence it last accepted for the
   * key and what its marker says. Ordering in execute(): active.lock, fence, durable
   * running receipt, and only then the callback, so a claim without a receipt
   * never started.
   */
  async commandTrace(id: string, resourceKey?: string): Promise<CommandTrace> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error('Invalid command identifier');
    let ledgerExists = true;
    try {
      ledgerExists = (await lstat(this.root)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      ledgerExists = false;
    }
    const marker = await this.enrollmentMarker();
    if (!ledgerExists) return { ledgerExists, receipt: false, activeLock: false, fenceHighWater: null, marker };
    const raw = await this.read<unknown>('active.lock');
    const receipt = await this.read<unknown>(this.receiptName(id));
    const fence = resourceKey ? await this.read<{ resourceKey?: unknown; fence?: unknown }>('fence-'+hash(resourceKey)+'.json') : undefined;
    return { ledgerExists, receipt: receipt !== undefined, activeLock: raw !== undefined && lockSchema.parse(raw).commandId === id,
      fenceHighWater: fence?.resourceKey === resourceKey && typeof fence?.fence === 'string' && /^[0-9]{1,20}$/.test(fence.fence) ? fence.fence : null, marker };
  }

  /**
   * Read-only health for preflight checks and heartbeats. Takes no mutex and
   * creates nothing, so asking never competes with a running command.
   */
  async health(): Promise<LedgerHealth> {
    const health: LedgerHealth = { readable: true, activeLock: null, nonTerminalReceipts: 0, unresolvedReceipts: 0, truncated: false, fenceHighWater: {}, error: null };
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return health;
      return { ...health, readable: false, error: 'the ledger directory cannot be read' };
    }
    try {
      const receiptState = async (name: string) => {
        const file = await open(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(1024), position: 0 });
          return RECEIPT_STATE.exec(buffer.toString('utf8', 0, bytesRead))?.[1] ?? null;
        } finally { await file.close(); }
      };
      const running = new Set([...this.active].map(id => this.receiptName(id)));
      const receipts = names.filter(name => name.startsWith('receipt-'));
      health.truncated = receipts.length > HEALTH_SCAN_LIMIT;
      for (const name of receipts.slice(0, HEALTH_SCAN_LIMIT)) {
        const state = await receiptState(name);
        if (state === 'completed' || state === 'reconciled') continue;
        health.nonTerminalReceipts += 1;
        if (!running.has(name)) health.unresolvedReceipts += 1;
      }
      for (const name of names.filter(entry => entry.startsWith('fence-')).slice(0, HEALTH_FENCE_LIMIT)) {
        const record = await this.read<{ resourceKey?: unknown; fence?: unknown }>(name);
        if (typeof record?.resourceKey === 'string' && typeof record.fence === 'string' && /^[0-9]{1,20}$/.test(record.fence)) health.fenceHighWater[record.resourceKey] = record.fence;
      }
      const raw = await this.read<unknown>('active.lock');
      if (raw !== undefined) {
        const claim = lockSchema.parse(raw);
        const state = await receiptState(this.receiptName(claim.commandId)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return 'none';
          throw error;
        });
        health.activeLock = { commandId: claim.commandId, receipt: state === 'running' ? (this.active.has(claim.commandId) ? 'running' : 'unknown') : state ?? 'invalid' };
      }
      return health;
    } catch (error) {
      return { ...health, readable: false, error: `the ledger holds an unreadable record (${error instanceof Error ? error.name : 'error'})` };
    }
  }

  /** Persist an authoritative observation; never clears an active/unknown claim. */
  async observeManagedEnrollment(identity: Pick<ManagedClaim, 'nodeId' | 'nodeFqdn'>): Promise<void> {
    const value = z.object({ nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253) }).strict().parse(identity);
    if (value.nodeFqdn !== this.authority.nodeFqdn) throw new CommandAdmissionError('UNMANAGED_MUTATION', 'Enrollment target differs');
    const mutex = await this.acquire();
    try {
      const previous = await this.managedEnrollment();
      if (previous && (previous.nodeId !== value.nodeId || previous.nodeFqdn !== value.nodeFqdn))
        throw new CommandAdmissionError('UNMANAGED_MUTATION', 'Sticky enrollment identity cannot change');
      if (!previous) await this.write('managed-enrollment.json', { version: 1, ...value });
    } finally { await mutex.close(); }
  }

  async execute(input: CommandIdentity, run: (digest: string) => Promise<CommandReceiptResult>, enrollment?: ManagedClaim): Promise<CommandReceiptResult> {
    // Snapshot before awaiting; callers cannot mutate accepted scope or identity.
    input = structuredClone(input);
    const digest = commandRequestDigest(input);
    let held = false, started = false, admitted = false, noReceipt = false;
    let mutex;
    const previous = async () => {
      const row = await this.receipt(input.commandId);
      if (!row) return undefined;
      if (row.requestSha256 !== digest) throw new CommandAdmissionError('IDEMPOTENCY_CONFLICT', 'Command identifier already belongs to different input');
      if (row.state === 'completed') return row.result!;
      throw new CommandAdmissionError('OUTCOME_UNKNOWN', 'Original command is active, uncertain, or reconciled; its identifier cannot execute again');
    };
    try {
      if (this.authority.resultSecret.length < 32) throw new Error('Result signing unavailable');
      const replay = await previous(); if (replay) return replay;
      noReceipt = true;
      mutex = await this.acquire();
      await this.recoverClaim();
      const enrolled = await this.managedEnrollment();
      if ((enrolled && (!enrollment || enrollment.nodeId !== enrolled.nodeId || enrollment.nodeFqdn !== enrolled.nodeFqdn))
        || (enrollment && (enrollment.nodeFqdn !== this.authority.nodeFqdn
          || (input.coordination?.resourceKey !== `node:${enrollment.nodeId}` && !isArdentScopedCommand(input, enrollment.nodeId)))))
        throw new CommandAdmissionError('UNMANAGED_MUTATION', 'Enrolled node requires its authoritative resource claim');
      const racedReplay = await previous(); if (racedReplay) return racedReplay;
      await this.write('active.lock', { commandId: input.commandId, nonce: randomUUID(), pid: process.pid });
      held = true;
      const fence = input.coordination;
      if (fence) {
        commandFenceSchema.parse(fence);
        if (fence.expiresAt <= Date.now()) throw new CommandAdmissionError('LEASE_EXPIRED', 'Command lease expired before execution');
        const name = 'fence-'+hash(fence.resourceKey)+'.json';
        const prior = await this.read<{resourceKey: string; fence: string}>(name);
        if (prior && (prior.resourceKey !== fence.resourceKey || !/^[1-9][0-9]{0,18}$/.test(prior.fence))) throw new Error('Invalid fencing record');
        if (prior && BigInt(fence.fence) <= BigInt(prior.fence)) throw new CommandAdmissionError('STALE_FENCE', 'Stale resource fence cannot execute',
          { highWater: { resourceKey: fence.resourceKey, fence: prior.fence } });
        await this.write(name, { resourceKey: fence.resourceKey, fence: fence.fence });
      }
      if (enrollment && !enrolled) await this.write('managed-enrollment.json', { version: 1, nodeId: enrollment.nodeId, nodeFqdn: enrollment.nodeFqdn });
      const receipt: Receipt = { version: 1, commandId: input.commandId, requestSha256: digest,
        state: 'running', acceptedAt: Date.now(), ...(fence ? {coordination: fence} : {}) };
      await this.write(this.receiptName(input.commandId), receipt);
      started = true; admitted = true; this.active.add(input.commandId);
      const result = await run(digest);
      this.checkResult(result, input.commandId, digest, fence);
      await this.write(this.receiptName(input.commandId), { ...receipt, state: 'completed', finishedAt: Date.now(), result });
      started = false;
      return result;
    } catch (error) {
      // `started` stays true from just before the callback until its terminal receipt is durable.
      const certain = !started && noReceipt;
      if (error instanceof CommandAdmissionError) {
        if (certain && !['OUTCOME_UNKNOWN', 'IDEMPOTENCY_CONFLICT'].includes(error.code)) error.notStarted = true;
        throw error;
      }
      throw new CommandAdmissionError(started ? 'OUTCOME_UNKNOWN' : 'LEDGER_UNAVAILABLE',
        started ? 'Execution receipt is uncertain; retained for reconciliation and never replayed' : 'Command ledger unavailable; inspect its receipt before retrying',
        { notStarted: certain });
    } finally {
      if (admitted) this.active.delete(input.commandId);
      try {
        if (held && !started) await this.releaseClaim();
      } catch {
        // A durable terminal receipt remains authoritative if lock cleanup fails.
        // The next holder verifies it and completes cleanup under the mutex.
      } finally { await mutex?.close(); }
    }
  }
}
