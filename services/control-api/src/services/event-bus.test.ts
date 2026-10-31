import { afterEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => {
  type Listener = (pattern: string, channel: string, message: string) => void;
  const subscribers = new Set<{ listeners: Listener[] }>();
  const instances: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  class FakeRedis {
    listeners: Listener[] = [];
    disconnect = vi.fn(() => { subscribers.delete(this); });
    constructor() { instances.push(this); }
    async connect() { subscribers.add(this); }
    on(event: string, listener: Listener) { if (event === 'pmessage') this.listeners.push(listener); return this; }
    removeAllListeners() { this.listeners = []; return this; }
    async psubscribe() { return 1; }
    async punsubscribe() { return 0; }
    async publish(channel: string, message: string) {
      for (const sub of subscribers) for (const listener of sub.listeners) listener('magnus:events:*', channel, message);
      return 1;
    }
  }
  return { FakeRedis, instances, subscribers };
});
vi.mock('ioredis', () => ({ Redis: redis.FakeRedis }));

import { eventBus } from './event-bus.js';

afterEach(async () => { await eventBus.close(); });

describe('event bus', () => {
  it('delivers a locally published event once and still relays other processes', async () => {
    const seen: Array<[string, unknown]> = [];
    await eventBus.subscribe('*', (channel, data) => seen.push([channel, data]));
    await eventBus.publish('node:status', { nodeId: 'n1' });
    expect(seen).toEqual([['node:status', { nodeId: 'n1' }]]);

    const [publisher] = [...redis.instances].slice(-2);
    await (publisher as unknown as { publish: (c: string, m: string) => Promise<number> }).publish(
      'magnus:events:alert:fired',
      JSON.stringify({ origin: 'another-process', data: { id: 'a1' } }),
    );
    expect(seen).toEqual([['node:status', { nodeId: 'n1' }], ['alert:fired', { id: 'a1' }]]);
  });

  it('shares one connection attempt across concurrent first callers', async () => {
    const before = redis.instances.length;
    await Promise.all([
      eventBus.subscribe('*', () => undefined),
      eventBus.subscribe('*', () => undefined),
      eventBus.publish('node:status', {}),
    ]);
    expect(redis.instances.length - before).toBe(2);
    await eventBus.close();
    for (const instance of redis.instances.slice(before)) expect(instance.disconnect).toHaveBeenCalled();
  });
});
