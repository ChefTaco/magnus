import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nodeFindUnique: vi.fn(),
  agentFetch: vi.fn(),
  logAuditEvent: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({ node: { findUnique: mocks.nodeFindUnique, findMany: vi.fn().mockResolvedValue([]) } }),
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { userId: 'user-1', email: 'alice@example.com', role: 'OPERATOR' });
    await next();
  },
  requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUser: (c: { var: { user: unknown } }) => c.var.user,
}));
vi.mock('../services/node-agent-auth.js', () => ({ agentFetch: mocks.agentFetch }));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: mocks.logAuditEvent }));

const { Hono } = await import('hono');
const { errorHandler } = await import('../middleware/error-handler.js');
const { profilingRouter: router } = await import('./profiling.js');
const profilingRouter = new Hono().route('/', router).onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nodeFindUnique.mockResolvedValue({ id: 'node-1', name: 'node-1', ipAddress: '192.0.2.10', port: 4100 });
  mocks.agentFetch.mockResolvedValue(new Response(JSON.stringify({ data: { heap: {} } }), { status: 200 }));
});

describe('GET /profiling/:nodeId', () => {
  it.each(['heap', 'cpu', 'process'])('requests the agent profiling endpoint for type=%s', async (type) => {
    const res = await profilingRouter.request(`/node-1?type=${type}`);

    expect(res.status).toBe(200);
    expect(mocks.agentFetch).toHaveBeenCalledWith({ nodeId: 'node-1' }, `https://192.0.2.10:4100/api/v1/profiling/${type}`, expect.objectContaining({ redirect: 'error' }));
    expect(mocks.logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'node.profile', actorId: 'user-1', targetId: 'node-1', details: { type, readOnly: true } }));
  });

  it('requests the full profile without a type', async () => {
    const res = await profilingRouter.request('/node-1');

    expect(res.status).toBe(200);
    expect(mocks.agentFetch).toHaveBeenCalledWith({ nodeId: 'node-1' }, 'https://192.0.2.10:4100/api/v1/profiling', expect.anything());
  });

  it.each(['../files/read', '..%2Ffiles%2Fread', 'heap/../../ardent', 'heap?x=1', 'HEAP'])('refuses type=%s without calling the agent', async (type) => {
    const res = await profilingRouter.request(`/node-1?type=${encodeURIComponent(type)}`);

    expect(res.status).toBe(400);
    expect(mocks.agentFetch).not.toHaveBeenCalled();
  });
});
