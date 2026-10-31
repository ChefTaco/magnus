import { describe, expect, it, vi } from 'vitest';

const sharedRedis = {
  options: { keyPrefix: 'magnus:' },
  duplicate: vi.fn(),
  call: vi.fn((command: string, subcommand?: string) => {
    if (command === 'XLEN') return Promise.resolve(12);
    if (command === 'XINFO' && subcommand === 'GROUPS') return Promise.resolve([]);
    if (command === 'XINFO' && subcommand === 'CONSUMERS') return Promise.resolve([]);
    return Promise.resolve(null);
  }),
};

vi.mock('../queue/redis.js', () => ({ getRedis: () => sharedRedis }));

const stream = await import('./heartbeat-stream.js');

describe('retired heartbeat stream stats', () => {
  it('reads stats without consuming, replaying, or publishing entries', async () => {
    const stats = await stream.getHeartbeatStreamStats();
    expect(stats).toMatchObject({ streamKey: 'magnus:heartbeats', length: 12, consumerGroup: 'control-api' });
    expect(sharedRedis.duplicate).not.toHaveBeenCalled();
    for (const command of ['XREADGROUP', 'XADD', 'XACK']) {
      expect(sharedRedis.call.mock.calls.some(([name]) => name === command)).toBe(false);
    }
    expect(Object.keys(stream).sort()).toEqual(['getHeartbeatStreamStats']);
  });
});
