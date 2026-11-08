import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, AuthTokenPayload } from '../types/index.js';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), studio: vi.fn(), action: vi.fn(), audit: vi.fn() }));
vi.mock('../services/ardent-service.js', () => ({
  streamArdentProfileResource: mocks.stream, requireArdentStudioAgent: mocks.studio, performArdentAction: mocks.action,
  getArdentContextAdoption: vi.fn(), getArdentContextRelease: vi.fn(), getArdentInstallation: vi.fn(),
  getArdentProfileResource: vi.fn(), listArdentInstallations: vi.fn(),
}));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: mocks.audit }));
vi.mock('../middleware/auth.js', async (original) => ({
  ...await original<typeof import('../middleware/auth.js')>(),
  // A test identity from a header stands in for token verification.
  authMiddleware: async (c: import('hono').Context<AppVariables>, next: () => Promise<void>) => {
    const role = c.req.header('x-test-role');
    if (!role) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    c.set('user', { userId: 'alice', email: 'alice', role, iat: 0, exp: 0 } as AuthTokenPayload);
    await next();
  },
}));
const { ardentRouter } = await import('./ardent.js');
const { errorHandler } = await import('../middleware/error-handler.js');
const app = new Hono<AppVariables>().route('/ardent', ardentRouter);
app.onError(errorHandler);

const taskId = '00000000-0000-4000-8000-0000000000aa';
const streamPath = `/ardent/installations/node-1/profiles/example/tasks/${taskId}/stream`;
const artifactPath = `/ardent/installations/node-1/profiles/example/artifacts/${'a'.repeat(64)}`;
const encoder = new TextEncoder();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.studio.mockResolvedValue(undefined);
});

describe('Ardent task stream relay', () => {
  it('passes each event through before the node stream ends', async () => {
    let push!: (text: string) => void;
    let end!: () => void;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) {
      push = text => controller.enqueue(encoder.encode(text));
      end = () => controller.close();
    } });
    mocks.stream.mockResolvedValue(new Response(upstream, { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await app.request(`${streamPath}?after=4`, { headers: { 'x-test-role': 'ADMIN', 'Last-Event-ID': '5' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(mocks.stream).toHaveBeenCalledWith('node-1', 'example', `tasks/${taskId}/stream`, expect.objectContaining({ after: '4', lastEventId: '5' }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    push('event: task.delta\ndata: {"step":1,"text":"Hel"}\n\n');
    const started = Date.now();
    expect(decoder.decode((await reader.read()).value)).toContain('"Hel"');
    push('event: task.delta\ndata: {"step":1,"text":"lo"}\n\n');
    expect(decoder.decode((await reader.read()).value)).toContain('"lo"');
    // Both chunks arrived while the node stream was still open.
    expect(Date.now() - started).toBeLessThan(1000);
    end();
    expect((await reader.read()).done).toBe(true);
  });

  it('cancels the node stream when the client goes away', async () => {
    const cancelled = vi.fn();
    mocks.stream.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN' } });
    await response.body!.cancel();
    expect(cancelled).toHaveBeenCalled();
  });

  it('maps node failures and refuses an agent without the bridge', async () => {
    mocks.stream.mockResolvedValue(new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
    expect((await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN' } })).status).toBe(404);
    mocks.stream.mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect((await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN' } })).status).toBe(503);
    expect((await app.request(`${streamPath}?after=x`, { headers: { 'x-test-role': 'ADMIN' } })).status).toBe(400);
    const { HttpError } = await import('../middleware/error-handler.js');
    mocks.studio.mockRejectedValue(new HttpError(409, 'AGENT_UPGRADE_REQUIRED', 'Upgrade the Magnus agent on node-1'));
    const old = await app.request(streamPath, { headers: { 'x-test-role': 'ADMIN' } });
    expect(old.status).toBe(409);
    expect((await old.json()).error.code).toBe('AGENT_UPGRADE_REQUIRED');
  });
});

describe('Ardent artifact relay', () => {
  it('streams an artifact larger than 2 MiB without a server-side size limit', async () => {
    const size = 3 * 1024 * 1024;
    let sent = 0;
    mocks.stream.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent >= size) { controller.close(); return; }
      controller.enqueue(new Uint8Array(64 * 1024).fill(9));
      sent += 64 * 1024;
    } }), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) } }));
    const response = await app.request(artifactPath, { headers: { 'x-test-role': 'ADMIN' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe(String(size));
    expect(response.headers.get('content-disposition')).toContain(`ardent-${'a'.repeat(64)}.bin`);
    expect((await response.arrayBuffer()).byteLength).toBe(size);
    expect(mocks.studio).not.toHaveBeenCalled();
  });
});

describe('Ardent bridge access', () => {
  it.each([[streamPath, 'GET'], [artifactPath, 'GET'], ['/ardent/installations/node-1/profiles/example/action', 'POST']])('%s is ADMIN-only', async (path, method) => {
    const init = (role?: string) => ({ method, headers: { ...(role ? { 'x-test-role': role } : {}), 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ action: 'session-open', body: { key: 'k' } }) } : {}) });
    expect((await app.request(path, init())).status).toBe(401);
    for (const role of ['OPERATOR', 'VIEWER']) expect((await app.request(path, init(role))).status).toBe(403);
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('opens a session only on an agent with the bridge, and audits it', async () => {
    mocks.action.mockResolvedValue({ id: taskId, key: 'k' });
    const response = await app.request('/ardent/installations/node-1/profiles/example/action', { method: 'POST',
      headers: { 'x-test-role': 'ADMIN', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'session-open', body: { key: 'k' } }) });
    expect(response.status).toBe(200);
    expect(mocks.studio).toHaveBeenCalledWith('node-1');
    expect(mocks.action).toHaveBeenCalledWith('node-1', 'example', 'session-open', undefined, { key: 'k' });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ardent.session-open', actorId: 'alice' }));
  });
});
