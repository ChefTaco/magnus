import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../services/audit-service.js', () => ({ sanitizeDetails: (value: unknown) => value }));

const watch = vi.hoisted(() => ({ onRevoked: undefined as (() => void) | undefined, stop: vi.fn() }));
vi.mock('../middleware/oathweave.js', () => ({
  watchOathweaveStream: (_authorization: string | undefined, onRevoked: () => void) => {
    watch.onRevoked = onRevoked;
    return watch.stop;
  },
}));

const bus = vi.hoisted(() => ({ listeners: new Set<(entry: unknown) => void>() }));
vi.mock('../services/log-emitter.js', () => ({
  emitLog: (entry: unknown) => { for (const listener of bus.listeners) listener(entry); },
  onLog: (listener: (entry: unknown) => void) => {
    bus.listeners.add(listener);
    return () => { bus.listeners.delete(listener); };
  },
}));

const { logsRouter } = await import('./logs.js');
const { emitLog } = await import('../services/log-emitter.js');

const entry = { id: '', nodeId: 'node-1', source: 'agent', level: 'info', message: 'hello', metadata: {}, timestamp: new Date(0) } as never;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('log SSE stream cleanup', () => {
  afterEach(() => {
    bus.listeners.clear();
    watch.stop.mockClear();
    vi.restoreAllMocks();
  });

  it('delivers log entries and unsubscribes when the client cancels', async () => {
    const response = await logsRouter.request('/stream');
    const reader = response.body!.getReader();
    await settle();
    expect(bus.listeners.size).toBe(1);
    emitLog(entry);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"message":"hello"');
    await reader.cancel();
    await settle();
    expect(bus.listeners.size).toBe(0);
    expect(watch.stop).toHaveBeenCalledOnce();
  });

  it('ends the stream and releases its timer and subscription when the session is revoked', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const response = await logsRouter.request('/stream');
    const reader = response.body!.getReader();
    await settle();
    expect(bus.listeners.size).toBe(1);
    watch.onRevoked!();
    expect((await reader.read()).done).toBe(true);
    expect(bus.listeners.size).toBe(0);
    expect(clear).toHaveBeenCalledOnce();
    expect(watch.stop).toHaveBeenCalledOnce();
  });
});
