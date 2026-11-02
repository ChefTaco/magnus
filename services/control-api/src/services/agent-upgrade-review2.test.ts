/** Regressions from the second independent review: wrong stops and wrong verdicts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const logAuditEvent = vi.fn(async (_event: { action: string; details?: Record<string, unknown> }) => undefined);
vi.mock('./audit-service.js', () => ({ logAuditEvent }));
const db = vi.hoisted(() => ({
  node: { findMany: vi.fn(), findUnique: vi.fn(async () => ({ metadata: '{}' })), update: vi.fn() },
  agent: { findUnique: vi.fn(async () => null), updateMany: vi.fn() },
  commandResourceLease: { groupBy: vi.fn(async () => []) },
  resourceParticipantWork: { groupBy: vi.fn(async () => []) },
  managedCronDefinition: { groupBy: vi.fn(async () => []) },
}));
vi.mock('../db/client.js', () => ({ getDb: () => db }));
vi.mock('../config/features.js', () => ({ upgradeSettings: () => ({ agentUpgrades: true, agentUpgradeConcurrency: 2, agentUpgradeMaxFailures: 2, updateRegistry: 'https://registry.example.com' }) }));
const service = await import('./agent-upgrade-service.js');
const { AgentResponseError, DispatchOutcomeUnknownError } = await import('../sdk/node-api-client.js');
const { upgradeRemedy } = await import('@hivemagnus/magnus-contracts');
import type { NodeRunState, RunNode, StoredSelfUpgrade, UpgradeDeps, UpgradeRun } from './agent-upgrade-service.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const makeRun = (ids: string[], extra: Partial<UpgradeRun> = {}): UpgradeRun => ({ id: 'r', version: '1.1.8', integrity: 'x', actorId: 'a', status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
  concurrency: 2, message: null, maxFailures: 2, ...extra, nodes: ids.map(id => ({ nodeId: id, name: id, from: '1.1.7', state: 'pending', requestId: `req-${id}`, detail: null })) });
const confirmed = (id: string) => ({ version: '1.1.8', report: { upgrade: { state: 'confirmed', requestId: `req-${id}` }, confirmSeconds: 180 } as StoredSelfUpgrade, lastHeartbeatAt: new Date() });
function deps(over: Partial<UpgradeDeps> = {}, clock = { t: 1e12 }): UpgradeDeps {
  return { request: async () => undefined, observe: async () => ({ version: '1.1.7', report: null, lastHeartbeatAt: new Date(clock.t) }), check: async () => null, sleep: async ms => { clock.t += ms; },
    now: () => clock.t, save: async () => undefined, stopRequested: async () => null, confirmTimeoutMs: service.confirmWindowMs(null), pollMs: 5_000, retryBackoffMs: [1, 1], ...over };
}
const uncertain = () => new AgentResponseError(409, { code: 'MANAGED_MUTATION_UNCERTAIN', message: 'x' });
const row = (id: string, version: string, extra: Record<string, unknown> = {}) => ({ id, name: id, hostname: `${id}.example.com`, status: 'ONLINE', lastHeartbeatAt: new Date(), agent: { version },
  metadata: JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, observedAt: new Date().toISOString(), upgrade: { state: 'idle', to: version } } }), resourceEnrollment: { state: 'enrolled', nodeFqdn: `${id}.example.com`, startedAt: null, updatedAt: new Date() }, admissionFence: null, ...extra });
const unavailable = async () => ({ status: 'unavailable' as const, checkedAt: new Date().toISOString(), problems: [], detail: 'older agent' });
const report = { status: 'ok' as const, checkedAt: new Date(0).toISOString(), problems: [] };

beforeEach(() => { logAuditEvent.mockClear(); vi.spyOn(console, 'warn').mockImplementation(() => undefined); db.commandResourceLease.groupBy.mockImplementation((async () => []) as never); });

describe('finding 1: staging time does not eat the confirmation window', () => {
  it('confirms a healthy canary whose stage took seven minutes', async () => {
    const clock = { t: 1e12 };
    const done = new Map<string, number>();
    const run = await service.executeUpgradeRun(makeRun(['slow', 'b', 'c']), deps({
      request: async id => { if (id === 'slow') clock.t += 7 * 60_000; done.set(id, clock.t); },
      observe: async id => clock.t - (done.get(id) ?? clock.t) >= 30_000 ? confirmed(id) : { version: '1.1.7', report: { upgrade: { state: 'staged', requestId: `req-${id}` }, confirmSeconds: 180 } as StoredSelfUpgrade, lastHeartbeatAt: new Date(clock.t) },
    }, clock));
    expect(run.nodes.map(node => node.state)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(run.status).toBe('succeeded');
  });

  it('still times out a trial that never confirms, a full window after the reply', async () => {
    const clock = { t: 1e12 };
    const base = deps({ request: async () => { clock.t += 7 * 60_000; } }, clock);
    const run = await service.executeUpgradeRun(makeRun(['a']), base);
    expect(run.nodes[0]).toMatchObject({ state: 'failed', code: 'CONFIRM_TIMEOUT' });
    expect(clock.t - 1e12).toBeGreaterThanOrEqual(7 * 60_000 + service.confirmWindowMs(null));
  });

  it('does not hand off a canary whose reply was lost while it may still be staging or restarting', async () => {
    const clock = { t: 1e12 };
    const asked: Array<[string, number]> = [];
    const run = await service.executeUpgradeRun(makeRun(['a', 'b', 'c']), deps({ request: async id => {
      asked.push([id, clock.t - 1e12]);
      clock.t += 7 * 60_000;
      throw new DispatchOutcomeUnknownError('socket hang up');
    } }, clock));
    // The stage may run to its 13 minute budget after the socket died, and the trial starts after that.
    const wait = asked[1]![1] - asked[0]![1];
    expect(wait).toBeGreaterThanOrEqual(7 * 60_000 + service.confirmWindowMs(null) + 10 * 60_000);
    expect(run.status).toBe('failed');
  });

  it('an uncertain ANSWER is not a request still in flight: it hands off after the window alone', async () => {
    const clock = { t: 1e12 };
    const asked: Array<[string, number]> = [];
    await service.executeUpgradeRun(makeRun(['a', 'b', 'c']), deps({ request: async id => { asked.push([id, clock.t - 1e12]); if (id === 'a') throw uncertain(); },
      observe: async id => id === 'a' ? { version: '1.1.7', report: null, lastHeartbeatAt: new Date(clock.t) } : confirmed(id) }, clock));
    expect(asked[1]![1] - asked[0]![1]).toBeLessThan(service.confirmWindowMs(null) + 60_000);
  });

  it('after the canary, a lost reply still frees its batch slot at the window', async () => {
    const clock = { t: 1e12 };
    const asked = new Map<string, number>();
    await service.executeUpgradeRun(makeRun(['ok', 'lost', 'x', 'y']), { ...deps({ request: async id => { asked.set(id, clock.t); if (id === 'lost') throw new DispatchOutcomeUnknownError('reset'); },
      observe: async id => id === 'lost' ? { version: '1.1.7', report: null, lastHeartbeatAt: new Date(clock.t) } : confirmed(id) }, clock), });
    expect(asked.get('y')! - asked.get('lost')!).toBeLessThan(service.confirmWindowMs(null) + 10 * 60_000);
  });
});

describe('finding 2: old agents with a stale fence must not stop a healthy wave', () => {
  const start = (extra: Partial<Parameters<typeof service.startUpgradeRun>[0]> = {}, over: Partial<UpgradeDeps> = {}) => {
    const store = service.memoryRunStore();
    return service.startUpgradeRun({ version: '1.1.8', integrity: INTEGRITY, actorId: 'admin', store, deps: deps(over), ...extra }).then(started => ({ ...started, store }));
  };
  const history = (...ids: string[]) => db.commandResourceLease.groupBy.mockImplementation((async () => ids.map(nodeId => ({ nodeId, state: 'released', _count: { _all: 1 } }))) as never);
  const preflight = async (target: { nodeId: string }) => target.nodeId.startsWith('new') ? report : await unavailable();

  it('orders the queue: current agents, then old agents with no lease history, then those that cannot report their fence', async () => {
    db.node.findMany.mockImplementation(async () => [row('a-old-history', '1.1.7'), row('b-old-clean', '1.1.7'), row('new-c', '1.1.9', {}), row('new-d', '1.1.9', {})]);
    history('a-old-history');
    const { run, done } = await start({ version: '1.1.10' }, { preflight, observe: async id => confirmed(id) });
    expect(run.nodes.map(node => node.nodeId)).toEqual(['new-c', 'new-d', 'b-old-clean', 'a-old-history']);
    expect(run.nodes.find(node => node.nodeId === 'a-old-history')?.fenceUnreported).toBe(true);
    await done;
  });

  it('keeps an explicit canary first', async () => {
    db.node.findMany.mockImplementation(async () => [row('a-old', '1.1.7'), row('new-b', '1.1.9')]);
    history('a-old');
    const { run, done } = await start({ version: '1.1.10', canaryNodeId: 'a-old' }, { preflight, observe: async id => confirmed(id) });
    expect(run.nodes[0]?.nodeId).toBe('a-old');
    await done;
  });

  it('two stale old agents plus healthy nodes keeps going, whatever their names', async () => {
    db.node.findMany.mockImplementation(async () => [row('a-old', '1.1.7'), row('b-old', '1.1.7'), row('new-c', '1.1.9'), row('new-d', '1.1.9'), row('new-e', '1.1.9')]);
    history('a-old', 'b-old');
    const seen = new Map<string, string>();
    const { run: started, done } = await start({ version: '1.1.10' }, { preflight, request: async (id, body) => { seen.set(id, body.requestId); if (id.includes('old')) throw uncertain(); },
      observe: async id => seen.has(id) && id.startsWith('new') ? { version: '1.1.10', report: { upgrade: { state: 'confirmed', requestId: seen.get(id) } } as StoredSelfUpgrade } : { version: '1.1.7', report: null, lastHeartbeatAt: new Date(1e13) } });
    const run = await done;
    expect(started.canaryNodeId).toBe('new-c');
    expect(run.nodes.filter(node => node.nodeId.startsWith('new')).map(node => node.state)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(run).toMatchObject({ status: 'partial', suspectedRelease: null });
  });

  it('a node that cannot report its fence does not count while another may still confirm', async () => {
    const asked: string[] = [];
    // One clean ambiguous node and one fence-unreported one do not add up while a clean node may still confirm.
    const mixed = makeRun(['f1', 'clean', 'c2']);
    Object.assign(mixed.nodes[0]!, { fenceUnreported: true });
    const result = await service.executeUpgradeRun(mixed, deps({ request: async id => { asked.push(id); if (id !== 'c2') throw uncertain(); }, observe: async id => id === 'c2' ? confirmed(id) : { version: '1.1.7', report: null, lastHeartbeatAt: new Date(1e13) } }));
    expect(asked).toEqual(['f1', 'clean', 'c2']);
    expect(result).toMatchObject({ status: 'partial', suspectedRelease: null });
  });

  it('a bad release on old agents that all have lease history still stops: the walk is bounded, and says what else it could be', async () => {
    const run = makeRun(['f1', 'f2', 'f3', 'f4']);
    for (const node of run.nodes) node.fenceUnreported = true;
    const asked: string[] = [];
    const result = await service.executeUpgradeRun(run, deps({ request: async id => { asked.push(id); throw uncertain(); }, observe: async () => ({ version: '1.1.7', report: null, lastHeartbeatAt: new Date(1e13) }) }));
    expect(asked).toEqual(['f1', 'f2']);
    expect(result).toMatchObject({ status: 'failed', message: expect.stringMatching(/suspect but unproven.*stale fence.*agents fence/s) });
    expect(result.nodes[2]).toMatchObject({ state: 'skipped', code: 'NOT_REACHED' });
  });

  it('a bad release walking clean old agents stops as before', async () => {
    const asked: string[] = [];
    const result = await service.executeUpgradeRun(makeRun(['o1', 'o2', 'o3']), deps({ request: async id => { asked.push(id); throw uncertain(); }, observe: async () => ({ version: '1.1.7', report: null, lastHeartbeatAt: new Date(1e13) }) }));
    expect(asked).toEqual(['o1', 'o2']);
    expect(result.status).toBe('failed');
  });

  it('a retry of a suspected run strands no further old node unless someone acknowledges it', async () => {
    const rows = [row('o1', '1.1.7'), row('o2', '1.1.7'), row('o3', '1.1.7'), row('o4', '1.1.7'), row('new-n', '1.1.9')];
    db.node.findMany.mockImplementation((async ({ where }: { where: { id?: { in?: string[] } } }) => rows.filter(item => !where.id?.in || where.id.in.includes(item.id))) as never);
    db.commandResourceLease.groupBy.mockImplementation((async () => ['o1', 'o2'].map(nodeId => ({ nodeId, state: 'unknown', _count: { _all: 1 } }))) as never);
    const store = service.memoryRunStore();
    const previous = makeRun(['o1', 'o2', 'o3', 'o4', 'new-n'], { id: 'prev', status: 'failed', integrity: INTEGRITY, version: '1.1.10', finishedAt: 'x', suspectedRelease: 'the release is suspect but unproven' });
    for (const node of previous.nodes.slice(0, 2)) Object.assign(node, { state: 'ambiguous', code: 'MANAGED_MUTATION_UNCERTAIN' });
    for (const node of previous.nodes.slice(2)) Object.assign(node, { state: 'skipped', code: 'NOT_REACHED' });
    await store.save(previous);
    const asked: string[] = [];
    const over: Partial<UpgradeDeps> = { preflight, request: async (id: string) => { asked.push(id); }, observe: async (id: string) => confirmed(id), save: saved => store.save(saved) };
    const { run, done } = await service.retryUpgradeRun('prev', { actorId: 'admin', store, deps: deps(over) });
    expect(run.nodes.map(node => node.nodeId)).toEqual(['new-n']);
    expect(run.excluded?.filter(node => node.code === 'RETRY_HELD_SUSPECTED').map(node => node.nodeId).sort()).toEqual(['o3', 'o4']);
    await done;
    expect(asked).toEqual(['new-n']);
    // Holding them carries over from retry to retry, until someone says otherwise.
    await expect(service.retryUpgradeRun(run.id, { actorId: 'admin', store, deps: deps(over) })).rejects.toMatchObject({ code: 'NO_ELIGIBLE_AGENTS' });
    const acknowledged = await service.retryUpgradeRun(run.id, { actorId: 'admin', store, deps: deps(over), acknowledgeSuspicion: true });
    expect(acknowledged.run.nodes.map(node => node.nodeId).sort()).toEqual(['o3', 'o4']);
    await acknowledged.done;
  });
});

describe('finding 5: succeeded with a reverted node', () => {
  it('counts a node that already reverted this version', async () => {
    const run = await service.executeUpgradeRun(makeRun(['b'], { excluded: [{ nodeId: 'a', name: 'a', reason: 'reverted 1.1.8', code: 'ALREADY_REVERTED' }] }), deps({ observe: async id => confirmed(id) }));
    expect(run.status).toBe('partial');
    expect(run.attention?.map(item => item.code)).toEqual(['ALREADY_REVERTED']);
  });

  it('checks trial state before already current: a node on trial is not finished', () => {
    const trial = JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, observedAt: new Date().toISOString(), upgrade: { state: 'trial', from: '1.1.7', to: '1.1.8' } } });
    const candidate = service.classifyCandidate(row('n', '1.1.8', { metadata: trial }) as never, '1.1.8', { leasesRequested: false });
    expect(candidate.code).toBe('UPGRADE_IN_PROGRESS');
    expect(upgradeRemedy('UPGRADE_IN_PROGRESS').informational).toBeFalsy();
    const finished = { ...makeRun([]), nodes: [{ nodeId: 'a', name: 'a', from: '1', state: 'confirmed' as const, requestId: 'q', detail: null }], excluded: [{ nodeId: 'n', name: 'n', reason: 'r', code: candidate.code }] };
    expect(service.finalStatus(finished)).toBe('partial');
  });

  it('holds the invariant over generated mixes that include them', () => {
    const states: NodeRunState[] = ['pending', 'requested', 'watching', 'ambiguous', 'confirmed', 'reverted', 'failed', 'refused', 'skipped'];
    const codes: Array<string | null> = [null, 'ALREADY_REVERTED', 'UPGRADE_IN_PROGRESS', 'ALREADY_CURRENT', 'SELF_UPGRADE_DISABLED', 'NOT_REACHED', 'SELF_UPGRADE_ENV_DISK', 'RETRY_HELD_SUSPECTED', 'FENCE_UNREPORTED', 'SELF_UPGRADE_REVERTED'];
    let seed = 2463534242n;
    const next = (limit: number) => { seed ^= (seed << 13n) & 0xffffffffffffffffn; seed ^= seed >> 7n; seed ^= (seed << 17n) & 0xffffffffffffffffn; return Number(seed % BigInt(limit)); };
    const expected = new Set(['ALREADY_CURRENT', 'SELF_UPGRADE_DISABLED']);
    let succeeded = 0;
    for (let round = 0; round < 5000; round++) {
      const nodes: RunNode[] = Array.from({ length: 1 + next(4) }, (_, index) => ({ nodeId: `n${index}`, name: `n${index}`, from: '1.1.7', state: states[next(states.length)]!, requestId: `q${index}`, detail: null, code: codes[next(codes.length)] ?? null }));
      const excluded = Array.from({ length: next(3) }, (_, index) => ({ nodeId: `x${index}`, name: `x${index}`, reason: 'r', code: codes[next(codes.length)] ?? null }));
      const run = { ...makeRun([]), nodes, excluded };
      const ok = nodes.every(node => node.state === 'confirmed' || (['refused', 'skipped'].includes(node.state) && expected.has(node.code ?? ''))) && excluded.every(node => expected.has(node.code ?? ''));
      if (service.finalStatus(run) === 'succeeded') { succeeded += 1; expect(ok, JSON.stringify({ nodes, excluded })).toBe(true); }
    }
    expect(succeeded).toBeGreaterThan(0);
  });
});

describe('finding 6: identical refusals that name their own node-level cause', () => {
  const refuseAll = (code: string) => service.executeUpgradeRun(makeRun(['a', 'b']), deps({ request: async () => { throw new AgentResponseError(422, { code, message: 'x' }); } }));
  it.each(['SELF_UPGRADE_ENV_DISK', 'SELF_UPGRADE_ENV_ACCESS', 'SELF_UPGRADE_ENV_TLS', 'SELF_UPGRADE_ENV_AUTH', 'SELF_UPGRADE_ENV_RESOURCE', 'SELF_UPGRADE_TIMEOUT', 'LEDGER_UNAVAILABLE'])('does not suspect the release for %s', async code => {
    const run = await refuseAll(code);
    expect(run).toMatchObject({ status: 'partial', suspectedRelease: null });
    expect(run.message).not.toMatch(/release problem/);
  });
  it.each(['SELF_UPGRADE_LAUNCHER', 'SELF_UPGRADE_ENGINE', 'UNMANAGED_MUTATION', 'A_CODE_FROM_THE_FUTURE'])('still suspects it for %s', async code => {
    expect(await refuseAll(code)).toMatchObject({ status: 'failed', suspectedRelease: expect.stringMatching(/suspected/) });
  });
  it('has an explicit flag on the codes that can point at the release', () => {
    expect(upgradeRemedy('SELF_UPGRADE_LAUNCHER').suspectable).toBe(true);
    expect(upgradeRemedy('SELF_UPGRADE_ENV_DISK').suspectable).toBeFalsy();
    expect(upgradeRemedy('SELF_UPGRADE_TIMEOUT').suspectable).toBeFalsy();
  });
});

describe('late reports do not lose each other', () => {
  it('serialises two reports for one run', async () => {
    const base = service.memoryRunStore();
    const run = makeRun(['a', 'b'], { status: 'partial', finishedAt: 'x' });
    for (const node of run.nodes) Object.assign(node, { state: 'ambiguous', code: 'MUTATION_OUTCOME_UNKNOWN', awaitingReport: true });
    await base.index(run);
    await base.save(run);
    // A store that hands out copies, as Redis does, with a delay wide enough for the two to overlap.
    const store = { ...base, get: async (id: string) => { const value = await base.get(id); await new Promise(resolve => setTimeout(resolve, 5)); return value && JSON.parse(JSON.stringify(value)) as UpgradeRun; } };
    let metadata = '{}';
    db.node.findUnique.mockImplementation(async () => ({ metadata }));
    db.node.update.mockImplementation((async ({ data }: { data: { metadata: string } }) => { metadata = data.metadata; }) as never);
    const report = (id: string) => service.recordSelfUpgradeReport({ id, name: id }, { selfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, upgrade: { state: 'confirmed', to: '1.1.8', requestId: `req-${id}` } } }, store);
    await Promise.all([report('a'), report('b')]);
    expect((await base.get('r'))!.nodes.map(node => node.state)).toEqual(['confirmed', 'confirmed']);
    expect((await base.get('r'))!.status).toBe('succeeded');
  });
});
