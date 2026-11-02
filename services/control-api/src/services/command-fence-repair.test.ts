import { beforeEach, describe, expect, it, vi } from 'vitest';
const logAuditEvent = vi.fn(async (_event: Record<string, unknown>) => undefined);
vi.mock('./audit-service.js', () => ({ logAuditEvent }));
const rows = new Map<string, bigint>();
const tx = { $executeRaw: vi.fn(async () => 1),
  commandResourceFence: {
    findUnique: vi.fn(async ({ where }: { where: { resourceKey: string } }) => rows.has(where.resourceKey) ? { generation: rows.get(where.resourceKey)! } : null),
    upsert: vi.fn(async ({ where, create, update }: { where: { resourceKey: string }; create: { generation: bigint }; update: { generation: bigint } }) => {
      rows.set(where.resourceKey, rows.has(where.resourceKey) ? update.generation : create.generation);
    }) } };
vi.mock('../db/index.js', () => ({ getDb: () => ({ $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx) }) }));
const { advanceCommandFence, checkReportedFence, FENCE_HIGH_WATER_CAP, fenceIsAhead } = await import('./command-fence-repair.js');

beforeEach(() => { rows.clear(); logAuditEvent.mockClear(); tx.commandResourceFence.upsert.mockClear(); vi.spyOn(console, 'warn').mockImplementation(() => undefined); });

describe('fence self-healing', () => {
  it('moves the generation to high-water + 1 under the admission lock, and audits both values', async () => {
    rows.set('node:n1', 1n);
    await expect(advanceCommandFence({ nodeId: 'n1', resourceKey: 'node:n1', highWater: '1789962351090', source: 'preflight' }))
      .resolves.toEqual({ status: 'advanced', from: 1n, to: 1789962351091n });
    expect(rows.get('node:n1')).toBe(1789962351091n);
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.fence.advanced', targetId: 'n1',
      details: expect.objectContaining({ resourceKey: 'node:n1', oldGeneration: '1', newGeneration: '1789962351091', source: 'preflight' }) }));
  });

  it('creates the row when the server has none', async () => {
    await expect(advanceCommandFence({ nodeId: 'n1', resourceKey: 'node:n1:ardent', highWater: '9', source: 'stale-fence-reply' })).resolves.toEqual({ status: 'advanced', from: 0n, to: 10n });
    expect(rows.get('node:n1:ardent')).toBe(10n);
  });

  it('never lowers a generation, and changes nothing when the next generation already passes the agent', async () => {
    rows.set('node:n1', 100n);
    for (const highWater of ['5', '99', '100']) await expect(advanceCommandFence({ nodeId: 'n1', resourceKey: 'node:n1', highWater, source: 'preflight' })).resolves.toEqual({ status: 'current' });
    expect(rows.get('node:n1')).toBe(100n);
    expect(tx.commandResourceFence.upsert).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(fenceIsAhead(100n, 100n)).toBe(false);
    expect(fenceIsAhead(101n, 100n)).toBe(true);
  });

  it('refuses a value above the cap or that is not decimal, naming the problem and changing nothing', async () => {
    rows.set('node:n1', 3n);
    await expect(advanceCommandFence({ nodeId: 'n1', resourceKey: 'node:n1', highWater: String(FENCE_HIGH_WATER_CAP + 1n), source: 'preflight' }))
      .resolves.toMatchObject({ status: 'rejected', code: 'FENCE_OVERFLOW' });
    for (const bad of ['0', '-1', '1e9', '0x10', '12a', ' 7', '', null, 7]) expect(checkReportedFence('n1', 'node:n1', bad)).toMatchObject({ ok: false, code: 'FENCE_INVALID' });
    expect(checkReportedFence('n1', 'node:n1', String(FENCE_HIGH_WATER_CAP))).toMatchObject({ ok: true });
    expect(rows.get('node:n1')).toBe(3n);
  });

  it('accepts only the node\'s own keys: an agent can inflate nothing but its own counter', async () => {
    for (const key of ['node:n2', 'node:n11', 'participant:agent:n1', 'node:', 'n1']) {
      expect(checkReportedFence('n1', key, '5')).toMatchObject({ ok: false, code: 'FENCE_INVALID' });
      await expect(advanceCommandFence({ nodeId: 'n1', resourceKey: key, highWater: '5', source: 'preflight' })).resolves.toMatchObject({ status: 'rejected' });
    }
    expect(rows.size).toBe(0);
  });
});
