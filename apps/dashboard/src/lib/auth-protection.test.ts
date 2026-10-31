import { describe, expect, it } from 'vitest';
import { createAuthProtection, resolveTrustedClientAddress, type AuthRateLimitStore } from '@/lib/auth-protection';

class FakeStore implements AuthRateLimitStore {
  counts = new Map<string, number>();
  concurrency = 0;
  async eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const keys = args.slice(0, numberOfKeys).map(String);
    if (script.includes("redis.call('INCR', key)")) {
      return keys.map((key) => {
        const count = (this.counts.get(key) ?? 0) + 1;
        this.counts.set(key, count);
        return count;
      });
    }
    if (script.includes("count >= tonumber(ARGV[1])")) {
      if (this.concurrency >= Number(args[numberOfKeys])) return 0;
      return ++this.concurrency;
    }
    if (script.includes("redis.call('LPUSH'")) return 1;
    this.concurrency = Math.max(0, this.concurrency - 1);
    return this.concurrency;
  }
  async del(...keys: string[]): Promise<unknown> {
    keys.forEach((key) => this.counts.delete(key));
    return keys.length;
  }
}

describe('dashboard authentication protection', () => {
  it('ignores spoofed forwarding headers unless the trusted TLS edge normalized them', () => {
    expect(resolveTrustedClientAddress(new Headers({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' }))).toBe('unverified');
    expect(resolveTrustedClientAddress(new Headers({ 'x-magnus-edge-normalized': '1', 'x-real-ip': '198.51.100.8' }))).toBe('198.51.100.8');
  });

  it('enforces the source-and-username limit durably and releases concurrency', async () => {
    const store = new FakeStore();
    const begin = createAuthProtection(store, async () => undefined);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const permit = await begin('198.51.100.8', 'admin');
      expect(permit.allowed).toBe(true);
      await permit.release();
    }
    const blocked = await begin('198.51.100.8', 'admin');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(900);
    await blocked.release();
    expect(store.concurrency).toBe(0);
  });

  it('clears only pair and username state after success, preserving source pressure', async () => {
    const store = new FakeStore();
    const permit = await createAuthProtection(store, async () => undefined)('198.51.100.8', 'admin');
    await permit.clearSuccessfulPair();
    expect([...store.counts.keys()].filter((key) => key.includes(':source:'))).toHaveLength(1);
    expect([...store.counts.keys()].filter((key) => key.includes(':pair:') || key.includes(':username:'))).toHaveLength(0);
    await permit.release();
  });

  it('enforces the bounded global concurrency lease before expensive authentication', async () => {
    const store = new FakeStore();
    store.concurrency = 8;
    const permit = await createAuthProtection(store, async () => undefined)('198.51.100.8', 'admin');
    expect(permit.allowed).toBe(false);
    expect(permit.retryAfterSeconds).toBe(1);
    await permit.release();
    expect(store.concurrency).toBe(8);
  });

  it('fails closed when Redis cannot account for an attempt', async () => {
    const store: AuthRateLimitStore = {
      eval: async () => { throw new Error('redis unavailable'); },
      del: async () => 0,
    };
    await expect(createAuthProtection(store, async () => undefined)('198.51.100.8', 'admin')).rejects.toThrow('redis unavailable');
  });
});
