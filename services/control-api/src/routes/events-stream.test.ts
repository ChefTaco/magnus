import { describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => {
  const off = vi.fn();
  let release: (() => void) | undefined;
  return {
    off,
    gate: () => new Promise<void>((resolve) => { release = resolve; }),
    open: () => release?.(),
  };
});
let gated = false;
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../services/event-bus.js', () => ({
  eventBus: {
    subscribe: vi.fn(async () => {
      if (gated) await bus.gate();
      return bus.off;
    }),
  },
}));

const watch = vi.hoisted(() => ({ onRevoked: undefined as (() => void) | undefined, stop: vi.fn() }));
vi.mock('../middleware/oathweave.js', () => ({
  watchOathweaveStream: (_authorization: string | undefined, onRevoked: () => void) => {
    watch.onRevoked = onRevoked;
    return watch.stop;
  },
}));

const { eventsStreamRouter } = await import('./events-stream.js');

describe('events SSE stream cleanup', () => {
  it('unsubscribes when the client cancels the stream', async () => {
    bus.off.mockClear();
    const response = await eventsStreamRouter.request('/');
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(bus.off).toHaveBeenCalledOnce();
  });

  it('ends the stream and unsubscribes when the session is revoked', async () => {
    bus.off.mockClear();
    watch.stop.mockClear();
    const response = await eventsStreamRouter.request('/');
    const reader = response.body!.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    watch.onRevoked!();
    expect((await reader.read()).done).toBe(true);
    expect(bus.off).toHaveBeenCalledOnce();
    expect(watch.stop).toHaveBeenCalledOnce();
  });

  it('unsubscribes a client that disconnected while the subscription was pending', async () => {
    bus.off.mockClear();
    gated = true;
    const controller = new AbortController();
    const response = await eventsStreamRouter.request('/', { signal: controller.signal });
    controller.abort();
    bus.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bus.off).toHaveBeenCalledOnce();
    gated = false;
    void response.body?.cancel().catch(() => undefined);
  });
});
