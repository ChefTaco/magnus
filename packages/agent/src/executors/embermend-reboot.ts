/** A reboot is pending until the acknowledged schedule is tied to a subsequent boot. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { embermendCanonical, type EmbermendOperation } from '@hivemagnus/magnus-contracts/embermend';
import { privateDirectory, readJson, writeJson } from './execution-supervisor-state.js';
import type { EmbermendNodeConfig } from './embermend-config.js';
const exec = promisify(execFile);
const hash = (value: unknown): string => createHash('sha256').update(embermendCanonical(value)).digest('hex');
const bootId = z.uuid();
const parameters = z.object({ beforeBootId: bootId, managementProbeId: z.string().min(1).max(200) }).strict();
const recordSchema = z.object({ version: z.literal(1), operationId: z.string(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/), beforeBootId: bootId, managementProbeId: z.string(), requestedAt: z.number().int(), phase: z.enum(['requested', 'accepted']), acceptedAt: z.number().int().optional(), scheduledFor: z.number().int().optional(), scheduleDigest: z.string().optional() }).strict();
export interface RebootSystem { now(): number; bootId(): Promise<string>; uptime(): Promise<number>; scheduled(): Promise<string | null>; schedule(marker: string): Promise<void>; shutdownJournal(beforeBootId: string): Promise<string> }
const system: RebootSystem = {
  now: Date.now,
  bootId: async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  uptime: async () => Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]),
  scheduled: async () => readFile('/run/systemd/shutdown/scheduled', 'utf8').catch((error: unknown) => { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }),
  schedule: async marker => { await exec('/usr/sbin/shutdown', ['--reboot', '+1', marker], { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, timeout: 15000, maxBuffer: 65536 }); },
  shutdownJournal: async beforeBootId => (await exec('/usr/bin/journalctl', [
    '--boot=' + bootId.parse(beforeBootId).replaceAll('-', ''), '--no-pager', '--quiet', '--output=json', '--lines=2',
    '--output-fields=MESSAGE,MESSAGE_ID,SHUTDOWN,_UID,_COMM,_EXE,_SYSTEMD_UNIT,_TRANSPORT,_BOOT_ID,__REALTIME_TIMESTAMP',
    'MESSAGE_ID=98268866d1d54a499c4e98921d93bc40', '_SYSTEMD_UNIT=systemd-logind.service',
  ], { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, timeout: 5000, maxBuffer: 65536 })).stdout,
};
const shutdownSchema = z.object({
  MESSAGE: z.string().max(300), MESSAGE_ID: z.literal('98268866d1d54a499c4e98921d93bc40'), SHUTDOWN: z.literal('reboot'),
  _UID: z.literal('0'), _COMM: z.literal('systemd-logind'), _EXE: z.enum(['/usr/lib/systemd/systemd-logind', '/lib/systemd/systemd-logind']),
  _SYSTEMD_UNIT: z.literal('systemd-logind.service'), _TRANSPORT: z.literal('journal'), _BOOT_ID: z.string().regex(/^[a-f0-9]{32}$/), __REALTIME_TIMESTAMP: z.string().regex(/^\d{1,20}$/),
});
const root = (): string => resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/embermend-reboots');
export class RebootOutcomeUnknown extends Error {}
export async function requestReboot(request: EmbermendOperation, config: EmbermendNodeConfig, host: RebootSystem = system): Promise<never> {
  const input = parameters.parse(request.action.parameters);
  if (!config.reboot || config.reboot.managementProbeId !== input.managementProbeId || request.action.class !== 'reboot' || request.action.targetKind !== 'host' || request.action.disruption !== 'reboot') throw new Error('Explicit host reboot policy required');
  if (bootId.parse(await host.bootId()) !== input.beforeBootId || Date.parse(request.expiresAt) <= host.now()) throw new Error('Reboot precondition or admission window changed');
  await privateDirectory(root()); const name = hash(request.operationId) + '.json';
  if (await readJson<unknown>(root(), name)) throw new RebootOutcomeUnknown('Original reboot intent retained; observation only');
  if (await host.scheduled() !== null) throw new Error('A shutdown is already scheduled; owner intervention required');
  const record = recordSchema.parse({ version: 1, operationId: request.operationId, requestDigest: hash(request), beforeBootId: input.beforeBootId, managementProbeId: input.managementProbeId, requestedAt: host.now(), phase: 'requested' });
  await writeJson(root(), name, record);
  try {
    const marker = 'Magnus-Embermend-' + hash(request);
    await host.schedule(marker);
    const schedule = await host.scheduled();
    const at = schedule === null ? NaN : Math.floor(Number(/^USEC=(\d+)$/m.exec(schedule)?.[1]) / 1000);
    if (!schedule || !/^MODE=reboot$/m.test(schedule) || !schedule.split('\n').includes('WALL_MESSAGE=' + marker) || !Number.isSafeInteger(at) || at < record.requestedAt || at > host.now() + 120000) throw new Error('Exact systemd reboot acknowledgement unavailable');
    await writeJson(root(), name, { ...record, phase: 'accepted', acceptedAt: host.now(), scheduledFor: at, scheduleDigest: hash(schedule) });
  } catch { throw new RebootOutcomeUnknown('Reboot scheduling outcome requires original-operation observation'); }
  throw new RebootOutcomeUnknown('Acknowledged reboot is pending a subsequent boot');
}
export async function observeReboot(request: EmbermendOperation, config: EmbermendNodeConfig, host: RebootSystem = system): Promise<Record<string, string | number | boolean> | undefined> {
  const raw = await readJson<unknown>(root(), hash(request.operationId) + '.json'); if (!raw) return undefined;
  const record = recordSchema.parse(raw); const input = parameters.parse(request.action.parameters);
  if (record.operationId !== request.operationId || record.requestDigest !== hash(request) || record.beforeBootId !== input.beforeBootId || record.managementProbeId !== input.managementProbeId || !config.reboot || config.reboot.managementProbeId !== input.managementProbeId) throw new Error('Original reboot identity or protected policy differs');
  if (record.phase !== 'accepted' || record.acceptedAt === undefined || record.scheduledFor === undefined || !record.scheduleDigest) return undefined;
  const afterBootId = bootId.parse(await host.bootId()); if (afterBootId === record.beforeBootId) return undefined;
  const uptime = await host.uptime(); if (!Number.isFinite(uptime) || uptime < 0) return undefined;
  const bootStartedAt = Math.round(host.now() - uptime * 1000);
  // An agent restart, an early unrelated reboot, clock ambiguity or a much later
  // boot cannot establish this scheduled operation's completion.
  if (record.acceptedAt < record.requestedAt || record.acceptedAt > Date.parse(request.expiresAt) || record.scheduledFor < record.acceptedAt || bootStartedAt < record.scheduledFor - 3000 || bootStartedAt > record.scheduledFor + config.reboot.continuationWindowSeconds * 1000) return undefined;
  // Timing and a previous acknowledgement cannot distinguish a cancelled
  // schedule from an unrelated reboot in the same window. Require the previous
  // boot's trusted logind shutdown event to name this exact operation marker.
  let shutdown: z.infer<typeof shutdownSchema>;
  try {
    const journal = await host.shutdownJournal(record.beforeBootId); if (Buffer.byteLength(journal) > 65536) return undefined;
    const lines = journal.split('\n').filter(line => line.trim()); if (lines.length !== 1) return undefined;
    shutdown = shutdownSchema.parse(JSON.parse(lines[0] ?? ''));
  } catch { return undefined; }
  const initiated = BigInt(shutdown.__REALTIME_TIMESTAMP) / 1000n;
  if (initiated > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const shutdownInitiatedAt = Number(initiated);
  if (shutdown._BOOT_ID !== record.beforeBootId.replaceAll('-', '') || shutdown.MESSAGE !== 'System is rebooting (Magnus-Embermend-' + hash(request) + ').' || shutdownInitiatedAt < record.scheduledFor - 3000 || shutdownInitiatedAt > bootStartedAt + 3000) return undefined;
  return { rebootCompleted: true, beforeBootId: record.beforeBootId, afterBootId, scheduledFor: record.scheduledFor, acceptedAt: record.acceptedAt, bootStartedAt, scheduleDigest: record.scheduleDigest, shutdownProofDigest: hash(shutdown), shutdownInitiatedAt, operationalHealthVerification: 'outstanding' };
}
