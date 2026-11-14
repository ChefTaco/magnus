import { describe, expect, it, vi } from 'vitest';
vi.mock('./audit-service.js', () => ({ logAuditEvent: vi.fn(async () => undefined) }));
const db = vi.hoisted(() => ({
  node: { findMany: vi.fn(async () => [] as unknown[]), findUnique: vi.fn(), update: vi.fn() },
  agent: { findUnique: vi.fn(), updateMany: vi.fn() },
  commandResourceLease: { groupBy: vi.fn(async () => []) },
  resourceParticipantWork: { groupBy: vi.fn(async () => []) },
  managedCronDefinition: { groupBy: vi.fn(async () => []) },
  nodeCredential: { findMany: vi.fn(async () => [] as Array<{ nodeId: string }>) },
}));
vi.mock('../db/client.js', () => ({ getDb: () => db }));
vi.mock('../config/features.js', () => ({ upgradeSettings: () => ({ agentUpgrades: true, agentUpgradeConcurrency: 2, agentUpgradeMaxFailures: 2, updateRegistry: 'https://registry.example.com' }) }));
const server = await import('../security/node-request-auth.js').then(auth => auth.generateSigningKey());
vi.mock('./node-server-key.js', async () => {
  const auth = await import('../security/node-request-auth.js');
  return { serverSigningKey: () => ({ keyId: server.keyId, publicKey: server.publicKey, privateKey: auth.privateKeyFromPem(server.privateKeyPem) }) };
});
const service = await import('./agent-upgrade-service.js');
const { agentMajorUpgradeSigningPayload, verifyServerAuthorization } = await import('../security/node-evidence.js');
import type { AgentUpgradeBody, CandidateRow, StoredSelfUpgrade, UpgradeDeps, UpgradeRun } from './agent-upgrade-service.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const report = (extra: Partial<StoredSelfUpgrade> = {}) => JSON.stringify({ agentSelfUpgrade: {
  protocol: 1, launcherProtocol: 2, layout: 'versioned', enabled: true, reason: null, upgrade: { state: 'idle', from: null, to: '2.10.3' },
  nodeVersion: 'v24.22.3', observedAt: '2026-11-14T00:00:00.000Z', ...extra } });
const row = (version: string, extra: Partial<CandidateRow> = {}, reportExtra: Partial<StoredSelfUpgrade> = {}): CandidateRow => ({ id: 'n1', name: 'node-1',
  hostname: 'node-1.example.com', status: 'ONLINE', lastHeartbeatAt: new Date(), metadata: report(reportExtra), agent: { version }, ...extra });

describe('major agent upgrades', () => {
  it('leaves a major change out unless allowMajor, and then needs 2.10.3 and an active node key', () => {
    const ready = row('2.10.3', { keyed: true }, { majorUpgradeAuthorization: 1 });
    expect(service.classifyCandidate(ready, '3.0.1')).toMatchObject({ eligible: false, code: 'MAJOR_VERSION', reason: expect.stringMatching(/--allow-major/) });
    expect(service.classifyCandidate(ready, '3.0.1', { allowMajor: true })).toMatchObject({ eligible: true, code: null });
    // 2.10.0 to 2.10.2 cannot verify an authorization: the stepping stone first.
    for (const version of ['2.10.0', '2.10.1', '2.10.2'])
      expect(service.classifyCandidate(row(version, { keyed: true }), '3.0.1', { allowMajor: true }))
        .toMatchObject({ eligible: false, code: 'MAJOR_NEEDS_STEPPING_STONE', reason: expect.stringMatching(/to 2\.10\.3 first/) });
    expect(service.classifyCandidate(row('2.10.3', { keyed: false }, { majorUpgradeAuthorization: 1 }), '3.0.1', { allowMajor: true }))
      .toMatchObject({ eligible: false, code: 'MAJOR_NEEDS_NODE_KEY' });
    // A patch within the major is unaffected, from a 3.x server too.
    expect(service.classifyCandidate(row('2.10.2'), '2.10.3')).toMatchObject({ eligible: true });
    expect(service.classifyCandidate(row('2.10.2'), '2.10.3', { allowMajor: true })).toMatchObject({ eligible: true });
    // allowMajor never permits a downgrade.
    expect(service.classifyCandidate(row('3.0.1'), '2.10.3', { allowMajor: true })).toMatchObject({ code: 'DOWNGRADE' });
    expect(service.steppingStone('2.9.1')).toBe('2.10.3');
  });

  it('reads the node keys only for a major run', async () => {
    db.node.findMany.mockResolvedValueOnce([{ ...row('2.10.3', {}, { majorUpgradeAuthorization: 1 }), resourceEnrollment: null, admissionFence: null }]);
    db.nodeCredential.findMany.mockResolvedValueOnce([{ nodeId: 'n1' }]);
    expect(await service.listUpgradeCandidates('3.0.1', undefined, { allowMajor: true })).toMatchObject([{ eligible: true }]);
    db.node.findMany.mockResolvedValueOnce([{ ...row('2.10.3', {}, { majorUpgradeAuthorization: 1 }), resourceEnrollment: null, admissionFence: null }]);
    db.nodeCredential.findMany.mockResolvedValueOnce([]);
    expect(await service.listUpgradeCandidates('3.0.1', undefined, { allowMajor: true })).toMatchObject([{ eligible: false, code: 'MAJOR_NEEDS_NODE_KEY' }]);
    db.nodeCredential.findMany.mockClear();
    db.node.findMany.mockResolvedValueOnce([{ ...row('2.10.2'), resourceEnrollment: null, admissionFence: null }]);
    expect(await service.listUpgradeCandidates('2.10.3')).toMatchObject([{ eligible: true }]);
    expect(db.nodeCredential.findMany).not.toHaveBeenCalled();
  });

  it('signs an authorization for exactly one node, version change and tarball, valid for an hour', () => {
    const now = 1_794_000_000_000;
    const decision = { nodeId: 'n1', from: '2.10.3', to: '3.0.1', integrity: INTEGRITY };
    const authorization = service.authorizeMajorUpgrade(decision, now);
    expect(authorization.expiresAt).toBe(now + service.MAJOR_AUTHORIZATION_TTL_MS);
    const payload = (extra: Partial<typeof decision> = {}) => agentMajorUpgradeSigningPayload({ ...decision, ...extra, packageName: '@hivemagnus/magnus-agent', expiresAt: authorization.expiresAt });
    const verify = (text: string, expectedNodeId = 'n1') => verifyServerAuthorization('agent-major-upgrade',
      { signature: authorization.serverSignature, publicKey: server.publicKey, expectedNodeId, payload: text });
    expect(verify(payload())).toEqual({ ok: true });
    expect(verify(payload(), 'n2')).toEqual({ ok: false, reason: 'NODE_MISMATCH' });
    expect(verify(payload({ to: '3.0.2' }))).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify(payload({ from: '2.10.2' }))).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify(payload({ integrity: `sha512-${'B'.repeat(86)}==` }))).toEqual({ ok: false, reason: 'SIGNATURE' });
  });

  it('sends the authorization only to agents crossing a major version in a run that allows it', async () => {
    const bodies = new Map<string, AgentUpgradeBody>();
    let clock = 0;
    const deps: UpgradeDeps = {
      request: async (nodeId, body) => { bodies.set(nodeId, body); },
      observe: async nodeId => ({ version: '3.0.1', report: { upgrade: { state: 'confirmed', requestId: bodies.get(nodeId)?.requestId ?? null, from: null, to: '3.0.1' } } as StoredSelfUpgrade }),
      check: async () => null, sleep: async ms => { clock += ms; }, now: () => clock, save: async () => undefined, stopRequested: async () => null,
      confirmTimeoutMs: 60_000, pollMs: 5_000,
    };
    const run = (allowMajor: boolean): UpgradeRun => ({ id: 'run', version: '3.0.1', integrity: INTEGRITY, actorId: 'admin', status: 'running', startedAt: '', finishedAt: null,
      concurrency: 2, message: null, ...(allowMajor ? { allowMajor } : {}),
      nodes: [{ nodeId: 'major', name: 'major', from: '2.10.3', state: 'pending', requestId: 'r1', detail: null },
        { nodeId: 'same', name: 'same', from: '3.0.0', state: 'pending', requestId: 'r2', detail: null }] });
    const done = await service.executeUpgradeRun(run(true), deps);
    expect(done.nodes.map(node => node.state)).toEqual(['confirmed', 'confirmed']);
    expect(bodies.get('major')?.majorAuthorization?.serverSignature).toMatchObject({ alg: 'ed25519', nodeId: 'major', keyId: server.keyId });
    expect(bodies.get('same')?.majorAuthorization).toBeUndefined();
    bodies.clear();
    await service.executeUpgradeRun(run(false), deps);
    expect(bodies.get('major')?.majorAuthorization).toBeUndefined();
  });

  it('refuses the node, and sends nothing, when the authorization cannot be signed', async () => {
    const requested: string[] = [];
    const deps: UpgradeDeps = {
      request: async nodeId => { requested.push(nodeId); },
      authorizeMajor: () => { throw new Error('server signing key is unavailable'); },
      observe: async () => ({ version: '2.10.3', report: null }), check: async () => null, sleep: async () => undefined, now: () => 0,
      save: async () => undefined, stopRequested: async () => null, confirmTimeoutMs: 60_000, pollMs: 5_000,
    };
    const done = await service.executeUpgradeRun({ id: 'run', version: '3.0.1', integrity: INTEGRITY, actorId: 'admin', status: 'running', startedAt: '', finishedAt: null,
      concurrency: 1, message: null, allowMajor: true, nodes: [{ nodeId: 'major', name: 'major', from: '2.10.3', state: 'pending', requestId: 'r1', detail: null }] }, deps);
    expect(requested).toEqual([]);
    expect(done.nodes[0]).toMatchObject({ state: 'refused', code: 'SERVER_KEY_UNAVAILABLE' });
  });
});
