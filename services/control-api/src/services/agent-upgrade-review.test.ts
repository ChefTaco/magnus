/**
 * Regressions from an independent review of the wave policy. This layer is the
 * subject here: the real run loop, late reports and status rules run; only the
 * agents are fake. What depends on the transport is proven in the integration
 * tests, over the real client and leases.
 */
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
const { AgentResponseError, NotDispatchedError } = await import('../sdk/node-api-client.js');
const { UPGRADE_REMEDIES, upgradeRemedy } = await import('@hivemagnus/magnus-contracts');
import type { NodeRunState, RunNode, StoredSelfUpgrade, UpgradeDeps, UpgradeRun } from './agent-upgrade-service.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const makeRun = (ids: string[], extra: Partial<UpgradeRun> = {}): UpgradeRun => ({ id: 'r', version: '1.1.8', integrity: 'x', actorId: 'a', status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
  concurrency: 2, message: null, maxFailures: 2, ...extra, nodes: ids.map(id => ({ nodeId: id, name: id, from: '1.1.7', state: 'pending', requestId: `req-${id}`, detail: null })) });
const confirmed = (requestId: string) => ({ version: '1.1.8', report: { upgrade: { state: 'confirmed', requestId } } as StoredSelfUpgrade });
function deps(over: Partial<UpgradeDeps> = {}): UpgradeDeps {
  let clock = 1e12;
  return { request: async () => undefined, observe: async () => ({ version: '1.1.7', report: null, lastHeartbeatAt: new Date(clock) }), check: async () => null, sleep: async ms => { clock += ms; },
    now: () => clock, save: async () => undefined, stopRequested: async () => null, confirmTimeoutMs: 60_000, pollMs: 5_000, retryBackoffMs: [1, 1], ...over };
}
const report = (requestId: string, state: string) => ({ protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, upgrade: { state, from: '1.1.7', to: '1.1.8', requestId } });
const stubReportDb = () => {
  let metadata = '{}';
  db.node.findUnique.mockImplementation(async () => ({ metadata }));
  db.node.update.mockImplementation(async ({ data }: { data: { metadata: string } }) => { metadata = data.metadata; });
  db.agent.findUnique.mockImplementation(async () => null);
};

beforeEach(() => { logAuditEvent.mockClear(); vi.spyOn(console, 'warn').mockImplementation(() => undefined); });

describe('finding 2: a run is succeeded only if every selected node is confirmed or informational', () => {
  it('reports a thrown eligibility check as a coded transient skip, and retries it', async () => {
    let thrown = 0;
    const seen = new Map<string, string>();
    const run = await service.executeUpgradeRun(makeRun(['a', 'b']), deps({
      check: async id => { if (id === 'b' && thrown++ === 0) throw new Error('db blip'); return null; },
      request: async (id, body) => { seen.set(id, body.requestId); },
      observe: async id => confirmed(seen.get(id)!) }));
    expect(run.nodes[1]).toMatchObject({ state: 'confirmed', attempts: 1 });
    expect(thrown).toBe(2);
    expect(run.status).toBe('succeeded');
  });

  it('does not call a run with a node it never asked succeeded', async () => {
    const run = await service.executeUpgradeRun(makeRun(['a', 'b']), deps({
      check: async id => { if (id === 'b') throw new Error('db blip'); return null; },
      observe: async () => confirmed('req-a') }));
    expect(run.nodes[1]).toMatchObject({ state: 'skipped', code: 'CHECK_FAILED' });
    expect(run.status).toBe('partial');
    expect(run.attention?.map(item => item.code)).toEqual(['CHECK_FAILED']);
  });

  it('gives every skip a code', async () => {
    const stopped = await service.executeUpgradeRun(makeRun(['a', 'b', 'c']), deps({ stopRequested: async () => 'alice' }));
    expect(stopped.nodes.map(node => node.code)).toEqual(['RUN_STOPPED', 'RUN_STOPPED', 'RUN_STOPPED']);
    const failed = await service.executeUpgradeRun(makeRun(['a', 'b']), deps({ request: async () => { throw new AgentResponseError(422, { code: 'SELF_UPGRADE_INTEGRITY', message: 'x' }); } }));
    expect(failed.nodes[1]).toMatchObject({ state: 'skipped', code: 'NOT_REACHED' });
    const plain = await service.executeUpgradeRun(makeRun(['a', 'b']), deps({ check: async id => id === 'b' ? 'no longer wanted' : null, observe: async () => confirmed('req-a') }));
    expect(plain.nodes[1]).toMatchObject({ state: 'skipped', code: 'NOT_ELIGIBLE' });
    expect(plain.status).toBe('partial');
  });

  it('keeps a late report from turning a run with an uncoded skip into succeeded', async () => {
    stubReportDb();
    const store = service.memoryRunStore();
    const run = makeRun(['a', 'b'], { status: 'partial', finishedAt: 'x' });
    Object.assign(run.nodes[0]!, { state: 'ambiguous', code: 'MUTATION_OUTCOME_UNKNOWN', awaitingReport: true });
    Object.assign(run.nodes[1]!, { state: 'skipped', detail: 'not reached' });
    await store.index(run);
    await store.save(run);
    await service.recordSelfUpgradeReport({ id: 'a', name: 'a' }, { selfUpgrade: report('req-a', 'confirmed') }, store);
    expect((await store.get('r'))!.nodes[0]!.state).toBe('confirmed');
    expect((await store.get('r'))!.status).toBe('partial');
  });

  it('holds over generated mixes of node states, excluded nodes and codes', () => {
    const states: NodeRunState[] = ['pending', 'requested', 'watching', 'ambiguous', 'confirmed', 'reverted', 'failed', 'refused', 'skipped'];
    const codes: Array<string | null> = [null, 'NOT_REACHED', 'RUN_STOPPED', 'ALREADY_CURRENT', 'SELF_UPGRADE_CURRENT', 'SELF_UPGRADE_DISABLED', 'RESOURCE_BUSY', 'UNMANAGED_MUTATION', 'SOME_FUTURE_CODE',
      'SELF_UPGRADE_REVERTED', 'CONFIRM_TIMEOUT', 'MANAGED_MUTATION_UNCERTAIN'];
    // A small deterministic generator: the failing mix is reproducible from its seed.
    let seed = 88172645463325252n;
    const next = (limit: number) => {
      seed ^= (seed << 13n) & 0xffffffffffffffffn; seed ^= seed >> 7n; seed ^= (seed << 17n) & 0xffffffffffffffffn;
      return Number(seed % BigInt(limit));
    };
    const informational = (code: string | null | undefined) => Boolean(code && (upgradeRemedy(code) as { informational?: boolean }).informational);
    let succeeded = 0;
    for (let round = 0; round < 5000; round++) {
      const nodes: RunNode[] = Array.from({ length: 1 + next(4) }, (_, index) => ({ nodeId: `n${index}`, name: `n${index}`, from: '1.1.7', state: states[next(states.length)]!, requestId: `q${index}`, detail: null, code: codes[next(codes.length)] ?? null }));
      const excluded = Array.from({ length: next(3) }, (_, index) => ({ nodeId: `x${index}`, name: `x${index}`, reason: 'r', code: codes[next(codes.length)] ?? null }));
      const run = { ...makeRun([]), nodes, excluded };
      const expectedOk = nodes.every(node => node.state === 'confirmed' || (node.state !== 'failed' && node.state !== 'reverted' && informational(node.code)
        && ['refused', 'skipped'].includes(node.state))) && excluded.every(node => informational(node.code));
      const status = service.finalStatus(run);
      if (status === 'succeeded') succeeded += 1;
      expect({ status, nodes: nodes.map(node => [node.state, node.code]), excluded: excluded.map(node => node.code), ok: status !== 'succeeded' || expectedOk }).toMatchObject({ ok: true });
      if (!expectedOk) expect(service.attentionList(run).length, JSON.stringify({ nodes, excluded })).toBeGreaterThan(0);
    }
    expect(succeeded).toBeGreaterThan(0);
  });
});

describe('finding 5: a late report counts while the run is still live', () => {
  it('records a post-canary timeout that confirms later, so it stops counting against the budget', async () => {
    stubReportDb();
    const store = service.memoryRunStore();
    db.node.findMany.mockImplementation(async () => ['a', 'late', 'c', 'd', 'e'].map(id => ({ id, name: id, hostname: `${id}.example.com`, status: 'ONLINE', lastHeartbeatAt: new Date(),
      metadata: JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, observedAt: new Date().toISOString() } }), agent: { version: '1.1.7' }, resourceEnrollment: null, admissionFence: null })));
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    let reported = false;
    const seen = new Map<string, string>();
    const base = deps();
    const { done } = await service.startUpgradeRun({ version: '1.1.8', integrity: INTEGRITY, actorId: 'admin', store, maxFailures: 2, deps: { ...base,
      request: async (nodeId, body) => { seen.set(nodeId, body.requestId); },
      observe: async nodeId => nodeId === 'late' || nodeId === 'c' ? { version: '1.1.7', report: null, lastHeartbeatAt: new Date(base.now()) } : confirmed(seen.get(nodeId)!),
      save: async saved => {
        await store.save(saved);
        // The heartbeat arrives the moment this node has timed out, and before the other one in its batch is judged.
        const late = saved.nodes.find(node => node.nodeId === 'late');
        if (!reported && late?.code === 'CONFIRM_TIMEOUT') {
          reported = true;
          await service.recordSelfUpgradeReport({ id: 'late', name: 'late' }, { selfUpgrade: report(seen.get('late')!, 'confirmed') }, store);
        }
      } } });
    const run = await done;
    expect(reported).toBe(true);
    expect(run.nodes.find(node => node.nodeId === 'late')).toMatchObject({ state: 'confirmed', awaitingReport: false });
    // Only `c` still counts: one release failure is below the budget of two, so the wave reaches the end.
    expect(run.nodes.find(node => node.nodeId === 'e')?.state).toBe('confirmed');
  });

  it('picks a late confirmation up from the stored report even without the heartbeat hook, as another server would see it', async () => {
    let confirmedLate = false;
    const run = await service.executeUpgradeRun(makeRun(['a', 'late', 'c', 'd', 'e']), deps({
      observe: async id => id === 'late' ? (confirmedLate ? confirmed('req-late') : { version: '1.1.7', report: null }) : id === 'c' ? { version: '1.1.7', report: null } : confirmed(`req-${id}`),
      save: async saved => { if (saved.nodes.find(node => node.nodeId === 'late')?.code === 'CONFIRM_TIMEOUT') confirmedLate = true; } }));
    expect(run.nodes.find(node => node.nodeId === 'late')?.state).toBe('confirmed');
    expect(run.nodes.find(node => node.nodeId === 'e')?.state).toBe('confirmed');
  });

  it('updates the run when a late confirmation ends it', async () => {
    stubReportDb();
    const store = service.memoryRunStore();
    const r = makeRun(['a', 'b', 'c']);
    const run = await service.executeUpgradeRun(r, deps({ save: saved => store.save(saved) }));
    await store.index(run);
    expect(run.status).toBe('failed');
    await service.recordSelfUpgradeReport({ id: 'a', name: 'a' }, { selfUpgrade: report('req-a', 'confirmed') }, store);
    const after = (await store.get('r'))!;
    expect(after.nodes.map(node => node.state)).toEqual(['confirmed', 'skipped', 'skipped']);
    expect(after.status).toBe('partial');
  });
});

describe('finding 10: a transient retry that cannot succeed', () => {
  it('retries only a node whose lease settled, and keeps the original code otherwise', async () => {
    const attempts = new Map<string, number>();
    const run = await service.executeUpgradeRun(makeRun(['a', 'held']), deps({
      request: async id => {
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (id === 'held') throw new AgentResponseError(409, { code: 'RESOURCE_BUSY', message: 'busy' });
      },
      observe: async id => confirmed(`req-${id}`),
      // An older agent's unsigned refusal leaves the lease unknown, so admission would answer LEASE_HELD for ever.
      leaseSettled: async id => id !== 'held',
      check: async () => null }));
    expect(attempts.get('held')).toBe(1);
    expect(run.nodes[1]).toMatchObject({ state: 'refused', code: 'RESOURCE_BUSY', detail: expect.stringMatching(/lease.*held/i) });
  });
});

describe('finding 10 continued', () => {
  it('keeps the original code when something else blocks the retry at its turn', async () => {
    let checks = 0;
    const run = await service.executeUpgradeRun(makeRun(['a', 'b']), deps({
      request: async id => { if (id === 'b') throw new NotDispatchedError('RESOURCE_BUSY', 'busy'); },
      observe: async id => confirmed(`req-${id}`),
      check: async id => id === 'b' && ++checks > 1 ? { reason: '1 command lease(s) unsettled', code: 'LEASE_HELD' } : null }));
    expect(run.nodes[1]).toMatchObject({ state: 'refused', code: 'RESOURCE_BUSY', detail: expect.stringMatching(/busy; not tried again: 1 command lease/) });
  });
});

describe('catalogue', () => {
  it('has no informational code that hides a node needing someone', () => {
    for (const code of ['NOT_REACHED', 'RUN_STOPPED', 'CHECK_FAILED', 'NOT_ELIGIBLE']) expect((UPGRADE_REMEDIES as Record<string, { informational?: boolean }>)[code]?.informational, code).toBeFalsy();
    expect((UPGRADE_REMEDIES as Record<string, { transient?: boolean }>)['CHECK_FAILED']?.transient).toBe(true);
    void NotDispatchedError;
  });
});
