import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManagedScheduler, makeCronJob, type SchedulerAuthority } from './managed-scheduler.js';
import { schedulerDrainRoutes, canonicalSchedulerEvidence } from './scheduler-drain.js';
import { schedulerAuthority } from './scheduler-authority.js';
import { managedCronLine } from './cron-manager.js';
const key = 'scheduler-drain-result-fixture-at-least-32';
vi.mock('../env.js', () => ({ HOST_FQDN: 'scheduler.fixture.invalid', NODE_MANAGER_SECRET: 'scheduler-fixture-node', NODE_MANAGER_SECRET_PREVIOUS: '',
  RESULT_SIGNING_SECRET: 'scheduler-drain-result-fixture-at-least-32', CONTROL_API_URL: 'https://authority.fixture.invalid', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: false }));
let root: string; let scheduler: ManagedScheduler;
const descriptor = () => ({ version: 1 as const, participant: 'scheduler' as const, nodeId: 'fixture', nodeFqdn: 'scheduler.fixture.invalid', epoch: 1,
  barrierId: randomUUID(), challengeId: randomUUID(), expiresAt: Date.now() + 30_000 });
const jobSpec = () => ({ nodeFqdn: 'scheduler.fixture.invalid', name: 'managed', revision: 1, schedule: '* * * * *', timezone: 'UTC',
  command: '/bin/true', timeoutSeconds: 3600, expiresAt: Date.now() + 3_600_000 });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'scheduler-drain-')); scheduler = new ManagedScheduler(join(root, 'journal')); await mkdir(join(root, 'spool')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function route(value = descriptor(), override?: unknown, recover?: (id: string) => Promise<unknown>, home?: string) {
  const status = vi.fn(async (request: { nodeFqdn: string; nonce: string }) => ({ version: 1 as const, nodeId: value.nodeId, nodeFqdn: value.nodeFqdn,
    nonce: request.nonce, state: 'draining' as const, epoch: value.epoch, barrierId: value.barrierId,
    schedulerChallenge: { challengeId: value.challengeId, expiresAt: value.expiresAt }, ...override as object }));
  const app = schedulerDrainRoutes({ scheduler, status, recover, inventory: { spool: join(root, 'spool'), systemCrontab: join(root, 'absent'),
    systemDirectories: [], homes: home ? [home] : [], timers: async () => '', managedUser: 'root', wrapper: managedCronLine } });
  return { app, status, value };
}
async function send(fixture: ReturnType<typeof route>, value = fixture.value, authenticated = true) {
  return fixture.app.request('/enrollment-drain', { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-node-token': 'scheduler-fixture-node' } : {}) }, body: JSON.stringify(value) });
}
describe('authoritative scheduler drain', () => {
  it('authenticates native callers before looking up the API challenge', async () => {
    const fixture = route(); expect((await send(fixture, fixture.value, false)).status).toBe(401); expect(fixture.status).not.toHaveBeenCalled();
  });
  it('signs a current empty observed fixture, then rejects future trigger and sync after restart', async () => {
    const job = makeCronJob(jobSpec()); await scheduler.locked(() => scheduler.saveJob(job));
    await writeFile(join(root, 'spool/root'), '# MAGNUS:managed\n' + managedCronLine(job) + '\n');
    const fixture = route(); const response = await send(fixture); expect(response.status).toBe(200);
    const { signature, ...receipt } = await response.json() as Record<string, unknown>;
    expect(receipt['status']).toBe('managed-drained'); expect(receipt['scope']).toBe('magnus-managed-scheduler-only');
    expect(receipt['activeCount']).toBe(0); expect(receipt['unknownCount']).toBe(0); expect(receipt['externalBlockers']).toEqual([]);
    expect(signature).toBe(createHmac('sha256', key).update('magnus.resource-enrollment.v1\n' + canonicalSchedulerEvidence(receipt)).digest('hex'));
    const restarted = new ManagedScheduler(scheduler.root); const authority = { admit: vi.fn() } as unknown as SchedulerAuthority;
    await expect(restarted.trigger(job.jobId, 1, authority)).rejects.toThrow('draining'); expect(authority.admit).not.toHaveBeenCalled();
    await expect(restarted.locked(() => restarted.saveJob(job))).rejects.toThrow('draining');
  });
  it('reopens managed scheduling only after exact fresh enrollment and preserves the legacy fence across restart', async () => {
    const job = makeCronJob(jobSpec()); await scheduler.locked(() => scheduler.saveJob(job));
    const value = descriptor(); const identity = { nodeId: value.nodeId, nodeFqdn: value.nodeFqdn, epoch: value.epoch, barrierId: value.barrierId };
    await scheduler.drain(identity);
    const enrolled = (override: object = {}) => schedulerAuthority({ status: async request => ({ version: 1, ...identity,
      nonce: request.nonce, state: 'enrolled', schedulerChallenge: null, ...override }) });
    for (const override of [{ state: 'draining' }, { nonce: randomUUID() }, { epoch: 2 }, { nodeId: 'foreign' }, { barrierId: randomUUID() }, { nodeFqdn: 'foreign.invalid' }]) {
      await scheduler.confirmEnrollment(enrolled(override));
      await expect(scheduler.locked(() => scheduler.saveJob(job))).rejects.toThrow('draining');
    }
    await scheduler.confirmEnrollment(enrolled());
    const restarted = new ManagedScheduler(scheduler.root);
    await restarted.locked(() => restarted.saveJob(job));
    const authority: SchedulerAuthority = {
      admit: vi.fn(async row => ({ coordination: { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: row.deadline } })),
      execute: vi.fn(async row => ({ commandId: row.command.commandId, exitCode: 0, stdout: '', stderr: '', durationMs: 1, truncated: false, signature: 'a'.repeat(64) })),
      recover: async () => undefined, settle: async () => {},
    };
    expect((await restarted.trigger(job.jobId, 1, authority)).state).toBe('completed');
    expect(authority.admit).toHaveBeenCalledTimes(1); expect(authority.execute).toHaveBeenCalledTimes(1);
    await expect(restarted.locked(() => restarted.assertOpen())).rejects.toThrow('draining');
    expect((await restarted.inventory()).barrier).toEqual(identity);
    await expect(restarted.drain(identity)).rejects.toThrow('already enrolled');
  });
  it('rejects stale, forged and cross-host descriptors without installing their barrier', async () => {
    for (const override of [{ epoch: 2 }, { nodeId: 'other' }, { state: 'legacy' }, { schedulerChallenge: null }]) {
      const fixture = route(descriptor(), override); expect((await send(fixture)).status).toBe(409);
      expect((await scheduler.inventory()).barrier).toBeNull();
    }
    const fixture = route(); expect((await send(fixture, { ...fixture.value, nodeFqdn: 'other.invalid' })).status).toBe(409);
  });
  it('retains unknown original work and never invokes a fresh trigger to drain', async () => {
    const job = makeCronJob(jobSpec()); await scheduler.locked(() => scheduler.saveJob(job));
    const authority: SchedulerAuthority = { admit: async () => { throw new Error('lost grant'); }, execute: vi.fn(), recover: async () => undefined, settle: async () => {} };
    const row = await scheduler.trigger(job.jobId, 1, authority);
    await writeFile(join(root, 'spool/root'), managedCronLine(job) + '\n');
    const recover = vi.fn(async id => scheduler.recover(id, authority)); const fixture = route(descriptor(), undefined, recover);
    const result = await (await send(fixture)).json() as { status: string; unknownCount: number };
    expect(result.status).toBe('pending'); expect(result.unknownCount).toBeGreaterThan(0); expect(recover).toHaveBeenCalledWith(row.occurrenceId); expect(authority.execute).not.toHaveBeenCalled();
  });
  it('reports raw cron as external work without claiming to drain it', async () => {
    await writeFile(join(root, 'spool/root'), '* * * * * legacy-command\n');
    const result = await (await send(route())).json() as { status: string; unknownCount: number; externalBlockers: Array<{ kind: string }> };
    expect(result.status).toBe('managed-drained'); expect(result.unknownCount).toBe(0);
    expect(result.externalBlockers.map(row => row.kind)).toContain('LEGACY_OR_UNSUPPORTED_CRONTAB');
  });
  it('does not classify a missing Magnus trigger as external work', async () => {
    const job = makeCronJob(jobSpec()); await scheduler.locked(() => scheduler.saveJob(job));
    const result = await (await send(route())).json() as { status: string; unknownCount: number; externalBlockers: Array<{ kind: string }> };
    expect(result.status).toBe('pending'); expect(result.unknownCount).toBeGreaterThan(0);
    expect(result.externalBlockers.map(row => row.kind)).not.toContain('MANAGED_TRIGGER_MISSING');
  });
  it('reports a retained Hermes claim as external uncertainty for explicit review', async () => {
    const home = join(root, 'home'); await mkdir(join(home, '.hermes/cron'), { recursive: true });
    await writeFile(join(home, '.hermes/cron/jobs.json'), JSON.stringify([{ enabled: true, run_claim: { at: 1 } }]));
    const result = await (await send(route(descriptor(), undefined, undefined, home))).json() as {
      status: string; unknownCount: number; externalBlockers: Array<{ kind: string; count: number }> };
    expect(result.status).toBe('managed-drained'); expect(result.unknownCount).toBe(0);
    expect(result.externalBlockers).toContainEqual(expect.objectContaining({ kind: 'NATIVE_HERMES_UNSETTLED_CLAIMS', count: 1 }));
  });
  it('serializes drain against a racing trigger claim without false quiescence', async () => {
    const job = makeCronJob(jobSpec()); await scheduler.locked(() => scheduler.saveJob(job));
    const identity = descriptor(); const authority: SchedulerAuthority = { admit: async () => { throw new Error('no dispatch'); }, execute: vi.fn(), recover: async () => undefined, settle: async () => {} };
    await Promise.allSettled([scheduler.trigger(job.jobId, 1, authority), scheduler.drain({ nodeId: identity.nodeId, nodeFqdn: identity.nodeFqdn, epoch: identity.epoch, barrierId: identity.barrierId })]);
    const snapshot = await scheduler.inventory(); expect(snapshot.barrier?.barrierId).toBe(identity.barrierId);
    expect(snapshot.occurrences.every(row => row.state === 'unknown')).toBe(true); expect(authority.execute).not.toHaveBeenCalled();
  });
});
