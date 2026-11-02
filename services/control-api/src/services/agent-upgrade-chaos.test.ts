/**
 * A mixed fleet in one wave, for the POLICY: a node's own state never stops a
 * wave, and only evidence about the release does. Each fake agent has a real-world
 * bad state, from a stale fence to a reply that never arrives. Eligibility, the run
 * loop and the summary are the real code. The transport and lease settlement are
 * NOT: `settle` below models them, so nothing here proves a real refusal settles a
 * real lease. agent-upgrade.integration.test.ts proves that over the real client and
 * PostgreSQL, and agent-upgrade.real-agent.integration.test.ts with the real agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const logAuditEvent = vi.fn(async (_event: { action: string; details?: Record<string, unknown> }) => undefined);
vi.mock('./audit-service.js', () => ({ logAuditEvent }));
const db = vi.hoisted(() => ({
  node: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  agent: { findUnique: vi.fn(), updateMany: vi.fn() },
  commandResourceLease: { groupBy: vi.fn() },
  resourceParticipantWork: { groupBy: vi.fn(async () => []) },
  managedCronDefinition: { groupBy: vi.fn(async () => []) },
}));
vi.mock('../db/client.js', () => ({ getDb: () => db }));
vi.mock('../config/features.js', () => ({ upgradeSettings: () => ({ agentUpgrades: true, agentUpgradeConcurrency: 2, agentUpgradeMaxFailures: 2, updateRegistry: 'https://registry.example.com' }) }));
const service = await import('./agent-upgrade-service.js');
const { evaluatePreflight, preflightStatus } = await import('./agent-upgrade-preflight.js');
const { checkReportedFence, fenceIsAhead } = await import('./command-fence-repair.js');
const { AgentResponseError, DispatchOutcomeUnknownError, NotDispatchedError } = await import('../sdk/node-api-client.js');
import type { AgentUpgradePreflight } from '@hivemagnus/magnus-contracts';
import type { NodePreflight } from './agent-upgrade-preflight.js';
import type { UpgradeDeps, UpgradeRun } from './agent-upgrade-service.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const TARGET = '1.1.8';
const WINDOW_MS = 60_000;

type Agent = {
  /** What it says when asked to upgrade, attempt by attempt; the last entry repeats. */
  reply?: Array<'accept' | 'busy' | 'unreachable' | 'stale' | 'lost' | 'integrity' | 'source' | 'install-failed' | 'old-uncertain' | 'unknown-4xx'>;
  /** What heartbeats report afterwards. */
  after?: 'confirm' | 'revert' | 'silent' | 'never-reports';
  /** Fence the ledger holds. */
  ledgerFence?: bigint;
  preflight?: 'report' | 'old-agent-404' | 'unreachable';
  preflightReport?: Partial<AgentUpgradePreflight>;
  enrollment?: { state: string; nodeFqdn: string; startedAt: Date | null; updatedAt: Date } | null;
  marker?: { nodeId: string; nodeFqdn: string };
  metadata?: string;
  status?: string;
};

interface Lease { commandId: string; nodeId: string; state: 'running' | 'unknown' | 'released'; settlement: string | null }

/** The fleet: fake agents, and the server's lease and fence rows as the real transport leaves them. */
function fleet(agents: Record<string, Agent>) {
  let clock = 1_000_000;
  const fences = new Map<string, bigint>();
  const leases: Lease[] = [];
  const attempts = new Map<string, number>();
  const accepted = new Map<string, string>();
  const dispatchAt = new Map<string, number>();
  const log: string[] = [];
  const hostname = (id: string) => `${id}.example.com`;
  const held = () => leases.filter(lease => lease.state !== 'released');
  const metadata = (id: string) => {
    const agent = agents[id]!;
    if (agent.metadata !== undefined) return agent.metadata;
    return JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, reason: null, upgrade: { state: 'idle', from: null, to: '1.1.7' },
      nodeVersion: 'v24.22.1', observedAt: new Date(clock).toISOString(), ...(agent.marker ? { managedEnrollment: agent.marker } : {}) } });
  };
  const rows = () => Object.keys(agents).map(id => ({ id, name: id, hostname: hostname(id), status: agents[id]!.status ?? 'ONLINE', lastHeartbeatAt: new Date(), metadata: metadata(id),
    agent: { version: '1.1.7' }, resourceEnrollment: agents[id]!.enrollment === undefined ? { state: 'enrolled', nodeFqdn: hostname(id), startedAt: new Date(0), updatedAt: new Date(0) } : agents[id]!.enrollment, admissionFence: null }));
  db.node.findMany.mockImplementation(async ({ where }: { where: { id?: { in?: string[] } } }) => rows().filter(row => !where.id?.in || where.id.in.includes(row.id)));
  db.commandResourceLease.groupBy.mockImplementation(async () => {
    const counts = new Map<string, number>();
    for (const lease of held()) counts.set(`${lease.nodeId}|${lease.state}`, (counts.get(`${lease.nodeId}|${lease.state}`) ?? 0) + 1);
    const history = leases.filter(lease => lease.state === 'released').map(lease => ({ nodeId: lease.nodeId, state: 'released', _count: { _all: 1 } }));
    return [...counts].map(([key, count]) => ({ nodeId: key.split('|')[0], state: key.split('|')[1], _count: { _all: count } })).concat(history as never);
  });

  /** The transport's rule, as in NodeApiClient: a certain refusal settles the lease, anything uncertain holds it. */
  const settle = (lease: Lease, certain: boolean) => Object.assign(lease, certain ? { state: 'released', settlement: 'not-dispatched' } : { state: 'unknown' });

  const deps: UpgradeDeps = {
    request: async (nodeId, body) => {
      const agent = agents[nodeId]!;
      const attempt = (attempts.get(nodeId) ?? 0) + 1;
      attempts.set(nodeId, attempt);
      dispatchAt.set(nodeId, clock);
      log.push(nodeId);
      const key = `node:${nodeId}`;
      const fence = (fences.get(key) ?? 0n) + 1n;
      fences.set(key, fence);
      const lease: Lease = { commandId: `agent-upgrade-${body.requestId}`, nodeId, state: 'running', settlement: null };
      leases.push(lease);
      const reply = (agent.reply ?? ['accept'])[Math.min(attempt - 1, (agent.reply ?? ['accept']).length - 1)]!;
      if (reply === 'unreachable') {
        settle(lease, true);
        throw new NotDispatchedError('AGENT_UNREACHABLE', 'agent unreachable: connect ECONNREFUSED');
      }
      if (reply === 'busy') {
        settle(lease, true);
        throw new NotDispatchedError('RESOURCE_BUSY', 'Another request owns the node execution slot; nothing ran');
      }
      if ((agent.ledgerFence ?? 0n) >= fence || reply === 'stale') {
        settle(lease, true);
        const check = checkReportedFence(nodeId, key, String(agent.ledgerFence));
        if (!check.ok) throw new NotDispatchedError(check.code, check.detail);
        fences.set(key, check.value + 1n);
        throw new NotDispatchedError('STALE_FENCE', 'Stale resource fence cannot execute');
      }
      agent.ledgerFence = fence;
      if (reply === 'lost') {
        settle(lease, false);
        accepted.set(nodeId, body.requestId);
        throw new DispatchOutcomeUnknownError('no answer from the agent after the request was sent: socket hang up');
      }
      if (reply === 'old-uncertain') {
        settle(lease, false);
        throw new AgentResponseError(409, { code: 'MANAGED_MUTATION_UNCERTAIN', message: 'Inspect the exact resource receipt before further work; no automatic replay' });
      }
      if (reply === 'unknown-4xx') {
        settle(lease, true);
        throw new AgentResponseError(422, { code: 'SOMETHING_NEW', message: 'a newer agent says no' });
      }
      if (reply === 'integrity' || reply === 'source' || reply === 'install-failed') {
        settle(lease, true);
        throw new AgentResponseError(reply === 'install-failed' ? 500 : 422, { code: reply === 'integrity' ? 'SELF_UPGRADE_INTEGRITY' : reply === 'source' ? 'SELF_UPGRADE_SOURCE' : 'SELF_UPGRADE_FAILED', message: `${reply}: the tarball` });
      }
      lease.state = 'released';
      lease.settlement = 'signed-command-result';
      accepted.set(nodeId, body.requestId);
    },
    observe: async nodeId => {
      const agent = agents[nodeId]!;
      const requestId = accepted.get(nodeId);
      const base = { lastHeartbeatAt: new Date(clock) };
      if (!requestId || clock - (dispatchAt.get(nodeId) ?? clock) < 10_000) return { version: '1.1.7', report: null, ...base };
      const report = (state: string, extra = {}) => ({ upgrade: { state, requestId, from: '1.1.7', to: TARGET, ...extra } }) as never;
      if (agent.reply?.includes('lost') && agent.after === 'confirm') {
        // The reply was lost, and the report only comes well past the node's window.
        return clock - dispatchAt.get(nodeId)! > 2 * WINDOW_MS ? { version: TARGET, report: report('confirmed'), ...base } : { version: '1.1.7', report: null, ...base };
      }
      switch (agent.after ?? 'confirm') {
        case 'confirm': return { version: TARGET, report: report('confirmed'), ...base };
        case 'revert': return { version: '1.1.7', report: report('reverted', { reason: 'the new version stayed silent' }), ...base };
        case 'silent': return { version: '1.1.7', report: null, lastHeartbeatAt: new Date(dispatchAt.get(nodeId)!) };
        default: return { version: '1.1.7', report: null, ...base };
      }
    },
    check: async (nodeId, run) => {
      const [candidate] = await service.listUpgradeCandidates(run.version, [nodeId], { leasesRequested: false } as never);
      return candidate?.eligible ? null : { reason: candidate?.reason ?? 'gone', code: candidate?.code ?? 'NODE_NOT_FOUND' };
    },
    sleep: async ms => { clock += ms; },
    now: () => clock,
    save: async () => undefined,
    stopRequested: async () => null,
    confirmTimeoutMs: WINDOW_MS,
    pollMs: 5_000,
    preflight: async (target, _query): Promise<NodePreflight> => {
      const agent = agents[target.nodeId]!;
      const checkedAt = new Date(clock).toISOString();
      if (agent.preflight === 'old-agent-404') return { status: 'unavailable', checkedAt, problems: [], detail: 'this agent has no preflight check' };
      if (agent.preflight === 'unreachable') return { status: 'unreachable', checkedAt, problems: [], detail: 'timed out' };
      const report: AgentUpgradePreflight = { preflightProtocol: 1, version: '1.1.7', target: TARGET, layout: 'versioned', launcherProtocol: 1, enabled: true, reason: null, writable: { ok: true, blocked: [] },
        disk: { freeBytes: 10 ** 10, requiredBytes: 10 ** 8, low: false }, npm: { present: true, version: '11.0.0' }, fromVersionComplete: true,
        ledger: { readable: true, activeLock: null, nonTerminalReceipts: 0, unresolvedReceipts: 0 },
        fenceHighWater: agent.ledgerFence ? { [`node:${target.nodeId}`]: String(agent.ledgerFence) } : {}, ...agent.preflightReport };
      const problems = evaluatePreflight(report, { nodeId: target.nodeId, hostname: target.hostname, managed: target.managed,
        generations: { [`node:${target.nodeId}`]: fences.get(`node:${target.nodeId}`) ?? 0n } });
      return { status: preflightStatus(problems), checkedAt, problems, report };
    },
    heal: async (target, preflight) => {
      const healed: string[] = [];
      let problems = preflight.problems;
      for (const [key, value] of Object.entries(preflight.report?.fenceHighWater ?? {})) {
        const check = checkReportedFence(target.nodeId, key, value);
        if (!check.ok || !fenceIsAhead(check.value, fences.get(key) ?? 0n)) continue;
        fences.set(key, check.value + 1n);
        healed.push(`moved the fence of ${key}`);
        problems = problems.filter(problem => problem.code !== 'FENCE_AHEAD');
      }
      return { healed, problems };
    },
    // The signed receipt of a request whose reply was lost, the way the real client reads it.
    settleLostReply: async (nodeId, requestId) => {
      for (const lease of leases) if (lease.nodeId === nodeId && lease.commandId === `agent-upgrade-${requestId}` && lease.state === 'unknown') Object.assign(lease, { state: 'released', settlement: 'signed-command-result' });
    },
    retryBackoffMs: [30_000, 120_000],
  };
  return { deps, leases, held, fences, attempts, log, tick: (ms: number) => { clock += ms; }, dispatchAt, clock: () => clock };
}

const start = async (agents: Record<string, Agent>, extra: Partial<Parameters<typeof service.startUpgradeRun>[0]> = {}) => {
  const world = fleet(agents);
  const store = service.memoryRunStore();
  world.deps.save = saved => store.save(saved);
  const { run, done, candidates } = await service.startUpgradeRun({ version: TARGET, integrity: INTEGRITY, actorId: 'admin', store, deps: world.deps, ...extra });
  return { world, store, started: run, candidates, run: await done };
};
const node = (run: UpgradeRun, id: string) => run.nodes.find(entry => entry.nodeId === id);
const draining = { state: 'draining', nodeFqdn: 'stuck.example.com', startedAt: new Date('2026-06-03T10:00:00Z'), updatedAt: new Date('2026-06-03T10:00:00Z') };

beforeEach(() => {
  logAuditEvent.mockClear();
  vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('a mixed fleet with real-world bad states', () => {
  it('upgrades every healthy node and accounts for every other one', async () => {
    const { run, world } = await start({
      'healthy-1': {},
      'stale-fence': { ledgerFence: 1789962351090n },
      'stuck': { enrollment: draining },
      'marker': { enrollment: null, marker: { nodeId: 'marker', nodeFqdn: 'marker.example.com' } },
      'healthy-2': {},
      'busy-once': { reply: ['busy', 'accept'] },
      'busy-always': { reply: ['busy'] },
      'unreachable': { reply: ['unreachable'] },
      'lost-then-confirms': { reply: ['lost'], after: 'confirm' },
      'unparsable': { metadata: '{"agentSelfUpgrade":{"protocol":"one"}}' },
      'old-agent': { preflight: 'old-agent-404' },
      'healthy-3': {},
    });
    expect(run.status).toBe('partial');
    for (const id of ['healthy-1', 'healthy-2', 'healthy-3', 'stale-fence', 'busy-once', 'lost-then-confirms', 'old-agent']) expect(node(run, id)?.state, id).toBe('confirmed');
    expect(node(run, 'lost-then-confirms')?.detail).toMatch(/reply to the request was lost/);
    expect(world.leases.find(lease => lease.nodeId === 'lost-then-confirms')?.settlement).toBe('signed-command-result');
    expect(node(run, 'busy-once')?.attempts).toBe(2);
    expect(node(run, 'busy-always')).toMatchObject({ state: 'refused', code: 'RESOURCE_BUSY', failureClass: 'node', attempts: 3 });
    expect(node(run, 'unreachable')).toMatchObject({ state: 'refused', code: 'AGENT_UNREACHABLE', attempts: 3 });
    expect(run.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'stuck', code: 'ENROLLMENT_DRAINING', reason: expect.stringMatching(/stuck in draining since 2026-06-03/) }),
      expect.objectContaining({ nodeId: 'marker', code: 'ENROLLMENT_MARKER_MISMATCH' }),
      expect.objectContaining({ nodeId: 'unparsable', code: 'NOT_SELF_UPGRADABLE' }),
    ]));
    // Each node needing attention has a code and a specific remedy; an expected state does not count.
    expect(run.attention?.map(item => item.name).sort()).toEqual(['busy-always', 'marker', 'stuck', 'unreachable']);
    expect(run.attention?.find(item => item.name === 'stuck')?.remedy).toMatch(/enrollment\/<nodeId>\/complete/);
    expect(run.attention?.every(item => item.remedy.length > 10 && item.failureClass === 'node')).toBe(true);
    expect(world.held()).toEqual([]);
  });

  it('heals a stale fence before the first node is touched, without a refused attempt', async () => {
    const { run, world, candidates } = await start({ stale: { ledgerFence: 1789962351090n }, other: {} });
    expect(run.status).toBe('succeeded');
    expect(world.attempts.get('stale')).toBe(1);
    expect(candidates.find(candidate => candidate.nodeId === 'stale')?.preflight?.healed).toEqual(['moved the fence of node:stale']);
    expect(world.fences.get('node:stale')).toBeGreaterThan(1789962351090n);
    expect(world.leases.every(lease => lease.state === 'released')).toBe(true);
  });

  it('heals a fence the preflight could not report from the refusal, and tries the node again', async () => {
    const { run, world } = await start({ a: {}, 'no-preflight': { ledgerFence: 5000n, preflight: 'unreachable' } });
    expect(node(run, 'no-preflight')).toMatchObject({ state: 'confirmed', attempts: 2 });
    expect(world.leases.filter(lease => lease.nodeId === 'no-preflight').map(lease => lease.settlement)).toEqual(['not-dispatched', 'signed-command-result']);
    expect(run.status).toBe('succeeded');
    expect(world.held()).toEqual([]);
  });

  it('excludes a fence above the cap up front and leaves the generation alone', async () => {
    const { run, world } = await start({ a: {}, wild: { ledgerFence: 9_000_000_000_000_000_000n } });
    expect(run.excluded).toEqual([expect.objectContaining({ nodeId: 'wild', code: 'FENCE_OVERFLOW' })]);
    expect(world.fences.has('node:wild')).toBe(false);
    expect(run.attention?.[0]?.remedy).toMatch(/fence-\*\.json/);
    expect(run.status).toBe('partial');
  });

  it('excludes nodes the preflight blocks, each with its reason, and proceeds with the rest', async () => {
    const { run } = await start({
      fine: {},
      'no-disk': { preflightReport: { disk: { freeBytes: 1024, requiredBytes: 10 ** 9, low: true } } },
      'no-npm': { preflightReport: { npm: { present: false, problem: 'npm was not found' } } },
      'read-only': { preflightReport: { writable: { ok: false, blocked: ['versions'] } } },
      'bad-from': { preflightReport: { fromVersionComplete: false } },
      'wrong-node': { preflightReport: { engines: { node: '20.0.0', range: '^24', compatible: false, problem: 'requires Node.js ^24' } } },
      'unresolved': { preflightReport: { ledger: { readable: true, activeLock: { commandId: 'old-command', receipt: 'unknown' }, unresolvedReceipts: 1 } } },
    });
    expect(run.status).toBe('partial');
    expect(run.nodes.map(entry => [entry.nodeId, entry.state])).toEqual([['fine', 'confirmed']]);
    expect(Object.fromEntries((run.excluded ?? []).map(entry => [entry.nodeId, entry.code]))).toEqual({ 'no-disk': 'PREFLIGHT_DISK_LOW', 'no-npm': 'PREFLIGHT_NPM',
      'read-only': 'PREFLIGHT_NOT_WRITABLE', 'bad-from': 'PREFLIGHT_FROM_INCOMPLETE', 'wrong-node': 'PREFLIGHT_ENGINE', 'unresolved': 'LEDGER_UNRESOLVED' });
  });

  it('treats an old agent without a preflight route as unavailable, not as a failure', async () => {
    const { run, candidates } = await start({ old: { preflight: 'old-agent-404' } });
    expect(candidates[0]?.preflight).toMatchObject({ status: 'unavailable' });
    expect(run.status).toBe('succeeded');
  });

  it('records an unknown 4xx and an uncertain reply from an older agent as node-level, and goes on', async () => {
    const { run, world } = await start({ good: {}, strange: { reply: ['unknown-4xx'] }, older: { reply: ['old-uncertain'] }, after: {} });
    expect(run.status).toBe('partial');
    expect(node(run, 'strange')).toMatchObject({ state: 'refused', code: 'SOMETHING_NEW', failureClass: 'node', attempts: 1 });
    expect(node(run, 'older')).toMatchObject({ state: 'ambiguous', code: 'MANAGED_MUTATION_UNCERTAIN', failureClass: 'node', attempts: 1 });
    expect(node(run, 'after')?.state).toBe('confirmed');
    // What an older agent cannot prove stays held, and the remedy says how to read why.
    expect(world.held().map(lease => lease.nodeId)).toEqual(['older']);
    expect(run.attention?.find(item => item.name === 'older')?.remedy).toMatch(/agents fence/);
  });
});

describe('the canary', () => {
  it('hands the role on past node-level problems and never touches the rest until one confirms', async () => {
    const { run, world } = await start({ a: { reply: ['unreachable'] }, b: { reply: ['busy'] }, c: { enrollment: draining }, d: {}, e: {}, f: {} }, { maxFailures: 2 });
    expect(run.canaryNodeId).toBe('d');
    expect(world.log.slice(0, 3)).toEqual(['a', 'b', 'd']);
    expect(node(run, 'e')?.state).toBe('confirmed');
    expect(run.status).toBe('partial');
  });

  it('stops the run on a release failure and touches no other node', async () => {
    const { run, world } = await start({ a: { after: 'revert' }, b: {}, c: {} });
    expect(run).toMatchObject({ status: 'failed', message: expect.stringMatching(/canary a did not confirm.*the other nodes were not touched/) });
    expect(world.log).toEqual(['a']);
    expect(node(run, 'b')?.state).toBe('skipped');
    expect(world.held()).toEqual([]);
  });

  it('counts a trial that never confirms on the canary as a release failure', async () => {
    const { run, world } = await start({ a: { after: 'never-reports' }, b: {} });
    expect(node(run, 'a')).toMatchObject({ state: 'failed', code: 'CONFIRM_TIMEOUT', failureClass: 'release', awaitingReport: true });
    expect(run.status).toBe('failed');
    expect(world.log).toEqual(['a']);
  });

  it('hands the role on past a lost reply once its whole watch is over', async () => {
    const { run, world } = await start({ a: { reply: ['lost'], after: 'never-reports' }, b: {}, c: {} });
    expect(run.canaryNodeId).toBe('b');
    // A first canary whose reply was lost may still be staging, so its whole watch comes first.
    expect(world.dispatchAt.get('b')! - world.dispatchAt.get('a')!).toBeGreaterThanOrEqual(WINDOW_MS + 10 * 60_000);
    expect(node(run, 'a')).toMatchObject({ state: 'ambiguous', code: 'MUTATION_OUTCOME_UNKNOWN', awaitingReport: true, attempts: 1 });
    expect(node(run, 'c')?.state).toBe('confirmed');
    expect(run.status).toBe('partial');
  });
});

describe('the release budget', () => {
  it('stops immediately on an integrity failure: every node gets the same artifact', async () => {
    const { run, world } = await start({ a: {}, b: { reply: ['integrity'] }, c: {}, d: {}, e: {} }, { maxFailures: 50 });
    expect(run).toMatchObject({ status: 'failed', message: expect.stringMatching(/same artifact/) });
    expect(node(run, 'b')).toMatchObject({ state: 'failed', code: 'SELF_UPGRADE_INTEGRITY', failureClass: 'release' });
    expect(node(run, 'e')?.state).toBe('skipped');
    expect(world.log).not.toContain('e');
    expect(world.held()).toEqual([]);
  });

  it('stops immediately on a missing source tarball', async () => {
    const { run } = await start({ a: {}, b: { reply: ['source'] }, c: {}, d: {}, e: {} }, { maxFailures: 50 });
    expect(run.status).toBe('failed');
    expect(node(run, 'e')?.state).toBe('skipped');
  });

  it('continues below the budget, and ends failed because of the evidence', async () => {
    const { run } = await start({ a: {}, b: { after: 'revert' }, c: {}, d: {}, e: {} });
    expect(run.nodes.map(entry => entry.state)).toEqual(['confirmed', 'reverted', 'confirmed', 'confirmed', 'confirmed']);
    expect(run).toMatchObject({ status: 'failed', message: expect.stringMatching(/1 node\(s\) failed in a way that points at the release; 4 agent/) });
    expect(run.attention?.[0]).toMatchObject({ name: 'b', code: 'SELF_UPGRADE_REVERTED', failureClass: 'release' });
  });

  it('stops at the budget, whatever mix of release failures reaches it', async () => {
    const { run, world } = await start({ a: {}, b: { after: 'revert' }, c: { reply: ['install-failed'] }, d: {}, e: {}, f: {} });
    expect(run).toMatchObject({ status: 'failed', message: expect.stringMatching(/2 release failure\(s\) reached the budget of 2/) });
    expect(run.nodes.slice(3).every(entry => entry.state === 'skipped')).toBe(true);
    expect(world.log).not.toContain('f');
    expect(world.held()).toEqual([]);
  });

  it('never counts node-level failures towards it, however many there are', async () => {
    const agents: Record<string, Agent> = { good: {} };
    for (let index = 0; index < 8; index++) agents[`bad-${index}`] = { reply: ['unknown-4xx'] };
    agents['last'] = {};
    const { run } = await start(agents);
    expect(run.status).toBe('partial');
    expect(node(run, 'last')?.state).toBe('confirmed');
  });
});

describe('automatic retries', () => {
  it('never retries anything ambiguous or release-class', async () => {
    const { world } = await start({ a: {}, lost: { reply: ['lost'], after: 'never-reports' }, uncertain: { reply: ['old-uncertain'] }, reverted: { after: 'revert' }, z: {} });
    for (const id of ['lost', 'uncertain', 'reverted']) expect(world.attempts.get(id), id).toBe(1);
  });

  it('sends a new request id each time, since a command id owns one lease for good', async () => {
    const { world } = await start({ a: {}, busy: { reply: ['busy', 'busy', 'accept'] } });
    const commands = world.leases.filter(lease => lease.nodeId === 'busy').map(lease => lease.commandId);
    expect(new Set(commands).size).toBe(3);
    expect(world.held()).toEqual([]);
  });

  it('honours a stop between attempts', async () => {
    const world = fleet({ a: {}, busy: { reply: ['busy'] } });
    const store = service.memoryRunStore();
    let stopAsked = false;
    const deps: UpgradeDeps = { ...world.deps, stopRequested: async () => stopAsked ? 'alice' : null,
      sleep: async ms => { if (ms === 30_000) stopAsked = true; await world.deps.sleep(ms); } };
    const { done } = await service.startUpgradeRun({ version: TARGET, integrity: INTEGRITY, actorId: 'admin', store, deps });
    const run = await done;
    expect(run).toMatchObject({ status: 'stopped', stopRequestedBy: 'alice' });
    expect(world.attempts.get('busy')).toBe(1);
  });
});

describe('a server restart in the middle of a run', () => {
  it('marks the run interrupted, settles what it can from reports, records late outcomes, and retries the rest', async () => {
    const world = fleet({ a: {}, b: {}, c: {}, d: {} });
    const store = service.memoryRunStore();
    // The state a dead server left behind: its lease ran out with nodes in every phase.
    const run: UpgradeRun = { id: 'dead-run', version: TARGET, integrity: INTEGRITY, actorId: 'admin', status: 'running', startedAt: new Date(0).toISOString(), finishedAt: null,
      concurrency: 2, message: null, maxFailures: 2, leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      nodes: [{ nodeId: 'a', name: 'a', from: '1.1.7', state: 'confirmed', requestId: 'r-a', detail: null },
        { nodeId: 'b', name: 'b', from: '1.1.7', state: 'requested', requestId: 'r-b', detail: null },
        { nodeId: 'c', name: 'c', from: '1.1.7', state: 'watching', requestId: 'r-c', detail: 'outcome unknown' },
        { nodeId: 'd', name: 'd', from: '1.1.7', state: 'pending', requestId: 'r-d', detail: null }] };
    await store.index(run);
    await store.save(run);
    const observe: UpgradeDeps['observe'] = async nodeId => nodeId === 'b'
      ? { version: TARGET, report: { upgrade: { state: 'confirmed', requestId: 'r-b' } } as never } : { version: '1.1.7', report: null };
    const after = await service.reconcileInterruptedRun(run, observe, saved => store.save(saved));
    expect(after.status).toBe('interrupted');
    expect(after.nodes.map(entry => entry.state)).toEqual(['confirmed', 'confirmed', 'ambiguous', 'skipped']);
    expect(after.attention).toEqual([expect.objectContaining({ name: 'c', code: 'RUN_INTERRUPTED', failureClass: 'node' }), expect.objectContaining({ name: 'd', code: 'NOT_REACHED' })]);
    // The heartbeat that finally reports the outcome finds the run.
    let metadata = '{}';
    db.node.findUnique.mockImplementation(async () => ({ metadata }));
    db.node.update.mockImplementation(async ({ data }: { data: { metadata: string } }) => { metadata = data.metadata; });
    db.agent.findUnique.mockImplementation(async () => ({ status: 'RUNNING' }));
    await service.recordSelfUpgradeReport({ id: 'c', name: 'c' }, { selfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true,
      upgrade: { state: 'reverted', to: TARGET, requestId: 'r-c', reason: 'silent' } } }, store);
    const stored = (await store.get('dead-run'))!;
    expect(stored.nodes[2]).toMatchObject({ state: 'reverted', code: 'SELF_UPGRADE_REVERTED', failureClass: 'release', awaitingReport: false });
    expect(stored.status).toBe('interrupted');
    const { run: retried, done } = await service.retryUpgradeRun('dead-run', { actorId: 'admin', store, deps: world.deps, allowRetryReverted: true });
    expect(retried.nodes.map(entry => entry.nodeId).sort()).toEqual(['c', 'd']);
    expect((await done).status).toBe('succeeded');
  });

  it('updates a finished run when a late report arrives: a lost reply that confirms turns partial into succeeded', async () => {
    const { run, store } = await start({ a: {}, lost: { reply: ['lost'], after: 'never-reports' } });
    expect(run.status).toBe('partial');
    let metadata = '{}';
    db.node.findUnique.mockImplementation(async () => ({ metadata }));
    db.node.update.mockImplementation(async ({ data }: { data: { metadata: string } }) => { metadata = data.metadata; });
    db.agent.findUnique.mockImplementation(async () => ({ status: 'RUNNING' }));
    await service.recordSelfUpgradeReport({ id: 'lost', name: 'lost' }, { selfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true,
      upgrade: { state: 'confirmed', to: TARGET, requestId: node(run, 'lost')!.requestId } } }, store);
    expect(await store.get(run.id)).toMatchObject({ status: 'succeeded', attention: [] });
    expect(node((await store.get(run.id))!, 'lost')?.detail).toMatch(/after the run stopped watching/);
  });
});

describe('a partial run', () => {
  it('retries just the nodes that need it, including the ones the check held back', async () => {
    const agents: Record<string, Agent> = { good: {}, refused: { reply: ['busy', 'busy', 'busy', 'accept'] }, stuck: { enrollment: draining } };
    const { run, store, world } = await start(agents);
    expect(run.status).toBe('partial');
    agents['stuck']!.enrollment = { state: 'enrolled', nodeFqdn: 'stuck.example.com', startedAt: new Date(0), updatedAt: new Date(0) };
    const { run: next, done } = await service.retryUpgradeRun(run.id, { actorId: 'admin', store, deps: world.deps });
    expect(next.retryOf).toBe(run.id);
    expect(next.nodes.map(entry => entry.nodeId).sort()).toEqual(['refused', 'stuck']);
    expect(await done).toMatchObject({ status: 'succeeded', retryOf: run.id });
  });
});

describe('the dry run', () => {
  it('reports every node with its problems and starts nothing', async () => {
    const world = fleet({ fine: {}, stale: { ledgerFence: 77n }, stuck: { enrollment: draining }, old: { preflight: 'old-agent-404' } });
    const report = await service.checkUpgrade({ version: TARGET, integrity: INTEGRITY, deps: world.deps });
    expect(world.log).toEqual([]);
    expect(world.leases).toEqual([]);
    expect(world.fences.has('node:stale')).toBe(false);
    expect(report.eligible).toBe(3);
    expect(report.blocked).toBe(1);
    expect(report.nodes.find(entry => entry.nodeId === 'stale')?.preflight?.problems).toEqual([expect.objectContaining({ code: 'FENCE_AHEAD', blocking: false })]);
    expect(report.nodes.find(entry => entry.nodeId === 'old')?.preflight?.status).toBe('unavailable');
    expect(report.nodes.find(entry => entry.nodeId === 'stuck')).toMatchObject({ eligible: false, code: 'ENROLLMENT_DRAINING', remedy: expect.stringMatching(/complete/) });
  });
});
