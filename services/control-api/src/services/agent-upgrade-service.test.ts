import { beforeEach, describe, expect, it, vi } from 'vitest';
const logAuditEvent = vi.fn(async (_event: { action: string; details?: Record<string, unknown> }) => undefined);
vi.mock('./audit-service.js', () => ({ logAuditEvent }));
const db = vi.hoisted(() => ({
  node: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  agent: { findUnique: vi.fn(), updateMany: vi.fn() },
  commandResourceLease: { groupBy: vi.fn(async () => []) },
  resourceParticipantWork: { groupBy: vi.fn(async () => []) },
  managedCronDefinition: { groupBy: vi.fn(async () => []) },
}));
vi.mock('../db/client.js', () => ({ getDb: () => db }));
vi.mock('../config/features.js', () => ({ upgradeSettings: () => ({ agentUpgrades: true, agentUpgradeConcurrency: 2, updateRegistry: 'https://registry.example.com' }) }));
const service = await import('./agent-upgrade-service.js');
const { classifyCandidate, classifyDispatchFailure, executeUpgradeRun, memoryRunStore, reconcileInterruptedRun, recordSelfUpgradeReport,
  resolveAgentRelease, retryUpgradeRun, startUpgradeRun, stopUpgradeRun, summarizeRun, parseSelfUpgradeStatus, confirmWindowMs } = service;
import type { CandidateRow, StoredSelfUpgrade, UpgradeDeps, UpgradeRun } from './agent-upgrade-service.js';
const { AgentResponseError, DispatchOutcomeUnknownError, NotDispatchedError } = await import('../sdk/node-api-client.js');

const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '==';
const report = (extra: Partial<StoredSelfUpgrade> = {}) => JSON.stringify({ agentSelfUpgrade: {
  protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, reason: null, upgrade: { state: 'idle', from: null, to: '1.1.0' },
  nodeVersion: 'v24.22.1', observedAt: '2026-11-01T00:00:00.000Z', ...extra } });
const row = (extra: Partial<CandidateRow> = {}): CandidateRow => ({ id: 'n1', name: 'node-1', hostname: 'node-1.example.com', status: 'ONLINE',
  lastHeartbeatAt: new Date(), metadata: report(), agent: { version: '1.1.0' }, ...extra });
const enrolled = { state: 'enrolled', nodeFqdn: 'node-1.example.com', startedAt: new Date('2026-05-01'), updatedAt: new Date('2026-05-01') };

beforeEach(() => { logAuditEvent.mockClear(); });

describe('agent upgrade eligibility', () => {
  it('greys out agents that cannot take the version, with the reason', () => {
    expect(classifyCandidate(row(), '1.1.1')).toMatchObject({ eligible: true, reason: null });
    expect(classifyCandidate(row({ status: 'OFFLINE' }), '1.1.1').reason).toMatch(/offline/);
    expect(classifyCandidate(row({ agent: { version: '1.1.1' } }), '1.1.1').reason).toBe('already on this version');
    expect(classifyCandidate(row(), '2.0.0').reason).toMatch(/crosses a major/);
    expect(classifyCandidate(row({ agent: { version: '1.2.0' } }), '1.1.1').reason).toMatch(/newer than/);
    expect(classifyCandidate(row({ metadata: '{}', agent: { version: '1.0.3' } }), '1.1.0').reason).toMatch(/install-service/);
    expect(classifyCandidate(row({ metadata: report({ enabled: false, reason: 'MAGNUS_AGENT_SELF_UPGRADE=false on this node' }) }), '1.1.1').reason)
      .toBe('MAGNUS_AGENT_SELF_UPGRADE=false on this node');
    expect(classifyCandidate(row({ metadata: report({ upgrade: { state: 'trial', from: '1.1.0', to: '1.1.1' } }) }), '1.1.2').reason).toMatch(/in progress/);
  });

  it('shares the dispatch preconditions: a draining enrollment is not eligible', () => {
    const draining = { ...enrolled, state: 'draining', startedAt: new Date('2026-06-03T10:00:00Z') };
    expect(classifyCandidate(row({ resourceEnrollment: draining }), '1.1.1', { leasesRequested: false }).reason)
      .toMatch(/resource enrollment stuck in draining since 2026-06-03/);
    expect(classifyCandidate(row({ resourceEnrollment: enrolled }), '1.1.1', { leasesRequested: false }).eligible).toBe(true);
    expect(classifyCandidate(row({ resourceEnrollment: { ...enrolled, nodeFqdn: 'other.example.com' } }), '1.1.1').reason).toMatch(/inventory host name/);
  });

  it('follows the legacy bypass rule: no enrollment is fine unless leases are on or the node has lease history', () => {
    expect(classifyCandidate(row(), '1.1.1', { leasesRequested: false }).eligible).toBe(true);
    expect(classifyCandidate(row(), '1.1.1', { leasesRequested: true }).reason).toMatch(/MAGNUS_RESOURCE_LEASES_ENABLED=true.*not enrolled/);
    expect(classifyCandidate(row({ leaseHistory: true }), '1.1.1', { leasesRequested: false }).reason).toMatch(/lease history/);
  });

  it('refuses fenced nodes and nodes with held work or leases', () => {
    expect(classifyCandidate(row({ admissionFence: { releaseId: 'rel-1', closedAt: new Date('2026-10-01T00:00:00Z') } }), '1.1.1').reason)
      .toMatch(/release rel-1 closed admission/);
    expect(classifyCandidate(row({ resourceEnrollment: enrolled, heldWork: 2 }), '1.1.1').reason).toMatch(/2 participant work/);
    expect(classifyCandidate(row({ resourceEnrollment: enrolled, heldLeases: 1 }), '1.1.1').reason).toMatch(/1 command lease/);
  });

  it('flags an agent whose sticky enrollment marker the server does not share', () => {
    const marker = { managedEnrollment: { nodeId: 'n1', nodeFqdn: 'node-1.example.com' } };
    const reason = classifyCandidate(row({ metadata: report(marker) }), '1.1.1', { leasesRequested: false }).reason;
    expect(reason).toMatch(/agent and server disagree about resource enrollment/);
    expect(reason).toMatch(/no enrollment row/);
    expect(classifyCandidate(row({ metadata: report(marker), resourceEnrollment: enrolled }), '1.1.1').eligible).toBe(true);
    expect(classifyCandidate(row({ metadata: report(marker), participantHistory: true }), '1.1.1', { leasesRequested: false }).reason)
      .toMatch(/answers this agent as enrolled because of participant work history/);
  });

  it('holds back nodes that reverted this exact version unless asked', () => {
    const metadata = report({ upgrade: { state: 'reverted', from: '1.1.0', to: '1.1.1', reason: 'no heartbeat', updatedAt: '2026-11-01T10:00:00Z' } });
    expect(classifyCandidate(row({ metadata }), '1.1.1').reason).toBe('reverted 1.1.1 at 2026-11-01T10:00:00Z: no heartbeat; try again only with allowRetryReverted');
    expect(classifyCandidate(row({ metadata }), '1.1.1', { allowRetryReverted: true }).eligible).toBe(true);
    expect(classifyCandidate(row({ metadata }), '1.1.2').eligible).toBe(true);
  });

  it('selects nothing for an empty node list', async () => {
    await expect(service.listUpgradeCandidates('1.1.1', [])).resolves.toEqual([]);
    expect(db.node.findMany).not.toHaveBeenCalled();
  });
});

describe('self-upgrade reports', () => {
  it('keeps a report with an unknown future state, and the report without a malformed upgrade entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const base = { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true };
    expect(parseSelfUpgradeStatus({ ...base, upgrade: { state: 'verifying', requestId: 'r' } })?.upgrade?.state).toBe('verifying');
    expect(parseSelfUpgradeStatus({ ...base, upgrade: { state: 7 } }, 'node-1')).toMatchObject({ enabled: true, upgrade: null });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/node-1 sent a self-upgrade report that does not parse/));
    warn.mockRestore();
  });

  it('restores the status the agent had before UPDATING, also when the report disappears', async () => {
    let metadata = JSON.stringify({});
    let status = 'STOPPED';
    db.node.findUnique.mockImplementation(async () => ({ metadata }));
    db.node.update.mockImplementation(async ({ data }: { data: { metadata: string } }) => { metadata = data.metadata; });
    db.agent.findUnique.mockImplementation(async () => ({ status }));
    db.agent.updateMany.mockImplementation(async ({ data }: { data: { status: string } }) => { status = data.status; return { count: 1 }; });
    const store = memoryRunStore();
    const trial = { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, upgrade: { state: 'trial', to: '1.1.1', requestId: 'r1' } };
    await recordSelfUpgradeReport({ id: 'n1', name: 'node-1' }, { selfUpgrade: trial }, store);
    expect(status).toBe('UPDATING');
    await recordSelfUpgradeReport({ id: 'n1', name: 'node-1' }, {}, store);
    expect(status).toBe('STOPPED');
  });

  it('records an outcome that arrives after its run ended, and audits it once', async () => {
    let metadata = JSON.stringify({});
    db.node.findUnique.mockImplementation(async () => ({ metadata }));
    db.node.update.mockImplementation(async ({ data }: { data: { metadata: string } }) => { metadata = data.metadata; });
    db.agent.findUnique.mockImplementation(async () => ({ status: 'RUNNING' }));
    const store = memoryRunStore();
    const run = makeRun(['a']);
    Object.assign(run, { status: 'interrupted' });
    Object.assign(run.nodes[0]!, { state: 'failed', code: 'RUN_INTERRUPTED', awaitingReport: true });
    await store.index(run);
    await store.save(run);
    const confirmed = { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, upgrade: { state: 'confirmed', to: '1.1.1', requestId: 'req-a' } };
    await recordSelfUpgradeReport({ id: 'a', name: 'a' }, { selfUpgrade: confirmed }, store);
    await recordSelfUpgradeReport({ id: 'a', name: 'a' }, { selfUpgrade: confirmed }, store);
    expect((await store.get('run'))!.nodes[0]).toMatchObject({ state: 'confirmed', awaitingReport: false, detail: expect.stringMatching(/after the run ended/) });
    expect(logAuditEvent.mock.calls.filter(([event]) => event.action === 'agent.upgrade.node_confirmed')).toHaveLength(1);
  });
});

describe('agent release resolution', () => {
  it('reads the exact integrity from the registry, or takes an explicit one', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ dist: { integrity: INTEGRITY } })));
    await expect(resolveAgentRelease({ version: '1.1.0', fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({ version: '1.1.0', integrity: INTEGRITY });
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toMatch(/@hivemagnus%2fmagnus-agent\/1\.1\.0$/);
    await expect(resolveAgentRelease({ version: '1.1.0', integrity: 'md5-x' })).rejects.toThrow(/sha512/);
    await expect(resolveAgentRelease({ version: 'latest' })).rejects.toThrow(/X\.Y\.Z/);
  });

  it('marks an unpublished version as unverified', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(service.verifyAgentRelease('9.9.9', fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({ verified: false, reason: expect.stringMatching(/not published/) });
  });
});

function makeRun(names: string[]): UpgradeRun {
  return { id: 'run', version: '1.1.1', integrity: 'sha512-x', actorId: 'admin', status: 'running', startedAt: '', finishedAt: null, concurrency: 2,
    message: null, nodes: names.map(name => ({ nodeId: name, name, from: '1.1.0', state: 'pending', requestId: `req-${name}`, detail: null })) };
}

type Outcome = 'confirm' | 'revert' | 'silent' | 'refuse' | 'integrity' | 'lost' | 'ineligible' | 'version-only' | 'other-request' | 'observe-error';
function makeDeps(outcome: Record<string, Outcome>, extra: Partial<UpgradeDeps> = {}): UpgradeDeps & { requested: string[]; clock: () => number } {
  let clock = 0;
  const requested: string[] = [];
  const requestIds = new Map<string, string>();
  const rid = (nodeId: string) => requestIds.get(nodeId) ?? `req-${nodeId}`;
  const confirmed = (nodeId: string) => ({ version: '1.1.1', report: { upgrade: { state: 'confirmed', requestId: rid(nodeId), from: '1.1.0', to: '1.1.1' } } as StoredSelfUpgrade });
  return {
    requested,
    clock: () => clock,
    request: async (nodeId, body) => {
      requested.push(nodeId);
      requestIds.set(nodeId, body.requestId);
      const kind = outcome[nodeId];
      if (kind === 'refuse') throw new AgentResponseError(409, { code: 'UNMANAGED_MUTATION', message: 'Enrolled node requires the reviewed managed mutation boundary' });
      if (kind === 'integrity') throw new AgentResponseError(422, { code: 'SELF_UPGRADE_INTEGRITY', message: 'integrity differs' });
      if (kind === 'lost') throw new DispatchOutcomeUnknownError('socket hang up');
    },
    observe: async nodeId => {
      const kind = outcome[nodeId];
      if (kind === 'observe-error' && clock < 20_000) throw new Error('database unavailable');
      if (kind === 'confirm' || kind === 'lost' || kind === 'observe-error') return confirmed(nodeId);
      if (kind === 'revert') return { version: '1.1.0', report: { upgrade: { state: 'reverted', requestId: rid(nodeId), reason: 'no heartbeat' } } as StoredSelfUpgrade };
      if (kind === 'version-only') return { version: '1.1.1', report: null };
      if (kind === 'other-request') return { version: '1.1.1', report: { upgrade: { state: 'idle', requestId: 'someone-else' } } as StoredSelfUpgrade };
      return { version: '1.1.0', report: null, lastHeartbeatAt: new Date(clock) };
    },
    check: async nodeId => outcome[nodeId] === 'ineligible' ? 'offline or no recent heartbeat' : null,
    sleep: async ms => { clock += ms; },
    now: () => clock,
    save: async () => undefined,
    stopRequested: async () => null,
    confirmTimeoutMs: 60_000,
    pollMs: 5_000,
    ...extra,
  };
}

describe('agent upgrade runs', () => {
  it('upgrades a canary first, then the rest in batches', async () => {
    const deps = makeDeps({ a: 'confirm', b: 'confirm', c: 'confirm', d: 'confirm' });
    const run = await executeUpgradeRun(makeRun(['a', 'b', 'c', 'd']), deps);
    expect(run.status).toBe('succeeded');
    expect(deps.requested[0]).toBe('a');
    expect(run.nodes.every(node => node.state === 'confirmed')).toBe(true);
    expect(run.summary).toBe('4 confirmed, 0 refused, 0 failed, 0 skipped');
  });

  it('touches nothing else when the canary reverts', async () => {
    const deps = makeDeps({ a: 'revert', b: 'confirm' });
    const run = await executeUpgradeRun(makeRun(['a', 'b']), deps);
    expect(run).toMatchObject({ status: 'failed', message: expect.stringMatching(/canary a did not confirm/) });
    expect(deps.requested).toEqual(['a']);
    expect(run.nodes[1]?.state).toBe('skipped');
  });

  it('stops after a batch with a node that never confirms', async () => {
    const deps = makeDeps({ a: 'confirm', b: 'silent', c: 'confirm', d: 'confirm' });
    const run = await executeUpgradeRun(makeRun(['a', 'b', 'c', 'd']), deps);
    expect(run.status).toBe('failed');
    expect(run.nodes.find(node => node.nodeId === 'b')).toMatchObject({ state: 'failed', awaitingReport: true });
    expect(run.nodes.find(node => node.nodeId === 'd')?.state).toBe('skipped');
  });

  it('records a refusal with the agent code and message and keeps going; a refused canary hands the role on', async () => {
    const deps = makeDeps({ a: 'refuse', b: 'confirm', c: 'refuse', d: 'confirm' });
    const run = await executeUpgradeRun(makeRun(['a', 'b', 'c', 'd']), deps);
    expect(run.status).toBe('succeeded');
    expect(run.canaryNodeId).toBe('b');
    expect(run.nodes[0]).toMatchObject({ state: 'refused', code: 'UNMANAGED_MUTATION', detail: 'Enrolled node requires the reviewed managed mutation boundary' });
    expect(run.summary).toBe('2 confirmed, 2 refused, 0 failed, 0 skipped; refused: a (UNMANAGED_MUTATION: Enrolled node requires the reviewed managed mutation boundary); '
      + 'c (UNMANAGED_MUTATION: Enrolled node requires the reviewed managed mutation boundary)');
    expect(logAuditEvent.mock.calls.filter(([event]) => event.action === 'agent.upgrade.node_refused')).toHaveLength(2);
    expect(logAuditEvent.mock.calls.some(([event]) => event.action === 'agent.upgrade_run.finished')).toBe(true);
  });

  it('counts a request that never left the server as refused', async () => {
    const deps = makeDeps({ a: 'confirm', b: 'confirm' }, {
      request: async nodeId => { if (nodeId === 'a') throw new NotDispatchedError('RESOURCE_ENROLLMENT_REQUIRED', 'Verified participant drain enrollment is required'); },
    });
    const run = await executeUpgradeRun(makeRun(['a', 'b']), deps);
    expect(run.nodes[0]).toMatchObject({ state: 'refused', code: 'RESOURCE_ENROLLMENT_REQUIRED' });
    expect(run.nodes[1]?.state).toBe('confirmed');
  });

  it('stops the wave on a release problem', async () => {
    const run = await executeUpgradeRun(makeRun(['a', 'b', 'c']), makeDeps({ a: 'confirm', b: 'integrity', c: 'confirm' }));
    expect(run.status).toBe('failed');
    expect(run.nodes[1]).toMatchObject({ state: 'failed', code: 'SELF_UPGRADE_INTEGRITY' });
  });

  it('reports a run where every node refused as failed', async () => {
    const run = await executeUpgradeRun(makeRun(['a', 'b']), makeDeps({ a: 'refuse', b: 'refuse' }));
    expect(run).toMatchObject({ status: 'failed', message: expect.stringMatching(/no agent was upgraded/) });
  });

  it('skips a node that became ineligible at its turn and goes on', async () => {
    const deps = makeDeps({ a: 'confirm', b: 'ineligible', c: 'confirm' });
    const run = await executeUpgradeRun(makeRun(['a', 'b', 'c']), deps);
    expect(run.status).toBe('succeeded');
    expect(run.nodes[1]).toMatchObject({ state: 'skipped', detail: 'offline or no recent heartbeat' });
    expect(deps.requested).toEqual(['a', 'c']);
  });

  it('follows a node whose reply was lost through its heartbeat report', async () => {
    const run = await executeUpgradeRun(makeRun(['a']), makeDeps({ a: 'lost' }));
    expect(run.nodes[0]).toMatchObject({ state: 'confirmed', detail: expect.stringMatching(/reply to the request was lost/) });
  });

  it('confirms only on the agent reporting this request, or on the version alone after a full window when it reports none', async () => {
    const other = await executeUpgradeRun(makeRun(['a']), makeDeps({ a: 'other-request' }));
    expect(other.nodes[0]?.state).toBe('failed');
    const deps = makeDeps({ a: 'version-only' }, { confirmTimeoutMs: 30_000 });
    const versionOnly = await executeUpgradeRun(makeRun(['a']), deps);
    expect(versionOnly.nodes[0]).toMatchObject({ state: 'confirmed', detail: expect.stringMatching(/confirmed by version/) });
    expect(deps.clock()).toBeGreaterThanOrEqual(30_000);
  });

  it('survives a failing observation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = await executeUpgradeRun(makeRun(['a']), makeDeps({ a: 'observe-error' }));
    expect(run.nodes[0]?.state).toBe('confirmed');
    warn.mockRestore();
  });

  it('closes the run through finish when something unexpected throws', async () => {
    const run = await executeUpgradeRun(makeRun(['a', 'b']), makeDeps({ a: 'confirm', b: 'confirm' }, {
      save: async saved => { if (saved.nodes[0]?.state === 'confirmed' && saved.status === 'running') throw new Error('redis gone'); },
    }));
    expect(run.status).toBe('failed');
    expect(run.message).toMatch(/run aborted: redis gone/);
    expect(run.nodes[1]?.state).toBe('skipped');
  });

  it('stops between batches when asked', async () => {
    let stop: string | null = null;
    const deps = makeDeps({ a: 'confirm', b: 'confirm', c: 'confirm', d: 'confirm' }, { stopRequested: async () => stop });
    const save = deps.save;
    deps.save = async saved => { if (saved.nodes[0]?.state === 'confirmed') stop = 'admin'; await save(saved); };
    const run = await executeUpgradeRun(makeRun(['a', 'b', 'c', 'd']), deps);
    expect(run).toMatchObject({ status: 'stopped', stopRequestedBy: 'admin' });
    expect(run.nodes.slice(1).every(node => node.state === 'skipped')).toBe(true);
    expect(logAuditEvent.mock.calls.some(([event]) => event.action === 'agent.upgrade_run.stopped')).toBe(true);
  });

  it('uses the trial window the agent reports', () => {
    expect(confirmWindowMs({ confirmSeconds: 600 })).toBe(600_000 + 60_000 + 120_000);
    expect(confirmWindowMs(null)).toBe(180_000 + 60_000 + 120_000);
  });

  it('gives up early on an agent that stopped sending heartbeats', async () => {
    const deps = makeDeps({ a: 'lost' }, { observe: async () => ({ version: '1.1.0', report: null, lastHeartbeatAt: new Date(0) }) });
    const run = await executeUpgradeRun(makeRun(['a']), deps);
    expect(run.nodes[0]).toMatchObject({ state: 'failed', code: 'AGENT_SILENT', awaitingReport: true });
    expect(deps.clock()).toBeLessThan(2 * 60_000);
  });
});

describe('dispatch failure classes', () => {
  it('sorts agent codes into refused, release problems and unknown', () => {
    expect(classifyDispatchFailure(new AgentResponseError(409, { code: 'SELF_UPGRADE_BUSY', message: 'busy' })).kind).toBe('refused');
    expect(classifyDispatchFailure(new AgentResponseError(500, { code: 'SELF_UPGRADE_FAILED', message: 'x' })).kind).toBe('failed');
    expect(classifyDispatchFailure(new AgentResponseError(409, { code: 'MUTATION_OUTCOME_UNKNOWN', message: 'x' })).kind).toBe('unknown');
    expect(classifyDispatchFailure(new AgentResponseError(400, { code: 'VALIDATION_ERROR', message: 'x' })).kind).toBe('failed');
    expect(classifyDispatchFailure(new Error('weird')).kind).toBe('unknown');
  });

  it('summarizes refusals', () => {
    const run = makeRun(['a']);
    Object.assign(run.nodes[0]!, { state: 'refused', code: 'RESOURCE_BUSY', detail: 'busy' });
    expect(summarizeRun(run)).toBe('0 confirmed, 1 refused, 0 failed, 0 skipped; refused: a (RESOURCE_BUSY: busy)');
  });
});

describe('run lifecycle', () => {
  const candidates = (names: string[], extra: Partial<CandidateRow> = {}) => names.map(name => ({ ...row({ id: name, name, ...extra }) }));

  beforeEach(() => {
    db.node.findMany.mockImplementation(async ({ where }: { where: { id: { in?: string[] } } }) =>
      candidates(['a', 'b', 'c']).filter(node => !where.id.in || where.id.in.includes(node.id)));
  });

  it('rejects unknown ids, reports excluded nodes and honours the canary', async () => {
    const store = memoryRunStore();
    await expect(startUpgradeRun({ version: '1.1.1', integrity: INTEGRITY, nodeIds: ['a', 'zzz'], actorId: 'admin', store, deps: makeDeps({}) }))
      .rejects.toMatchObject({ code: 'UNKNOWN_NODES' });
    db.node.findMany.mockImplementation(async () => [...candidates(['a', 'c']), row({ id: 'b', name: 'b', status: 'OFFLINE' })]);
    const { run, done } = await startUpgradeRun({ version: '1.1.1', integrity: INTEGRITY, nodeIds: ['a', 'b', 'c'], canaryNodeId: 'c', actorId: 'admin', store,
      deps: makeDeps({ a: 'confirm', c: 'confirm' }) });
    expect(run.excluded).toEqual([{ nodeId: 'b', name: 'b', reason: expect.stringMatching(/offline/) }]);
    expect(run.nodes.map(node => node.nodeId)).toEqual(['c', 'a']);
    await done;
  });

  it('treats an empty selection as none and needs an opt-in for prereleases', async () => {
    await expect(startUpgradeRun({ version: '1.1.1', integrity: INTEGRITY, nodeIds: [], actorId: 'admin', store: memoryRunStore() }))
      .rejects.toMatchObject({ code: 'NO_NODES_SELECTED' });
    await expect(startUpgradeRun({ version: '1.2.0-rc.1', integrity: INTEGRITY, actorId: 'admin', store: memoryRunStore() }))
      .rejects.toMatchObject({ code: 'PRERELEASE_NOT_ALLOWED' });
  });

  it('lets only one run start at a time, even when two start together', async () => {
    const store = memoryRunStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const deps = makeDeps({ a: 'confirm', b: 'confirm', c: 'confirm' }, { sleep: async () => { await gate; await new Promise(resolve => setTimeout(resolve, 0)); } });
    const results = await Promise.allSettled([
      startUpgradeRun({ version: '1.1.1', integrity: INTEGRITY, actorId: 'admin', store, deps }),
      startUpgradeRun({ version: '1.1.1', integrity: INTEGRITY, actorId: 'admin', store, deps }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'AGENT_UPGRADE_RUNNING' } });
    release();
    await (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ done: Promise<UpgradeRun> }>).value.done;
    // Lock released: the next run may start.
    const next = await startUpgradeRun({ version: '1.1.1', integrity: INTEGRITY, actorId: 'admin', store, deps: makeDeps({ a: 'confirm', b: 'confirm', c: 'confirm' }) });
    await next.done;
  });

  it('marks an abandoned run interrupted and settles its nodes from stored reports', async () => {
    const run = makeRun(['a', 'b', 'c']);
    Object.assign(run, { leaseExpiresAt: new Date(1_000).toISOString() });
    Object.assign(run.nodes[0]!, { state: 'requested' });
    Object.assign(run.nodes[1]!, { state: 'requested' });
    const saved: UpgradeRun[] = [];
    const observe = async (nodeId: string) => nodeId === 'a'
      ? { version: '1.1.1', report: { upgrade: { state: 'confirmed', requestId: 'req-a' } } as StoredSelfUpgrade }
      : { version: '1.1.0', report: null };
    const result = await reconcileInterruptedRun(run, observe, async value => { saved.push(value); }, 10_000);
    expect(result.status).toBe('interrupted');
    expect(result.nodes.map(node => node.state)).toEqual(['confirmed', 'failed', 'skipped']);
    expect(result.nodes[1]).toMatchObject({ code: 'RUN_INTERRUPTED', awaitingReport: true });
    expect(saved).toHaveLength(1);
    const live = makeRun(['a']);
    Object.assign(live, { leaseExpiresAt: new Date(20_000).toISOString() });
    expect((await reconcileInterruptedRun(live, observe, async () => undefined, 10_000)).status).toBe('running');
  });

  it('stops a running run on request and retries what a finished run did not upgrade', async () => {
    const store = memoryRunStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const deps = makeDeps({ a: 'confirm', b: 'refuse', c: 'confirm' }, {
      sleep: async () => { if (first) { first = false; await gate; } await new Promise(resolve => setTimeout(resolve, 0)); },
      stopRequested: id => store.stopRequested(id),
      save: saved => store.save(saved),
    });
    const { run, done } = await startUpgradeRun({ version: '1.1.1', integrity: INTEGRITY, actorId: 'admin', store, deps });
    await stopUpgradeRun(run.id, 'admin', store);
    release();
    const stopped = await done;
    expect(stopped.status).toBe('stopped');
    await expect(stopUpgradeRun(run.id, 'admin', store)).rejects.toMatchObject({ code: 'RUN_NOT_RUNNING' });
    const retry = await retryUpgradeRun(run.id, { actorId: 'admin', store, deps: makeDeps({ b: 'confirm', c: 'confirm' }) });
    expect(retry.run).toMatchObject({ retryOf: run.id, version: '1.1.1', integrity: INTEGRITY });
    expect(retry.run.nodes.map(node => node.nodeId).sort()).toEqual(['b', 'c']);
    await retry.done;
  });
});

