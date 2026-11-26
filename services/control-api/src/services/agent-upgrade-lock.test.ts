import { describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({ fail: true }));
vi.mock('../queue/redis.js', () => ({
  getRedis: () => {
    if (redis.fail) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    return { set: async () => 'OK', eval: async () => 1 };
  },
}));

const { defaultRunStore, runLockKeeper } = await import('./agent-upgrade-service.js');

describe('agent upgrade run lock', () => {
  it('refuses to start a run without Redis instead of locking in this process only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(defaultRunStore().lock('instance:run-1')).rejects.toMatchObject({ status: 503, code: 'AGENT_UPGRADE_LOCK_UNAVAILABLE' });
    await expect(defaultRunStore().renew('instance:run-1')).rejects.toThrow(/ECONNREFUSED/);
    redis.fail = false;
    await expect(defaultRunStore().lock('instance:run-1')).resolves.toBe(true);
  });

  it('reports the lock lost once renewals fail for two thirds of the lease, or at once when another holder owns it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let clock = 0;
    const renew = vi.fn<(token: string) => Promise<boolean>>();
    const keeper = runLockKeeper({ renew }, 'token', 90_000, () => clock);

    renew.mockResolvedValueOnce(true);
    clock = 30_000;
    await expect(keeper.renew()).resolves.toBe('held');

    renew.mockRejectedValueOnce(new Error('redis down'));
    clock = 60_000;
    await expect(keeper.renew()).resolves.toBe('uncertain');

    renew.mockRejectedValueOnce(new Error('redis down'));
    clock = 90_000;
    await expect(keeper.renew()).resolves.toBe('lost');

    renew.mockResolvedValueOnce(false);
    await expect(runLockKeeper({ renew }, 'token', 90_000, () => 0).renew()).resolves.toBe('lost');
  });
});
