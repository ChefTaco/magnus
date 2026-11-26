import { describe, expect, it, vi } from 'vitest';
const runs = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('../queue/workers.js', () => ({ enqueueCommand: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ executionRun: runs }) }));
import { planRolloutWaves, rolloutInputSchema, rolloutsToReconcile } from './rollout-service.js';
const input = {
  type: 'command',
  strategy: 'percentage',
  nodeIds: ['a', 'b', 'c'],
  metadata: { command: 'uptime' },
};
describe('rollout admission', () => {
  it.each([
    [25, 50],
    [50, 25, 100],
    [50, 50, 100],
    [0, 100],
  ])('rejects invalid percentage waves %j', (...waves) => {
    expect(rolloutInputSchema.safeParse({ ...input, percentageWaves: waves }).success).toBe(false);
  });
  it('requires real commands, supported types, distinct targets and an explicit valid canary', () => {
    for (const bad of [
      { metadata: {} },
      { type: 'upgrade' },
      { nodeIds: ['a', 'a'] },
      { strategy: 'canary', canaryNodeId: 'missing' },
    ]) {
      expect(rolloutInputSchema.safeParse({ ...input, ...bad }).success).toBe(false);
    }
  });
  it('does not advance rounded percentage waves by an extra target', () => {
    expect(
      planRolloutWaves(['a', 'b'], 'percentage', { percentageWaves: [1, 2, 50, 100] }),
    ).toEqual([['a'], ['b']]);
    expect(planRolloutWaves(['a', 'b', 'c'], 'canary', { canaryNodeId: 'b', waveSize: 1 })).toEqual(
      [['b'], ['a'], ['c']],
    );
  });
});

describe('rollout reconciler selection', () => {
  it('keeps paused runs out of the active slots and walks through them in windows', async () => {
    const paused = Array.from({ length: 30 }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}` }));
    runs.findMany.mockImplementation(async ({ where }: { where: { status: unknown; id?: { gt: string } } }) => {
      if (where.status !== 'paused') return [{ id: 'new-run' }];
      const after = where.id?.gt;
      return paused.filter((run) => !after || run.id > after).slice(0, 25);
    });
    const first = await rolloutsToReconcile();
    expect(first[0]).toBe('new-run');
    expect(first).toHaveLength(26);
    expect(runs.findMany.mock.calls[0]?.[0]).toMatchObject({ where: { status: { in: ['created', 'running'] } } });
    const second = await rolloutsToReconcile();
    expect(second).toEqual(['new-run', 'p25', 'p26', 'p27', 'p28', 'p29']);
    const third = await rolloutsToReconcile();
    expect(third.slice(0, 2)).toEqual(['new-run', 'p00']);
  });
});
