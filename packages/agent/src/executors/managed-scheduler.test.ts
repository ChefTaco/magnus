import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ManagedScheduler, makeCronJob, makeOccurrence, cronDue, schedulerSourceSettlementSigningPayload,
  type SchedulerAuthority } from './managed-scheduler.js';
import { exactManagedEntry, managedCronEntryAbsent, managedCronLine, removeCronEntry } from './cron-manager.js';
import { schedulerInventory } from './scheduler-inventory.js';
import { hash } from './execution-supervisor-state.js';
const exec = promisify(execFile);
let root: string; let store: ManagedScheduler;
const spec = () => ({ nodeFqdn: 'node.fixture.invalid', name: 'fixture', revision: 1, schedule: '* * * * *', timezone: 'UTC' as const,
  command: '/usr/bin/true', args: [], timeoutSeconds: 60, expiresAt: Date.now() + 300_000 });
const authority = (): SchedulerAuthority => ({
  admit: vi.fn(async row => ({ coordination: { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: row.deadline } })),
  execute: vi.fn(async row => ({ commandId: row.command.commandId, exitCode: 0, stdout: '', stderr: '', durationMs: 1, truncated: false, signature: 'a'.repeat(64) })),
  recover: vi.fn(async () => undefined), settle: vi.fn(async () => {}),
});
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'managed-cron-')); store = new ManagedScheduler(join(root, 'journal')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function save(value = spec()) { const job = makeCronJob(value); await store.locked(() => store.saveJob(job)); return job; }

describe('durable managed cron', () => {
  it('requires explicit finite authority and distinct canonical host IDs', () => {
    expect(() => makeCronJob({ ...spec(), expiresAt: undefined })).toThrow();
    expect(() => makeCronJob({ ...spec(), timeoutSeconds: Infinity })).toThrow();
    const first = makeCronJob(spec()); const second = makeCronJob({ ...spec(), nodeFqdn: 'other.fixture.invalid' });
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    expect(makeOccurrence(first, minute).occurrenceId).not.toBe(makeOccurrence(second, minute).occurrenceId);
  });
  it('validates numeric cron ranges and UTC day semantics', () => {
    expect(() => makeCronJob({ ...spec(), schedule: '60 * * * *' })).toThrow();
    expect(() => makeCronJob({ ...spec(), schedule: '*/0 * * * *' })).toThrow();
    expect(cronDue('0 6 * * *', Date.UTC(2026, 8, 21, 6))).toBe(true);
    expect(cronDue('0 6 * * *', Date.UTC(2026, 8, 21, 7))).toBe(false);
    expect(cronDue('0 6 1 * 1', Date.UTC(2026, 8, 21, 6))).toBe(true);
  });
  it('retains exact revision/digest, denies disabled/revised triggers', async () => {
    const job = await save();
    await expect(store.locked(() => store.saveJob(makeCronJob({ ...job.spec, command: '/bin/false' })))).rejects.toThrow('revision');
    await store.locked(() => store.disable(job.jobId));
    await expect(store.trigger(job.jobId, 1, authority())).rejects.toThrow('disabled');
  });
  it('activates and revokes only an exact staged identity', async () => {
    const job = makeCronJob(spec());
    await store.locked(() => store.saveJob({ ...job, enabled: false }));
    await expect(store.locked(() => store.setEnabled({ jobId: job.jobId, revision: 2, specSha256: job.specSha256 }, true))).rejects.toThrow('differs');
    expect((await store.job(job.jobId))?.enabled).toBe(false);
    await store.locked(() => store.setEnabled({ jobId: job.jobId, revision: job.spec.revision, specSha256: job.specSha256 }, true));
    expect((await store.job(job.jobId))?.enabled).toBe(true);
    await store.locked(() => store.setEnabled({ jobId: job.jobId, revision: job.spec.revision, specSha256: job.specSha256 }, false));
    expect((await store.job(job.jobId))?.enabled).toBe(false);
  });
  it('runs one occurrence once and retains terminal receipt across restart', async () => {
    const job = await save(); const auth = authority();
    const result = await store.trigger(job.jobId, 1, auth);
    expect(result.state).toBe('completed'); expect(result.settlementPending).toBe(false);
    expect((await new ManagedScheduler(store.root).trigger(job.jobId, 1, auth)).state).toBe('completed');
    expect(auth.execute).toHaveBeenCalledTimes(1); expect(auth.admit).toHaveBeenCalledTimes(1);
  });
  it('serializes racing independent journal instances before any authority call', async () => {
    const job = await save(); const auth = authority();
    await Promise.all([store.trigger(job.jobId, 1, auth), new ManagedScheduler(store.root).trigger(job.jobId, 1, auth)]);
    expect(auth.admit).toHaveBeenCalledTimes(1); expect(auth.execute).toHaveBeenCalledTimes(1);
  });
  it('never retries an admission with a lost acknowledgment or absent supervisor', async () => {
    const job = await save(); const auth = authority(); vi.mocked(auth.admit).mockRejectedValue(new Error('lost ack'));
    const row = await store.trigger(job.jobId, 1, auth); expect(row.state).toBe('unknown');
    expect((await new ManagedScheduler(store.root).trigger(job.jobId, 1, auth)).state).toBe('unknown');
    expect(auth.admit).toHaveBeenCalledTimes(1); expect(auth.execute).not.toHaveBeenCalled();
  });
  it('recovers original completion without new dispatch after requester failure', async () => {
    const job = await save(); const auth = authority(); let result: Awaited<ReturnType<SchedulerAuthority['execute']>> | undefined;
    auth.execute = vi.fn(async row => { result = { commandId: row.command.commandId, exitCode: 0, stdout: 'done', stderr: '', durationMs: 1, truncated: false, signature: 'a'.repeat(64) }; throw new Error('requester crash'); });
    const row = await store.trigger(job.jobId, 1, auth); expect(row.state).toBe('unknown');
    auth.recover = vi.fn(async () => result);
    const recovered = await new ManagedScheduler(store.root).recover(row.occurrenceId, auth);
    expect(recovered.state).toBe('completed'); expect(recovered.result?.stdout).toBe('done'); expect(auth.execute).toHaveBeenCalledTimes(1);
  });
  it('retries only durable settlement after a lost response', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 28, 12, 0, 1));
    const job = await save(); const auth = authority(); vi.mocked(auth.settle).mockRejectedValueOnce(new Error('lost ack'));
    const row = await store.trigger(job.jobId, 1, auth); expect(row.state).toBe('completed'); expect(row.settlementPending).toBe(true);
    expect((await store.recover(row.occurrenceId, auth)).settlementPending).toBe(false);
    expect(auth.execute).toHaveBeenCalledTimes(1); expect(auth.settle).toHaveBeenCalledTimes(2);
  });
  it('does not extend expiry or launch when job is canceled during admission', async () => {
    const job = await save(); const auth = authority();
    auth.admit = async row => { await store.locked(() => store.disable(job.jobId)); return { coordination: { version: 1, resourceKey: 'node:x', fence: '1', expiresAt: row.deadline } }; };
    expect((await store.trigger(job.jobId, 1, auth)).state).toBe('not-started'); expect(auth.execute).not.toHaveBeenCalled();
  });
  it('rejects authority that attempts to extend the original deadline', async () => {
    const job = await save(); const auth = authority();
    auth.admit = async row => ({ coordination: { version: 1, resourceKey: 'node:x', fence: '1', expiresAt: row.deadline + 1 } });
    expect((await store.trigger(job.jobId, 1, auth)).state).toBe('unknown'); expect(auth.execute).not.toHaveBeenCalled();
  });
  it('installs a fixed wrapper without command interpolation and replaces both marker and entry', async () => {
    const job = await save({ ...spec(), command: 'echo dangerous; false' });
    const line = managedCronLine(job, '/usr/bin/node', '/opt/magnus-agent/dist/executors/scheduler-runner.js');
    expect(line).not.toContain('dangerous'); expect(line).toContain('/usr/bin/env -i');
    expect(removeCronEntry('# MAGNUS:fixture\n* * * * * old-command\n# MAGNUS:fixture-extra\n* * * * * preserve\n', 'fixture')).toBe('# MAGNUS:fixture-extra\n* * * * * preserve\n');
    expect(exactManagedEntry('# MAGNUS:fixture\n' + line + '\n', 'fixture', line)).toBe(true);
    expect(exactManagedEntry('# MAGNUS:fixture\n' + line + '\n# MAGNUS:fixture\n' + line + '\n', 'fixture', line)).toBe(false);
    expect(exactManagedEntry('# MAGNUS:fixture\n' + line + '\n' + line + '\n', 'fixture', line)).toBe(false);
    expect(exactManagedEntry('# MAGNUS:other\n' + line + '\n', 'fixture')).toBe(true);
    expect(managedCronEntryAbsent('# MAGNUS:other\n' + line + '\n', job)).toBe(false);
    expect(managedCronEntryAbsent('# MAGNUS:other\n* * * * * /bin/true\n', job)).toBe(true);
  });
  it('retains native Hermes, raw cron and unavailable timers as explicit blockers', async () => {
    const spool = join(root, 'spool'); const home = join(root, 'home'); await mkdir(spool); await mkdir(join(home, '.hermes/cron'), { recursive: true });
    await writeFile(join(spool, 'root'), '* * * * * /bin/true\n* * * * * /bin/true\n');
    await writeFile(join(home, '.hermes/cron/jobs.json'), JSON.stringify([{ enabled: true }, { paused: true }]));
    const inventory = await schedulerInventory({ scheduler: store, spool, homes: [home], systemCrontab: join(root, 'absent'), systemDirectories: [], timers: async () => { throw new Error('denied'); } });
    expect(inventory.quiescent).toBe(false); expect(inventory.blockers.map(item => item.kind)).toEqual(['LEGACY_OR_UNSUPPORTED_CRONTAB', 'NATIVE_HERMES_SCHEDULES']);
    expect(inventory.blockers.find(item => item.kind === 'LEGACY_OR_UNSUPPORTED_CRONTAB')?.count).toBe(2);
    expect(inventory.issues).toContain('SYSTEM_TIMER_INVENTORY_UNAVAILABLE');
    expect(JSON.stringify(inventory)).not.toContain('/bin/true');
  });
  it('settles only an exact retained foreign source under the active drain barrier and re-adds recurrence', async () => {
    const settlementStore = new ManagedScheduler(store.root, 'node.fixture.invalid');
    const identity = { nodeId: 'fixture-node', nodeFqdn: 'node.fixture.invalid', epoch: 1,
      barrierId: '00000000-0000-4000-8000-000000000001' };
    const source = { kind: 'SYSTEM_CRONTAB', sourceSha256: 'b'.repeat(64), count: 2 };
    await settlementStore.drain(identity); await settlementStore.observeDiscovery([], [source]);
    const assertion = { version: 1 as const, sourceIdentityVersion: 2 as const, ...identity, ...source, disposition: 'no_effect_verified' as const,
      evidenceSha256: 'c'.repeat(64), approvalRef: 'telegram:fixture',
      decisionId: '00000000-0000-4000-8000-000000000002', expiresAt: Date.now() + 60_000, signature: 'd'.repeat(64) };
    const sign = () => 'f'.repeat(64);
    const first = await settlementStore.settleForeignSource(assertion, sign);
    expect(first.replayed).toBe(false); expect(first.receipt).toMatchObject({ settled: true, replayed: false, receiptSignature: 'f'.repeat(64) });
    expect(await new ManagedScheduler(store.root, 'node.fixture.invalid').settlementReceipt(assertion.decisionId)).toEqual(first.receipt);
    const replay = await settlementStore.settleForeignSource(assertion, () => { throw new Error('must retain original signature'); });
    expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.receipt);
    await expect(settlementStore.settleForeignSource({ ...assertion, evidenceSha256: 'e'.repeat(64) }, sign)).rejects.toThrow('reused');
    expect((await settlementStore.observeDiscovery([], [])).foreignSources).toEqual([]);
    expect((await settlementStore.observeDiscovery([], [source])).foreignSources).toEqual([{ ...source, identityVersion: 2 }]);
  });
  it('migrates every pre-v2 foreign identity to an explicit legacy blocker that cannot be settled', async () => {
    const settlementStore = new ManagedScheduler(store.root, 'node.fixture.invalid');
    const identity = { nodeId: 'fixture-node', nodeFqdn: 'node.fixture.invalid', epoch: 1,
      barrierId: '00000000-0000-4000-8000-000000000021' };
    const source = { kind: 'USER_TIMER_DEFINITION', sourceSha256: '9'.repeat(64), count: 1 };
    await settlementStore.drain(identity);
    await writeFile(join(store.root, 'scheduler-discovery.json'), JSON.stringify({ version: 1, hermesRoots: [],
      foreignSources: [source], settlements: [], settlementTombstones: [] }), { mode: 0o600 });
    const migrated = await settlementStore.observeDiscovery([], []);
    expect(migrated.foreignSources).toEqual([]); expect(migrated.legacyForeignSources).toEqual([source]);
    const assertion = { version: 1 as const, sourceIdentityVersion: 2 as const, ...identity, ...source, disposition: 'no_effect_verified' as const,
      evidenceSha256: '8'.repeat(64), approvalRef: 'fixture', decisionId: '00000000-0000-4000-8000-000000000022',
      expiresAt: Date.now() + 60_000, signature: '7'.repeat(64) };
    await expect(settlementStore.settleForeignSource(assertion, () => '6'.repeat(64)))
      .rejects.toThrow('differs');
    expect((await settlementStore.observeDiscovery([], [])).legacyForeignSources).toEqual([source]);
    const inventory = await schedulerInventory({ scheduler: settlementStore, homes: [], spool: join(root, 'absent-spool'),
      systemCrontab: join(root, 'absent-cron'), systemDirectories: [], timers: async () => '' });
    expect(inventory.issues.some(value => value.startsWith('LEGACY_SCHEDULER_IDENTITY_UNRECONCILABLE'))).toBe(true);
    expect(inventory.blockers.some(value => value.kind === 'LEGACY_SCHEDULER_IDENTITY_UNRECONCILABLE')).toBe(true);
  });
  it('compacts only aged receipts into bounded decision tombstones', async () => {
    const settlementStore = new ManagedScheduler(store.root, 'node.fixture.invalid');
    const identity = { nodeId: 'fixture-node', nodeFqdn: 'node.fixture.invalid', epoch: 1,
      barrierId: '00000000-0000-4000-8000-000000000011' };
    const source = { kind: 'SYSTEM_CRONTAB', sourceSha256: '1'.repeat(64), count: 1 };
    await settlementStore.drain(identity); await settlementStore.observeDiscovery([], [source]);
    const expiresAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const receipt = (index: number) => ({ version: 1 as const, sourceIdentityVersion: 2 as const, ...identity, kind: 'SYSTEM_CRONTAB',
      sourceSha256: index.toString(16).padStart(64, '0'), count: 1, disposition: 'no_effect_verified' as const,
      evidenceSha256: '2'.repeat(64), approvalRef: 'fixture',
      decisionId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`, expiresAt,
      settled: true as const, replayed: false as const, receiptSignature: '3'.repeat(64) });
    const recordPath = join(store.root, 'scheduler-discovery.json');
    await writeFile(recordPath, JSON.stringify({ version: 2, hermesRoots: [], foreignSources: [{ ...source, identityVersion: 2 }],
      legacyForeignSources: [], settlements: Array.from({ length: 128 }, (_, index) => receipt(index + 100)),
      legacySettlements: [], settlementTombstones: [] }), { mode: 0o600 });
    const assertion = { version: 1 as const, sourceIdentityVersion: 2 as const, ...identity, ...source, disposition: 'effects_verified' as const,
      evidenceSha256: '4'.repeat(64), approvalRef: 'fixture', decisionId: '00000000-0000-4000-8000-000000000999',
      expiresAt: Date.now() + 60_000, signature: '5'.repeat(64) };
    await settlementStore.settleForeignSource(assertion, () => '6'.repeat(64));
    const compacted = receipt(100);
    expect(await settlementStore.settlementReceipt(compacted.decisionId)).toBeUndefined();
    const { settled: _settled, replayed: _replayed, receiptSignature: _receiptSignature, ...compactedAssertion } = compacted;
    await expect(settlementStore.settleForeignSource({ ...compactedAssertion, signature: '7'.repeat(64) }, () => '8'.repeat(64)))
      .rejects.toThrow('compacted');
    const journal = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(journal.settlements).toHaveLength(128); expect(journal.settlementTombstones).toHaveLength(1);
    expect(journal.settlementTombstones[0]).toEqual({ decisionId: compacted.decisionId,
      assertionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(journal.settlementTombstones[0].assertionSha256).toBe(hash(schedulerSourceSettlementSigningPayload(compactedAssertion)));
  });
  it('proves a clean bounded fixture inventory without assuming missing native evidence', async () => {
    const job = await save(); const spool = join(root, 'spool'); await mkdir(spool);
    await writeFile(join(spool, 'root'), '# MAGNUS:fixture\n' + managedCronLine(job) + '\n');
    const value = await schedulerInventory({ scheduler: store, spool, homes: [], systemCrontab: join(root, 'absent'), systemDirectories: [], timers: async () => '', managedUser: 'root', wrapper: managedCronLine });
    expect(value.quiescent).toBe(true);
  });
  it('uses kernel locking in two installed Node processes with one finite local effect', async () => {
    const job = await save(); const counter = join(root, 'counter');
    const program = `import { ManagedScheduler } from ${JSON.stringify('file://' + resolve('dist/executors/managed-scheduler.js'))};
      import {appendFile} from 'node:fs/promises';
      const authority={admit:async r=>({coordination:{version:1,resourceKey:'node:fixture',fence:'1',expiresAt:r.deadline}}),
      execute:async r=>{await appendFile(${JSON.stringify(counter)},'once\\n');return {commandId:r.command.commandId,exitCode:0,stdout:'',stderr:'',durationMs:1,truncated:false,signature:'a'.repeat(64)}},recover:async()=>undefined,settle:async()=>{}};
      const r=await new ManagedScheduler(${JSON.stringify(store.root)}).trigger(${JSON.stringify(job.jobId)},1,authority);console.log(r.state);`;
    await Promise.all([exec(process.execPath, ['--input-type=module', '-e', program], { timeout: 10_000 }), exec(process.execPath, ['--input-type=module', '-e', program], { timeout: 10_000 })]);
    expect(await readFile(counter, 'utf8')).toBe('once\n');
  });
});
