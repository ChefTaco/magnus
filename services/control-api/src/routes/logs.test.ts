import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: null as null | { method: 'signature'; node: { id: string } } | { method: 'legacy' },
  authenticate: vi.fn(),
  claims: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  findUnique: vi.fn(),
  nodeFindFirst: vi.fn(),
}));

vi.mock('../utils/env.js', () => ({
  LOG_INGEST_SIGNING_SECRET: 'log-ingest-secret-for-unit-tests-32chars',
  LOG_INGEST_PREVIOUS_SIGNING_SECRET: '',
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { userId: 'user-1', email: 'alice@example.com', role: 'VIEWER' });
    await next();
  },
}));
vi.mock('../middleware/node-auth.js', () => ({
  authenticateNode: mocks.authenticate,
  nodeAuthOf: () => mocks.auth,
  assertNodeClaims: mocks.claims,
}));
vi.mock('../db/index.js', () => ({
  getDb: () => ({
    logEntry: { createMany: mocks.createMany, findMany: mocks.findMany, count: mocks.count, findUnique: mocks.findUnique },
    node: { findFirst: mocks.nodeFindFirst },
  }),
}));
vi.mock('../services/log-emitter.js', () => ({ emitLog: vi.fn(), onLog: vi.fn() }));

const { Hono } = await import('hono');
const { errorHandler, HttpError } = await import('../middleware/error-handler.js');
const { logsRouter, decodeLogCursor, encodeLogCursor } = await import('./logs.js');
const app = new Hono().route('/logs', logsRouter).onError(errorHandler);

const entry = (nodeId = 'web1.example.com') => ({ nodeId, message: 'hello', timestamp: '2026-11-26T10:00:00.000Z' });
const ingest = (body: unknown, headers: Record<string, string>) => app.request('/logs/ingest', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = { method: 'signature', node: { id: 'node-1' } };
  mocks.authenticate.mockResolvedValue(undefined);
  mocks.claims.mockResolvedValue(null);
  mocks.createMany.mockResolvedValue({ count: 1 });
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.nodeFindFirst.mockResolvedValue({ id: 'node-1' });
});

describe('POST /logs/ingest', () => {
  it('accepts a node-signed batch and stores it under the key\'s node', async () => {
    const { NODE_AUTH_HEADERS } = await import('../security/node-request-auth.js');
    // Verification itself is node-auth's job (mocked here); any signature header routes the batch to it.
    const res = await ingest([entry()], { [NODE_AUTH_HEADERS.keyId]: 'fixture-key', 'x-log-token': 'ignored-when-signed' });
    expect(res.status).toBe(201);
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    expect(mocks.claims).toHaveBeenCalledWith(expect.anything(), { fqdn: 'web1.example.com' });
    expect(mocks.createMany.mock.calls[0]?.[0].data[0]).toMatchObject({ nodeId: 'node-1', message: 'hello' });
  });

  it('refuses a signed batch that names another node', async () => {
    mocks.claims.mockRejectedValue(new HttpError(403, 'NODE_IDENTITY_MISMATCH', 'other node'));
    const res = await ingest([entry('other.example.com')], {});
    expect(res.status).toBe(403);
    expect(mocks.createMany).not.toHaveBeenCalled();
  });

  it('refuses a batch with no credential at all', async () => {
    mocks.authenticate.mockRejectedValue(new HttpError(401, 'NODE_SIGNATURE_REQUIRED', 'signature required'));
    expect((await ingest([entry()], {})).status).toBe(401);
    expect(mocks.createMany).not.toHaveBeenCalled();
  });

  it('still accepts the per-node HMAC token of older agents', async () => {
    const token = createHmac('sha256', 'log-ingest-secret-for-unit-tests-32chars').update('magnus:log-ingest:v1:web1.example.com').digest('base64url');
    expect((await ingest([entry()], { 'x-log-token': token })).status).toBe(201);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect((await ingest([entry()], { 'x-log-token': 'forged' })).status).toBe(401);
  });

  it('refuses a malformed timestamp with 400 instead of failing in the database', async () => {
    expect((await ingest([{ ...entry(), timestamp: 'yesterday' }], {})).status).toBe(400);
  });
});

describe('POST /logs/query', () => {
  const query = (body: unknown) => app.request('/logs/query', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('pages with a (timestamp, id) keyset in the order it returns rows', async () => {
    const rows = [
      { id: 'b', timestamp: new Date('2026-11-26T10:00:02Z') },
      { id: 'a', timestamp: new Date('2026-11-26T10:00:01Z') },
    ];
    mocks.findMany.mockResolvedValue(rows);
    const first = await (await query({ limit: 2 })).json() as { data: { nextCursor: string } };
    expect(mocks.findMany.mock.calls[0]?.[0].orderBy).toEqual([{ timestamp: 'desc' }, { id: 'desc' }]);
    expect(decodeLogCursor(first.data.nextCursor)).toEqual({ id: 'a', timestamp: rows[1]!.timestamp });

    await query({ limit: 2, cursor: first.data.nextCursor });
    expect(mocks.findMany.mock.calls[1]?.[0].where).toEqual({ AND: [{}, { OR: [
      { timestamp: { lt: rows[1]!.timestamp } },
      { timestamp: rows[1]!.timestamp, id: { lt: 'a' } },
    ] }] });
  });

  it('accepts a bare row id cursor from an older server', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'a', timestamp: new Date('2026-11-26T10:00:01Z') });
    expect((await query({ cursor: 'a' })).status).toBe(200);
    mocks.findUnique.mockResolvedValue(null);
    expect((await query({ cursor: 'missing' })).status).toBe(400);
  });

  it('refuses since/until that are not ISO 8601 date-times', async () => {
    expect((await query({ since: 'last tuesday' })).status).toBe(400);
    expect((await query({ since: '2026-11-26T00:00:00Z', until: '2026-11-26T12:00:00+01:00' })).status).toBe(200);
  });

  it('round-trips its own cursor format', () => {
    const row = { id: 'clx123', timestamp: new Date('2026-11-26T10:00:00.123Z') };
    expect(decodeLogCursor(encodeLogCursor(row))).toEqual(row);
    expect(decodeLogCursor('not-a-cursor')).toBeNull();
  });
});
