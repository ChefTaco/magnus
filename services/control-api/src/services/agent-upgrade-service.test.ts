import { describe, expect, it, vi } from 'vitest';
vi.mock('./audit-service.js', () => ({ logAuditEvent: vi.fn(async () => undefined) }));
const { classifyCandidate, executeUpgradeRun, resolveAgentRelease } = await import('./agent-upgrade-service.js');
import type { StoredSelfUpgrade, UpgradeDeps, UpgradeRun } from './agent-upgrade-service.js';

const report = (extra: Partial<StoredSelfUpgrade> = {}) => JSON.stringify({ agentSelfUpgrade: {
  protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, reason: null, upgrade: { state: 'idle', from: null, to: '1.1.0' },
  nodeVersion: 'v24.22.1', observedAt: '2026-11-01T00:00:00.000Z', ...extra } });
const row = (extra: Record<string, unknown> = {}) => ({ id: 'n1', name: 'node-1', status: 'ONLINE', lastHeartbeatAt: new Date(), metadata: report(),
  agent: { version: '1.1.0' }, ...extra });

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
});

describe('agent release resolution', () => {
  it('reads the exact integrity from the registry, or takes an explicit one', async () => {
    const integrity = 'sha512-' + 'A'.repeat(86) + '==';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ dist: { integrity } })));
    await expect(resolveAgentRelease({ version: '1.1.0', fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({ version: '1.1.0', integrity });
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toMatch(/@hivemagnus%2fmagnus-agent\/1\.1\.0$/);
    await expect(resolveAgentRelease({ version: '1.1.0', integrity: 'md5-x' })).rejects.toThrow(/sha512/);
    await expect(resolveAgentRelease({ version: 'latest' })).rejects.toThrow(/X\.Y\.Z/);
  });
});

function makeRun(names: string[]): UpgradeRun {
  return { id: 'run', version: '1.1.1', integrity: 'sha512-x', actorId: 'admin', status: 'running', startedAt: '', finishedAt: null, concurrency: 2,
    message: null, nodes: names.map(name => ({ nodeId: name, name, from: '1.1.0', state: 'pending', requestId: `req-${name}`, detail: null })) };
}

function makeDeps(outcome: Record<string, 'confirm' | 'revert' | 'silent'>): UpgradeDeps & { requested: string[] } {
  let clock = 0;
  const requested: string[] = [];
  return {
    requested,
    request: async nodeId => { requested.push(nodeId); },
    observe: async nodeId => {
      const kind = outcome[nodeId];
      if (kind === 'confirm') return { version: '1.1.1', report: { upgrade: { state: 'confirmed', requestId: `req-${nodeId}`, from: '1.1.0', to: '1.1.1' } } as StoredSelfUpgrade };
      if (kind === 'revert') return { version: '1.1.0', report: { upgrade: { state: 'reverted', requestId: `req-${nodeId}`, reason: 'no heartbeat' } } as StoredSelfUpgrade };
      return { version: '1.1.0', report: null };
    },
    sleep: async ms => { clock += ms; },
    now: () => clock,
    save: async () => undefined,
    confirmTimeoutMs: 60_000,
    pollMs: 5_000,
  };
}

describe('agent upgrade runs', () => {
  it('upgrades a canary first, then the rest in batches', async () => {
    const deps = makeDeps({ a: 'confirm', b: 'confirm', c: 'confirm', d: 'confirm' });
    const run = await executeUpgradeRun(makeRun(['a', 'b', 'c', 'd']), deps);
    expect(run.status).toBe('succeeded');
    expect(deps.requested[0]).toBe('a');
    expect(run.nodes.every(node => node.state === 'confirmed')).toBe(true);
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
    expect(run.nodes.find(node => node.nodeId === 'b')).toMatchObject({ state: 'failed', detail: expect.stringMatching(/no confirmation/) });
    expect(run.nodes.find(node => node.nodeId === 'd')?.state).toBe('skipped');
  });
});
