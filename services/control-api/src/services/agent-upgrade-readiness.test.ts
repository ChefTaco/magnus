import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ node: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() }, resourceEnrollment: { findMany: vi.fn(async () => []) }, commandResourceFence: { findMany: vi.fn(async () => []) },
  commandResourceLease: { groupBy: vi.fn(async () => []) }, $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: vi.fn(async () => 1), node: db.node })) }));
vi.mock('../db/index.js', () => ({ getDb: () => db }));
vi.mock('../db/client.js', () => ({ getDb: () => db }));
const createNotificationInTransaction = vi.hoisted(() => vi.fn(async () => 'id'));
vi.mock('./notification-service.js', () => ({ createNotificationInTransaction }));
const features = vi.hoisted(() => ({ agentUpgrades: true }));
vi.mock('../config/features.js', () => ({ upgradeSettings: () => ({ agentUpgrades: features.agentUpgrades }) }));
vi.mock('./maintenance-service.js', () => ({ matchingMaintenance: vi.fn(async () => null) }));
const { checkUpgradeReadiness, computeUpgradeReadiness, readinessOfNodes, NOT_READY_NOTIFY_MS } = await import('./agent-upgrade-readiness.js');

const NOW = Date.parse('2026-11-02T00:00:00Z');
const report = (extra: Record<string, unknown> = {}) => JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true,
  npm: { present: true, version: '11.0.0' }, disk: { freeBytes: 10 ** 10, requiredBytes: 10 ** 8, low: false }, ledger: { readable: true, activeLock: null, unresolvedReceipts: 0 }, observedAt: '2026-11-01T23:59:00.000Z', ...extra } });
const input = (extra: Partial<Parameters<typeof computeUpgradeReadiness>[0]> = {}) => ({ id: 'n1', hostname: 'node-1.example.com', metadata: report(), now: NOW, ...extra });
const codes = (extra: Partial<Parameters<typeof computeUpgradeReadiness>[0]>) => computeUpgradeReadiness(input(extra)).problems.map(problem => problem.code);

describe('upgrade readiness', () => {
  it('is ok for a clean report, and unknown for an agent that does not report it', () => {
    expect(computeUpgradeReadiness(input())).toMatchObject({ status: 'ok', problems: [] });
    expect(computeUpgradeReadiness(input({ metadata: '{}' })).status).toBe('unknown');
    expect(computeUpgradeReadiness(input({ metadata: JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true } }) })).status).toBe('unknown');
  });

  it('names an enrollment stuck draining, with its age and remedy', () => {
    const since = new Date('2026-10-23T00:00:00Z');
    const readiness = computeUpgradeReadiness(input({ enrollment: { state: 'draining', nodeFqdn: 'node-1.example.com', startedAt: since, updatedAt: since } }));
    expect(readiness.status).toBe('not-ready');
    expect(readiness.problems[0]).toMatchObject({ code: 'ENROLLMENT_DRAINING', detail: expect.stringMatching(/10 day\(s\), since 2026-10-23/), remedy: expect.stringMatching(/complete/) });
  });

  it('names a marker the server does not share, a fence ahead, an unresolved ledger, low disk and missing npm', () => {
    expect(codes({ metadata: report({ managedEnrollment: { nodeId: 'n1', nodeFqdn: 'node-1.example.com' } }) })).toEqual(['ENROLLMENT_MARKER_MISMATCH']);
    expect(codes({ metadata: report({ fenceHighWater: { 'node:n1': '1789962351090' } }), generations: { 'node:n1': 3n } })).toEqual(['FENCE_AHEAD']);
    expect(codes({ metadata: report({ fenceHighWater: { 'node:n1': '3' } }), generations: { 'node:n1': 3n } })).toEqual([]);
    expect(codes({ metadata: report({ ledger: { readable: true, unresolvedReceipts: 1 } }) })).toEqual(['LEDGER_UNRESOLVED']);
    expect(codes({ metadata: report({ ledger: { readable: false, error: 'mode' } }) })).toEqual(['LEDGER_UNAVAILABLE']);
    expect(codes({ metadata: report({ disk: { freeBytes: 1, requiredBytes: 2, low: true } }) })).toEqual(['PREFLIGHT_DISK_LOW']);
    expect(codes({ metadata: report({ npm: { present: false } }) })).toEqual(['PREFLIGHT_NPM']);
    expect(codes({ heldLeases: 1 })).toEqual(['LEASE_HELD']);
  });

  it('never fails a page: an error leaves readiness out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.resourceEnrollment.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await readinessOfNodes([{ id: 'n1', hostname: 'x', metadata: '{}' }])).toEqual(new Map());
    warn.mockRestore();
  });
});

describe('readiness noise', () => {
  it('does not report npm or disk on a node that is not a versioned, enabled agent', () => {
    const off = (extra: Record<string, unknown>) => computeUpgradeReadiness(input({ metadata: report({ enabled: false, npm: { present: false, problem: 'npm was not found' }, disk: { freeBytes: 1, requiredBytes: 2, low: true }, ...extra }) }));
    expect(off({ layout: 'legacy', reasonCode: 'LEGACY_LAYOUT' }).problems).toEqual([]);
    expect(off({ layout: 'container', reasonCode: 'CONTAINER' }).problems).toEqual([]);
    expect(off({ layout: 'versioned', reasonCode: 'SWITCHED_OFF' }).problems).toEqual([]);
    expect(off({ layout: 'versioned', reasonCode: 'SWITCHED_OFF' }).status).toBe('unknown');
  });

  it('still reports the reason on a versioned node that is off because of a problem', () => {
    const off = (reasonCode: string) => computeUpgradeReadiness(input({ metadata: report({ enabled: false, reasonCode, reason: 'because' }) })).problems.map(problem => problem.code);
    expect(off('NPM')).toEqual(['PREFLIGHT_NPM']);
    expect(off('NOT_WRITABLE')).toEqual(['PREFLIGHT_NOT_WRITABLE']);
  });
});

describe('the readiness monitor', () => {
  let metadata = '';
  beforeEach(() => {
    createNotificationInTransaction.mockClear();
    db.node.update.mockReset().mockImplementation(async ({ data }: { data: { metadata: string } }) => { metadata = data.metadata; });
    db.node.findUnique.mockImplementation(async () => ({ metadata }));
    db.node.findMany.mockImplementation(async () => [{ id: 'n1', name: 'node-1', hostname: 'node-1.example.com', metadata }]);
  });

  it('keeps going when one node cannot be patched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const low = report({ disk: { freeBytes: 1, requiredBytes: 2, low: true } });
    db.node.findMany.mockImplementation(async () => [{ id: 'n1', name: 'node-1', hostname: 'node-1.example.com', metadata: low }, { id: 'n2', name: 'node-2', hostname: 'node-2.example.com', metadata: low }]);
    db.node.findUnique.mockImplementation(async () => ({ metadata: low }));
    const updated: string[] = [];
    db.node.update.mockReset().mockImplementation(async ({ where }: { where: { id: string } }) => { if (where.id === 'n1') throw new Error('deadlock'); updated.push(where.id); });
    await expect(checkUpgradeReadiness(NOW)).resolves.toBeUndefined();
    expect(updated).toEqual(['n2']);
    warn.mockRestore();
  });

  it('sends no notification while server-driven upgrades are off', async () => {
    features.agentUpgrades = false;
    try {
      metadata = JSON.stringify({ ...JSON.parse(report({ disk: { freeBytes: 1, requiredBytes: 2, low: true } })), upgradeNotReadySince: new Date(NOW - 2 * NOT_READY_NOTIFY_MS).toISOString() });
      await checkUpgradeReadiness(NOW);
      expect(createNotificationInTransaction).not.toHaveBeenCalled();
    } finally { features.agentUpgrades = true; }
  });

  it('notifies once, a day after a node stopped being ready, and starts over when it recovers', async () => {
    metadata = report({ disk: { freeBytes: 1, requiredBytes: 2, low: true } });
    await checkUpgradeReadiness(NOW);
    expect(JSON.parse(metadata).upgradeNotReadySince).toBe(new Date(NOW).toISOString());
    await checkUpgradeReadiness(NOW + NOT_READY_NOTIFY_MS - 1);
    expect(createNotificationInTransaction).not.toHaveBeenCalled();
    await checkUpgradeReadiness(NOW + NOT_READY_NOTIFY_MS);
    expect(createNotificationInTransaction).toHaveBeenCalledTimes(1);
    expect(createNotificationInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'node.upgrade_not_ready', severity: 'warning', nodeId: 'n1', message: expect.stringMatching(/PREFLIGHT_DISK_LOW.*Free disk space/) }), null);
    await checkUpgradeReadiness(NOW + 2 * NOT_READY_NOTIFY_MS);
    expect(createNotificationInTransaction).toHaveBeenCalledTimes(1);
    metadata = JSON.stringify({ ...JSON.parse(report()), upgradeNotReadySince: new Date(NOW).toISOString(), upgradeNotReadyNotifiedAt: new Date(NOW).toISOString() });
    await checkUpgradeReadiness(NOW + 3 * NOT_READY_NOTIFY_MS);
    expect(JSON.parse(metadata)).not.toHaveProperty('upgradeNotReadySince');
    expect(JSON.parse(metadata)).toHaveProperty('agentSelfUpgrade');
  });
});
