/** Finite, immutable cron occurrences. A crash is uncertainty, never permission to replay. */
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { HOST_FQDN } from '../env.js';
import { hash, privateDirectory, readJson, writeJson } from './execution-supervisor-state.js';
import { commandFenceSchema, commandRequestDigest, type CommandIdentity, type CommandReceiptResult } from './command-ledger.js';
import { aggregateSchedulerBlockers } from './scheduler-discovery.js';

export const managedCronSchema = z.object({
  nodeFqdn: z.string().min(1).max(253),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  revision: z.number().int().positive().max(2147483647),
  schedule: z.string().min(9).max(64),
  timezone: z.literal('UTC'),
  workingDirectory: z.string().max(4096).startsWith('/').optional(),
  environment: z.record(z.string(), z.string().max(4096)).default({}),
  command: z.string().min(1).max(16384).regex(/^[^\n\r\x00]+$/),
  args: z.array(z.string().max(4096).regex(/^[^\x00]*$/)).max(64).default([]),
  timeoutSeconds: z.number().int().min(1).max(3600),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
}).strict().superRefine((value, ctx) => {
  try { scheduleFields(value.schedule); } catch { ctx.addIssue({ code: 'custom', message: 'Unsupported numeric five-field cron schedule' }); }
});
export type ManagedCronSpec = z.infer<typeof managedCronSchema>;
export const cronEnrollmentStageSchema = z.object({
  version: z.literal(1), nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253),
  spec: managedCronSchema, operationId: z.string().guid(), expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CronEnrollmentStage = z.infer<typeof cronEnrollmentStageSchema>;
export function cronEnrollmentStageSigningPayload(value: Omit<CronEnrollmentStage, 'signature'>): string {
  return JSON.stringify({ domain: 'magnus.cron-enrollment-stage.v1', version: value.version, nodeId: value.nodeId,
    nodeFqdn: value.nodeFqdn, specSha256: hash(JSON.stringify(value.spec)), operationId: value.operationId,
    expiresAt: value.expiresAt });
}
const cronEnrollmentStageIdentitySchema = z.object({ nodeFqdn: z.string().min(1).max(253),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), jobId: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive().max(2147483647), specSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const cronEnrollmentStageReceiptSchema = cronEnrollmentStageIdentitySchema.extend({
  operationId: z.string().guid(), staged: z.literal(true), enabled: z.literal(false),
  receiptSignature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function cronEnrollmentStageReceiptPayload(value: Omit<z.infer<typeof cronEnrollmentStageReceiptSchema>, 'receiptSignature'>): string {
  return JSON.stringify({ domain: 'magnus.cron-enrollment-stage-receipt.v1', ...value });
}
export interface ManagedCronJob { version: 1; jobId: string; specSha256: string; spec: ManagedCronSpec; enabled: boolean }
export interface SchedulerOccurrence {
  version: 1; occurrenceId: string; jobId: string; revision: number; specSha256: string;
  scheduledAt: number; deadline: number; command: CommandIdentity; requestSha256: string;
  state: 'admitting' | 'running' | 'unknown' | 'completed' | 'not-started';
  admission?: Record<string, unknown>; result?: CommandReceiptResult; settlementPending: boolean;
}
const occurrenceSchema = z.object({
  version: z.literal(1), occurrenceId: z.string().regex(/^[a-f0-9]{64}$/), jobId: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive().max(2147483647), specSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scheduledAt: z.number().int().nonnegative(), deadline: z.number().int().positive(),
  command: z.object({ commandId: z.string(), command: z.string().min(1), args: z.array(z.string()),
    workingDirectory: z.string().optional(), environment: z.record(z.string(), z.string()).optional(), timeoutSeconds: z.number().int().min(1).max(3600),
    coordination: commandFenceSchema.optional() }).strict(),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['admitting', 'running', 'unknown', 'completed', 'not-started']),
  admission: z.record(z.string(), z.unknown()).optional(), settlementPending: z.boolean(),
  result: z.object({ commandId: z.string(), exitCode: z.number().int(), stdout: z.string(), stderr: z.string(),
    durationMs: z.number().int().nonnegative(), truncated: z.boolean(), signature: z.string().regex(/^[a-f0-9]{64}$/),
    coordination: commandFenceSchema.extend({ requestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }).strict().optional(),
}).strict();
export interface SchedulerAuthority {
  enrolled?(identity: SchedulerDrainIdentity): Promise<SchedulerDrainIdentity | null>;
  admit(occurrence: SchedulerOccurrence, job: ManagedCronJob): Promise<Record<string, unknown>>;
  execute(occurrence: SchedulerOccurrence): Promise<CommandReceiptResult>;
  recover(occurrence: SchedulerOccurrence): Promise<CommandReceiptResult | undefined>;
  settle(occurrence: SchedulerOccurrence): Promise<void>;
}

function scheduleFields(schedule: string): Array<Set<number>> {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Five cron fields required');
  return fields.map((field, index) => {
    const lower = [0, 0, 1, 1, 0][index]!; const upper = [59, 23, 31, 12, 7][index]!;
    const values = new Set<number>();
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match || (match[2] && match[1] !== '*' && !match[1]!.includes('-'))) throw new Error('Unsupported cron field');
      const step = Number(match[2] ?? 1);
      const range = match[1] === '*' ? [lower, upper] : match[1]!.split('-').map(Number);
      const start = range[0]!; const end = range[1] ?? start;
      if (!Number.isInteger(step) || step < 1 || step > upper + 1 || start < lower || end > upper || start > end) throw new Error('Cron field out of range');
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return values;
  });
}
export function cronDue(schedule: string, at: number): boolean {
  const fields = scheduleFields(schedule); const date = new Date(at);
  const parts = schedule.trim().split(/\s+/);
  const dom = fields[2]!.has(date.getUTCDate()); const dow = fields[4]!.has(date.getUTCDay());
  const day = parts[2]!.startsWith('*') || parts[4]!.startsWith('*') ? dom && dow : dom || dow;
  return fields[0]!.has(date.getUTCMinutes()) && fields[1]!.has(date.getUTCHours()) && fields[3]!.has(date.getUTCMonth() + 1) && day;
}
export function makeCronJob(raw: unknown): ManagedCronJob {
  const spec = managedCronSchema.parse(raw);
  return { version: 1, jobId: hash(JSON.stringify([spec.nodeFqdn, spec.name])), specSha256: hash(JSON.stringify(spec)), spec, enabled: true };
}
export function makeOccurrence(job: ManagedCronJob, scheduledAt: number): SchedulerOccurrence {
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt % 60_000 !== 0) throw new Error('Canonical cron minute required');
  const occurrenceId = hash(JSON.stringify([job.jobId, job.spec.revision, scheduledAt]));
  const deadline = Math.min(job.spec.expiresAt, scheduledAt + job.spec.timeoutSeconds * 1000);
  const command: CommandIdentity = { commandId: 'cron-' + occurrenceId, command: job.spec.command,
    args: [...job.spec.args], timeoutSeconds: job.spec.timeoutSeconds, workingDirectory: job.spec.workingDirectory, environment: { ...job.spec.environment } };
  return { version: 1, occurrenceId, jobId: job.jobId, revision: job.spec.revision, specSha256: job.specSha256,
    scheduledAt, deadline, command, requestSha256: commandRequestDigest(command), state: 'admitting', settlementPending: false };
}

export const schedulerDrainIdentitySchema = z.object({ nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253),
  epoch: z.number().int().positive(), barrierId: z.string().guid() }).strict();
export type SchedulerDrainIdentity = z.infer<typeof schedulerDrainIdentitySchema>;

export const schedulerSourceSettlementSchema = z.object({
  version: z.literal(1), sourceIdentityVersion: z.literal(2), nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253),
  epoch: z.number().int().positive(), barrierId: z.string().guid(), kind: z.string().regex(/^[A-Z_]{1,80}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), count: z.number().int().positive().max(1_000_000),
  disposition: z.enum(['effects_verified', 'no_effect_verified']), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvalRef: z.string().min(1).max(512), decisionId: z.string().guid(), expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SchedulerSourceSettlement = z.infer<typeof schedulerSourceSettlementSchema>;
const schedulerSourceSettlementUnsignedSchema = schedulerSourceSettlementSchema.omit({ signature: true });
export const schedulerSourceSettlementReceiptSchema = schedulerSourceSettlementUnsignedSchema.extend({
  settled: z.literal(true), replayed: z.literal(false), receiptSignature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SchedulerSourceSettlementReceipt = z.infer<typeof schedulerSourceSettlementReceiptSchema>;
export function schedulerSourceSettlementSigningPayload(value: Omit<SchedulerSourceSettlement, 'signature'>): string {
  return JSON.stringify({ domain: 'magnus.scheduler-source-reconciliation.v2', version: value.version,
    sourceIdentityVersion: value.sourceIdentityVersion,
    nodeId: value.nodeId, nodeFqdn: value.nodeFqdn, epoch: value.epoch, barrierId: value.barrierId,
    kind: value.kind, sourceSha256: value.sourceSha256, count: value.count, disposition: value.disposition,
    evidenceSha256: value.evidenceSha256, approvalRef: value.approvalRef, decisionId: value.decisionId,
    expiresAt: value.expiresAt });
}
export function schedulerSourceSettlementReceiptPayload(value: Omit<SchedulerSourceSettlement, 'signature'> & { settled: true; replayed: boolean }): string {
  return JSON.stringify({ domain: 'magnus.scheduler-source-reconciliation-receipt.v2', ...value });
}

const settlementTombstoneSchema = z.object({ decisionId: z.string().guid(), assertionSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const MAX_SETTLEMENT_RECEIPTS = 128;
const MAX_SETTLEMENT_TOMBSTONES = 1024;
const SETTLEMENT_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DISCOVERY_MEMORY_MAX_BYTES = 256 * 1024;
const foreignSourceV1Schema = z.object({ kind: z.string().regex(/^[A-Z_]{1,80}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), count: z.number().int().positive().max(1000000) }).strict();
const foreignSourceV2Schema = foreignSourceV1Schema.extend({ identityVersion: z.literal(2) }).strict();
const legacySettlementUnsignedSchema = schedulerSourceSettlementUnsignedSchema.omit({ sourceIdentityVersion: true });
const legacySettlementReceiptSchema = legacySettlementUnsignedSchema.extend({ settled: z.literal(true), replayed: z.literal(false),
  receiptSignature: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const legacyDiscoveryMemorySchema = z.object({ version: z.literal(1), hermesRoots: z.array(z.string().startsWith('/').max(4096)).max(256),
  foreignSources: z.array(foreignSourceV1Schema).max(1024), settlements: z.array(legacySettlementReceiptSchema).max(MAX_SETTLEMENT_RECEIPTS).default([]),
  settlementTombstones: z.array(settlementTombstoneSchema).max(MAX_SETTLEMENT_TOMBSTONES).default([]) }).strict();
const discoveryMemorySchema = z.object({ version: z.literal(2), hermesRoots: z.array(z.string().startsWith('/').max(4096)).max(256),
  foreignSources: z.array(foreignSourceV2Schema).max(1024), legacyForeignSources: z.array(foreignSourceV1Schema).max(1024),
  settlements: z.array(schedulerSourceSettlementReceiptSchema).max(MAX_SETTLEMENT_RECEIPTS).default([]),
  legacySettlements: z.array(legacySettlementReceiptSchema).max(MAX_SETTLEMENT_RECEIPTS).default([]),
  settlementTombstones: z.array(settlementTombstoneSchema).max(MAX_SETTLEMENT_TOMBSTONES).default([]),
}).strict();
export class ManagedScheduler {
  constructor(readonly root = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/managed-scheduler'), private readonly hostname = HOST_FQDN) {}
  private async writeDiscovery(value: z.infer<typeof discoveryMemorySchema>): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(value)) > DISCOVERY_MEMORY_MAX_BYTES) throw new Error('Scheduler discovery journal size limit reached');
    await writeJson(this.root, 'scheduler-discovery.json', value);
  }
  private async readDiscovery(): Promise<z.infer<typeof discoveryMemorySchema>> {
    const raw = await readJson<unknown>(this.root, 'scheduler-discovery.json', DISCOVERY_MEMORY_MAX_BYTES);
    if (raw === undefined) return { version: 2, hermesRoots: [], foreignSources: [], legacyForeignSources: [],
      settlements: [], legacySettlements: [], settlementTombstones: [] };
    const current = discoveryMemorySchema.safeParse(raw);
    if (current.success) return current.data;
    const legacy = legacyDiscoveryMemorySchema.parse(raw);
    return { version: 2, hermesRoots: legacy.hermesRoots, foreignSources: [], legacyForeignSources: legacy.foreignSources,
      settlements: [], legacySettlements: legacy.settlements, settlementTombstones: legacy.settlementTombstones };
  }
  async locked<T>(work: () => Promise<T>): Promise<T> {
    await privateDirectory(this.root);
    const fd = await open(join(this.root, 'scheduler.flock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const st = await fd.stat(); if (!st.isFile() || st.nlink !== 1 || st.mode & 0o077) throw new Error('Unsafe scheduler mutex');
      const code = await new Promise<number | null>((resolveCode, reject) => {
        const child = spawn('/usr/bin/flock', ['--exclusive', '--wait', '2', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd.fd] });
        child.once('error', reject); child.once('exit', resolveCode);
      });
      if (code !== 0) throw new Error('Scheduler journal unavailable');
      return await work();
    } finally { await fd.close(); }
  }
  private async barrier(): Promise<SchedulerDrainIdentity | null> {
    const raw = await readJson<unknown>(this.root, 'drain.json');
    if (raw === undefined) return null;
    const value = schedulerDrainIdentitySchema.parse(raw);
    if (value.nodeFqdn !== this.hostname) throw new Error('Scheduler barrier belongs to another host');
    return value;
  }
  /** Called under the scheduler lock by every schedule installation path. */
  async assertOpen(managed = false): Promise<void> {
    const barrier = await this.barrier();
    if (!barrier) return;
    const raw = managed ? await readJson<unknown>(this.root, 'enrolled.json') : undefined;
    if (raw !== undefined && JSON.stringify(schedulerDrainIdentitySchema.parse(raw)) === JSON.stringify(barrier)) return;
    throw new Error('Scheduler admission is draining');
  }
  /** Only the installed trusted authority adapter observes API enrollment. Keep
   * the sticky barrier: raw scheduling is never reopened by this transition. */
  async confirmEnrollment(authority: SchedulerAuthority): Promise<void> {
    const identity = await this.locked(async () => {
      const value = await this.barrier();
      if (!value) return null;
      try { await this.assertOpen(true); return null; } catch { return value; }
    });
    if (!identity || !authority.enrolled) return;
    const confirmed = await authority.enrolled(identity);
    if (!confirmed || JSON.stringify(schedulerDrainIdentitySchema.parse(confirmed)) !== JSON.stringify(identity)) return;
    await this.locked(async () => {
      if (JSON.stringify(await this.barrier()) !== JSON.stringify(identity)) throw new Error('Scheduler enrollment identity changed');
      await writeJson(this.root, 'enrolled.json', identity);
    });
  }
  async drain(raw: SchedulerDrainIdentity): Promise<void> {
    const value = schedulerDrainIdentitySchema.parse(raw);
    if (value.nodeFqdn !== this.hostname) throw new Error('Scheduler drain target differs');
    await this.locked(async () => {
      const existing = await this.barrier();
      if (await readJson<unknown>(this.root, 'enrolled.json') !== undefined) throw new Error('Scheduler barrier already enrolled; new reviewed drain protocol required');
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('Scheduler drain identity differs');
      if (!existing) await writeJson(this.root, 'drain.json', value);
    });
  }
  /** Observed foreign work cannot disappear merely because its configuration or
   * process disappeared. No caller attestation or age-based clearing is exposed. */
  async observeDiscovery(roots: string[], sources: Array<{ kind: string; sourceSha256: string; count: number; identityVersion?: 2 }>) {
    return this.locked(async () => {
      const prior = await this.readDiscovery();
      const unique = new Map(prior.foreignSources.map(source => [source.kind + ':' + source.sourceSha256, source]));
      for (const source of aggregateSchedulerBlockers(sources)) {
        const key = source.kind + ':' + source.sourceSha256; const existing = unique.get(key);
        unique.set(key, { ...source, count: Math.max(existing?.count ?? 0, source.count) });
      }
      const value = discoveryMemorySchema.parse({ ...prior, version: 2, hermesRoots: [...new Set([...prior.hermesRoots, ...roots])].sort(),
        foreignSources: [...unique.values()].sort((a, b) => (a.kind + a.sourceSha256).localeCompare(b.kind + b.sourceSha256)),
      });
      if (JSON.stringify(value) !== JSON.stringify(prior)) await this.writeDiscovery(value);
      return value;
    });
  }
  /** Remove only an exact remembered foreign source under a fresh, externally
   * signed evidence decision. A source observed again is re-added immediately. */
  async settlementReceipt(decisionId: string): Promise<SchedulerSourceSettlementReceipt | z.infer<typeof legacySettlementReceiptSchema> | undefined> {
    const id = z.string().guid().parse(decisionId);
    return this.locked(async () => {
      const memory = await this.readDiscovery();
      return memory.settlements.find(row => row.decisionId === id) ?? memory.legacySettlements.find(row => row.decisionId === id);
    });
  }
  async settleForeignSource(raw: SchedulerSourceSettlement,
    signReceipt: (payload: Omit<SchedulerSourceSettlementReceipt, 'receiptSignature'>) => string) {
    const assertion = schedulerSourceSettlementSchema.parse(raw);
    return this.locked(async () => {
      const barrier = await this.barrier();
      if (!barrier || assertion.nodeId !== barrier.nodeId || assertion.nodeFqdn !== barrier.nodeFqdn
        || assertion.epoch !== barrier.epoch || assertion.barrierId !== barrier.barrierId)
        throw new Error('Scheduler settlement barrier differs');
      const memory = await this.readDiscovery();
      const digest = hash(schedulerSourceSettlementSigningPayload(assertion));
      const prior = memory.settlements.find(row => row.decisionId === assertion.decisionId);
      if (prior) {
        if (hash(schedulerSourceSettlementSigningPayload(prior)) !== digest) throw new Error('Scheduler settlement decision was reused');
        return { receipt: prior, replayed: true };
      }
      if (memory.legacySettlements.some(row => row.decisionId === assertion.decisionId))
        throw new Error('Scheduler settlement decision was reused by a legacy identity');
      const tombstone = memory.settlementTombstones.find(row => row.decisionId === assertion.decisionId);
      if (tombstone) {
        if (tombstone.assertionSha256 !== digest) throw new Error('Scheduler settlement decision was reused');
        throw new Error('Scheduler settlement receipt was compacted');
      }
      const source = memory.foreignSources.find(row => row.kind === assertion.kind && row.sourceSha256 === assertion.sourceSha256);
      if (!source || source.count !== assertion.count) throw new Error('Remembered scheduler source differs');
      if (source.identityVersion !== assertion.sourceIdentityVersion)
        throw new Error('Scheduler source identity version differs');
      let settlements = [...memory.settlements]; const settlementTombstones = [...memory.settlementTombstones];
      if (settlements.length >= MAX_SETTLEMENT_RECEIPTS) {
        const eligible = settlements.filter(row => row.expiresAt <= Date.now() - SETTLEMENT_RECEIPT_RETENTION_MS)
          .sort((a, b) => a.expiresAt - b.expiresAt || a.decisionId.localeCompare(b.decisionId));
        for (const row of eligible) {
          if (settlements.length < MAX_SETTLEMENT_RECEIPTS || settlementTombstones.length >= MAX_SETTLEMENT_TOMBSTONES) break;
          settlementTombstones.push({ decisionId: row.decisionId,
            assertionSha256: hash(schedulerSourceSettlementSigningPayload(row)) });
          settlements = settlements.filter(candidate => candidate.decisionId !== row.decisionId);
        }
      }
      if (settlements.length >= MAX_SETTLEMENT_RECEIPTS) throw new Error('Scheduler settlement journal limit reached');
      const { signature: _signature, ...unsigned } = assertion;
      const payload = { ...schedulerSourceSettlementUnsignedSchema.parse(unsigned), settled: true as const, replayed: false as const };
      const receipt = schedulerSourceSettlementReceiptSchema.parse({ ...payload, receiptSignature: signReceipt(payload) });
      const next = discoveryMemorySchema.parse({ ...memory,
        foreignSources: memory.foreignSources.filter(row => row !== source), settlements: [...settlements, receipt],
        settlementTombstones: settlementTombstones.sort((a, b) => a.decisionId.localeCompare(b.decisionId)) });
      await this.writeDiscovery(next);
      return { receipt, replayed: false };
    });
  }
  async job(jobId: string): Promise<ManagedCronJob | undefined> {
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw new Error('Invalid job ID');
    const job = await readJson<ManagedCronJob>(this.root, 'job-' + jobId + '.json');
    if (job) {
      const canonical = makeCronJob(job.spec);
      if (job.version !== 1 || job.jobId !== jobId || canonical.jobId !== jobId || canonical.specSha256 !== job.specSha256 || typeof job.enabled !== 'boolean') throw new Error('Invalid scheduler job binding');
    }
    return job;
  }
  /** Caller holds scheduler lock through the corresponding crontab edit. */
  async saveJob(job: ManagedCronJob): Promise<void> {
    await this.assertOpen(true);
    const previous = await this.job(job.jobId);
    if (previous && (job.spec.revision < previous.spec.revision || job.spec.revision === previous.spec.revision && job.specSha256 !== previous.specSha256)) throw new Error('Job revision reused or stale');
    if (job.spec.expiresAt <= Date.now()) throw new Error('An explicit future job expiry is required');
    await writeJson(this.root, 'job-' + job.jobId + '.json', job);
  }
  async setEnabled(identity: { jobId: string; revision: number; specSha256: string }, enabled: boolean): Promise<ManagedCronJob> {
    const job = await this.job(identity.jobId);
    if (!job || job.spec.revision !== identity.revision || job.specSha256 !== identity.specSha256)
      throw new Error('Managed job identity differs');
    const updated = { ...job, enabled };
    await writeJson(this.root, 'job-' + job.jobId + '.json', updated);
    return updated;
  }
  async disable(jobId: string): Promise<void> {
    const job = await this.job(jobId); if (job) await writeJson(this.root, 'job-' + jobId + '.json', { ...job, enabled: false });
  }
  async occurrence(id: string): Promise<SchedulerOccurrence | undefined> {
    return this.locked(() => this.readOccurrence(id));
  }
  private async readOccurrence(id: string): Promise<SchedulerOccurrence | undefined> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid occurrence ID');
    const raw = await readJson<unknown>(this.root, 'occurrence-' + id + '.json');
    const row = raw === undefined ? undefined : occurrenceSchema.parse(raw);
    if (row && (row.version !== 1 || row.occurrenceId !== id || row.command.commandId !== 'cron-' + id
      || row.requestSha256 !== commandRequestDigest(row.command) || !Number.isSafeInteger(row.deadline)
      || row.scheduledAt % 60_000 !== 0 || hash(JSON.stringify([row.jobId, row.revision, row.scheduledAt])) !== id
      || row.deadline > row.scheduledAt + row.command.timeoutSeconds * 1000 || row.deadline <= row.scheduledAt
      || row.command.coordination && row.command.coordination.expiresAt > row.deadline
      || row.state === 'completed' && (!row.result || row.result.commandId !== row.command.commandId))) throw new Error('Invalid occurrence binding');
    return row;
  }
  private async update(row: SchedulerOccurrence): Promise<SchedulerOccurrence> {
    return this.locked(async () => {
      const current = await this.readOccurrence(row.occurrenceId);
      // Late workers cannot demote proven terminal state.
      if (current?.state === 'completed' || current?.state === 'not-started') return current;
      await writeJson(this.root, 'occurrence-' + row.occurrenceId + '.json', row); return row;
    });
  }
  async trigger(jobId: string, revision: number, authority: SchedulerAuthority, now = Date.now()): Promise<SchedulerOccurrence> {
    await this.confirmEnrollment(authority).catch(() => undefined); // Original receipt recovery stays available during API outages.
    const claimed = await this.locked(async () => {
      const job = await this.job(jobId);
      if (!job || !job.enabled || job.spec.revision !== revision) throw new Error('Managed job disabled or revised');
      const row = makeOccurrence(job, Math.floor(now / 60_000) * 60_000);
      const previous = await this.readOccurrence(row.occurrenceId); if (previous) return { row: previous, job, fresh: false };
      await this.assertOpen(true);
      if (now >= row.deadline || !cronDue(job.spec.schedule, now)) throw new Error('Occurrence is not due or has expired');
      await writeJson(this.root, 'occurrence-' + row.occurrenceId + '.json', row);
      return { row, job, fresh: true };
    });
    if (!claimed.fresh) return this.recover(claimed.row.occurrenceId, authority);
    let row = claimed.row;
    try {
      row.admission = await authority.admit(structuredClone(row), claimed.job);
      const coordination = commandFenceSchema.parse(row.admission['coordination']);
      if (coordination.expiresAt > row.deadline || coordination.expiresAt <= Date.now()) throw new Error('Admission exceeds occurrence deadline');
      row.command = { ...row.command, coordination };
      row.requestSha256 = commandRequestDigest(row.command);
      // Persist the authority receipt before starting any command.
      row = await this.update({ ...row, state: 'running', settlementPending: true });
      const stillCurrent = await this.locked(async () => {
        const job = await this.job(jobId);
        try { await this.assertOpen(true); } catch { return false; }
        return !!job?.enabled && job.specSha256 === row.specSha256 && row.deadline > Date.now();
      });
      if (!stillCurrent) row = await this.update({ ...row, state: 'not-started' });
      else {
        const result = await authority.execute(structuredClone(row));
        if (result.commandId !== row.command.commandId) throw new Error('Completion identity differs');
        row = await this.update({ ...row, state: 'completed', result });
      }
    } catch {
      row = await this.update({ ...row, state: 'unknown', settlementPending: true });
    }
    return this.settle(row, authority);
  }
  async recover(id: string, authority: SchedulerAuthority): Promise<SchedulerOccurrence> {
    let row = await this.occurrence(id); if (!row) throw new Error('Occurrence absent');
    if (!['completed', 'not-started'].includes(row.state)) {
      // Observation only. Never call admit/execute again after a crash or lost reply.
      try {
        const result = await authority.recover(structuredClone(row));
        if (result?.commandId === row.command.commandId) row = await this.update({ ...row, state: 'completed', result, settlementPending: true });
      } catch { /* Preserve uncertainty. */ }
    }
    return this.settle(row, authority);
  }
  private async settle(row: SchedulerOccurrence, authority: SchedulerAuthority): Promise<SchedulerOccurrence> {
    if (!row.settlementPending || !['completed', 'not-started'].includes(row.state)) return row;
    try {
      await authority.settle(structuredClone(row));
      return await this.locked(async () => {
        const current = (await this.readOccurrence(row.occurrenceId))!;
        const settled = { ...current, settlementPending: false };
        await writeJson(this.root, 'occurrence-' + row.occurrenceId + '.json', settled); return settled;
      });
    } catch { return row; }
  }
  async inventory(expectedBarrier?: SchedulerDrainIdentity): Promise<{ jobs: ManagedCronJob[]; occurrences: SchedulerOccurrence[]; issues: string[]; barrier: SchedulerDrainIdentity | null }> {
    return this.locked(async () => {
      const barrier = await this.barrier();
      if (expectedBarrier && JSON.stringify(barrier) !== JSON.stringify(schedulerDrainIdentitySchema.parse(expectedBarrier))) throw new Error('Scheduler snapshot barrier differs');
      const jobs: ManagedCronJob[] = []; const occurrences: SchedulerOccurrence[] = []; const issues: string[] = [];
      const names = await readdir(this.root); if (names.length > 4096) throw new Error('Scheduler inventory limit exceeded');
      for (const name of names) {
        if (/^job-[a-f0-9]{64}\.json$/.test(name)) jobs.push((await this.job(name.slice(4, -5)))!);
        else if (/^occurrence-[a-f0-9]{64}\.json$/.test(name)) occurrences.push((await this.readOccurrence(name.slice(11, -5)))!);
        else if (name !== 'scheduler.flock' && name !== 'drain.json' && name !== 'enrolled.json' && name !== 'scheduler-coverage.json' && name !== 'scheduler-discovery.json') issues.push('UNRECOGNIZED_SCHEDULER_RECORD');
      }
      return { jobs, occurrences, issues, barrier };
    });
  }
}
