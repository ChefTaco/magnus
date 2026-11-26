import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), emit: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ logEntry: { create: mocks.create } }) }));
vi.mock('../services/log-emitter.js', () => ({ emitLog: mocks.emit }));

const { Hono } = await import('hono');
const { requestLogger, noteUnauthenticatedRejection, resetRequestLoggerState } = await import('./request-logger.js');

function app(withUser: boolean) {
  const hono = new Hono<{ Variables: { user?: unknown } }>();
  hono.use('/api/v1/*', async (c, next) => {
    if (withUser) c.set('user', { userId: 'user-1', email: 'alice@example.com', role: 'VIEWER' });
    await next();
  });
  hono.use('/api/v1/*', requestLogger as never);
  hono.get('/api/v1/secret', (c) => c.json({ error: 'nope' }, 401));
  hono.get('/api/v1/ok', (c) => c.json({ ok: true }));
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({});
  resetRequestLoggerState();
});

describe('request logger', () => {
  it('stores no row per anonymous 4xx', async () => {
    const anonymous = app(false);
    for (let i = 0; i < 20; i += 1) await anonymous.request('/api/v1/secret');
    await anonymous.request('/api/v1/does-not-exist');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('still logs successful requests and refusals of signed-in users', async () => {
    await app(false).request('/api/v1/ok');
    await app(true).request('/api/v1/secret');
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[1]?.[0]).toMatchObject({ data: { level: 'warn', message: expect.stringContaining('401') } });
  });

  it('summarizes anonymous refusals once per minute', () => {
    expect(noteUnauthenticatedRejection(1_000)).toBeNull();
    for (let i = 0; i < 9; i += 1) expect(noteUnauthenticatedRejection(2_000 + i)).toBeNull();
    const summary = noteUnauthenticatedRejection(61_000);
    expect(summary?.metadata).toMatchObject({ unauthenticatedRejections: 11 });
    expect(noteUnauthenticatedRejection(62_000)).toBeNull();
  });
});
