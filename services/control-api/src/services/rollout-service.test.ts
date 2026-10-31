import { describe, expect, it, vi } from 'vitest';
vi.mock('../queue/workers.js', () => ({ enqueueCommand: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: vi.fn() }));
import { planRolloutWaves, rolloutInputSchema } from './rollout-service.js';
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
