import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'OPERATOR' as 'ADMIN' | 'OPERATOR',
  nodeFindMany: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    node: { findMany: mocks.nodeFindMany, findUnique: vi.fn().mockResolvedValue({ id: 'node-1', ipAddress: '192.0.2.10', port: 4100 }) },
    filePatchTask: { create: vi.fn(async ({ data }: { data: object }) => ({ id: 'task-1', ...data })), update: vi.fn() },
  }),
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { userId: 'user-1', email: 'alice@example.com', role: mocks.role });
    await next();
  },
  requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUser: (c: { var: { user: unknown } }) => c.var.user,
}));
vi.mock('../sdk/index.js', () => ({
  NodeApiClient: class {
    writeFile = mocks.writeFile;
    readFile = mocks.readFile;
    executeCommand = mocks.executeCommand;
  },
}));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../utils/env.js', () => ({ getNodeManagerSecret: () => '' }));
vi.mock('../utils/idempotency.js', () => ({ enforceIdempotencyFromHeader: vi.fn() }));

const { Hono } = await import('hono');
const { errorHandler } = await import('../middleware/error-handler.js');
const { filesRouter, normalizeNodePath, pathPolicy } = await import('./files.js');
const app = new Hono().route('/files', filesRouter).onError(errorHandler);

const update = (filePath: string, backup = false) => app.request('/files/update', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nodeIds: ['node-1'], filePath, content: 'x', backup }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'OPERATOR';
  mocks.nodeFindMany.mockResolvedValue([{ id: 'node-1', name: 'node-1', ipAddress: '192.0.2.10', port: 4100, lastHeartbeatAt: new Date() }]);
  mocks.writeFile.mockResolvedValue({ data: {} });
  mocks.readFile.mockResolvedValue({ data: { content: 'x' } });
});

describe('file path policy', () => {
  it('normalizes before judging, so doubled slashes and dot segments do not slip past a prefix', () => {
    expect(normalizeNodePath('//etc/./cron.d//job')).toBe('/etc/cron.d/job');
    expect(pathPolicy(normalizeNodePath('//etc/cron.d/job'))).toBe('sensitive-system-path');
    expect(pathPolicy(normalizeNodePath('/srv/app/./config.yml'))).toBe('safe-app-path');
    expect(pathPolicy('/home/operator/.ssh/authorized_keys')).toBe('sensitive-system-path');
    expect(pathPolicy('/proc/1/environ')).toBe('blocked-path');
    expect(pathPolicy('/')).toBe('blocked-path');
  });

  it.each(['etc/cron.d/job', 'relative.txt', '/srv/../etc/passwd', '/srv/app\0.txt'])('refuses %j', (filePath) => {
    expect(() => normalizeNodePath(filePath)).toThrow();
  });

  it('keeps an OPERATOR from writing sensitive system paths, however they are spelled', async () => {
    for (const filePath of ['/etc/cron.d/job', '//etc/cron.d/job', '/etc//systemd/system/x.service', '/root/.bashrc']) {
      const res = await update(filePath);
      expect(res.status).toBe(403);
    }
    expect((await update('etc/cron.d/job')).status).toBe(400);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('lets an OPERATOR write application paths and an ADMIN write system paths, sending the normalized path', async () => {
    expect((await update('/srv/app//config.yml')).status).toBe(201);
    expect(mocks.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: '/srv/app/config.yml' }));
    mocks.role = 'ADMIN';
    expect((await update('//etc/app.conf')).status).toBe(201);
    expect(mocks.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: '/etc/app.conf' }));
  });

  it('reads only absolute, normalized paths', async () => {
    expect((await app.request('/files/read?nodeId=node-1&filePath=etc/hosts')).status).toBe(400);
    expect((await app.request('/files/read?nodeId=node-1&filePath=//etc/hosts')).status).toBe(200);
    expect(mocks.readFile).toHaveBeenCalledWith('/etc/hosts');
  });

  it('leaves the backup to the agent and never falls back to a shell write', async () => {
    const { NotDispatchedError } = await import('../sdk/node-api-client.js');
    expect((await update('/srv/app/config.yml', true)).status).toBe(201);
    expect(mocks.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ backup: true }));

    mocks.writeFile.mockRejectedValue(new NotDispatchedError('AGENT_FILE_WRITE_UNSUPPORTED', 'upgrade the agent'));
    const refused = await update('/srv/app/config.yml', true);
    expect(refused.status).toBe(502);
    const notFound = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    mocks.writeFile.mockRejectedValue(notFound);
    expect((await update('/srv/app/config.yml', true)).status).toBe(502);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });
});
