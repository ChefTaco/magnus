import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { decodeCursor, encodeCursor, validateHiveEvent } from '@hivemagnus/hive-common/events';
import { hiveEventFeedResponseSchema, magnusBrowserResponseSchema } from '@hivemagnus/magnus-contracts/browser';
import type { AppVariables } from '../types/index.js';

vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  JWT_SECRET: 'fixture-events-jwt-secret-at-least-32-chars', API_SECRET: 'fixture-events-api-secret-at-least-32-chars',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '' }));
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));

interface Row {
  id: string; type: string; severity: string; title: string; message: string;
  nodeId: string | null; nodeName: string | null; metadata: string; createdAt: Date;
}
interface Where {
  createdAt: { gte: Date };
  OR?: Array<{ createdAt: { gt: Date } } | { createdAt: Date; id: { gt: string } }>;
  NOT?: { type: { startsWith: string } };
}
const store = vi.hoisted(() => ({ rows: [] as Row[], queries: [] as unknown[] }));
/** Applies the filters the feed sends, with Prisma's meaning, so the tests check the feed and not the mock. */
const db = vi.hoisted(() => ({
  notification: {
    findMany: vi.fn(async (query: { where: Where; take: number }) => {
      store.queries.push(query);
      const { where } = query;
      return store.rows
        .filter(row => row.createdAt >= where.createdAt.gte)
        .filter(row => !where.NOT || !row.type.startsWith(where.NOT.type.startsWith))
        .filter(row => !where.OR || where.OR.some(clause => 'id' in clause
          ? row.createdAt.getTime() === clause.createdAt.getTime() && row.id > clause.id.gt
          : row.createdAt > clause.createdAt.gt))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, query.take)
        .map(row => ({ ...row }));
    }),
  },
}));
vi.mock('../db/index.js', () => ({ getDb: () => db }));

const { errorHandler } = await import('../middleware/error-handler.js');
const { signUserToken } = await import('../middleware/auth.js');
const { hiveEventsRouter } = await import('./hive-events.js');
const { notificationToHiveEvent } = await import('../services/hive-events.js');

const app = new Hono<AppVariables>().onError(errorHandler).route('/api/v1/hive/events', hiveEventsRouter);

type Role = 'VIEWER' | 'OPERATOR' | 'ADMIN';
const tokenFor = (role: Role) => signUserToken({ userId: `fixture-${role.toLowerCase()}`, email: 'alice@example.com', role });
async function get(path: string, role: Role | null = 'ADMIN') {
  const headers: Record<string, string> = role ? { Authorization: `Bearer ${await tokenFor(role)}` } : {};
  const response = await app.request(path, { headers });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as { data: Array<Record<string, unknown>>; nextCursor: string | null; error?: { code: string } } };
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
function row(id: string, overrides: Partial<Row> = {}): Row {
  return { id, type: 'node.offline', severity: 'critical', title: `node-1 went offline (${id})`,
    message: 'Node node-1 (node-1.example.com) has not sent a heartbeat.', nodeId: 'cmnode1', nodeName: 'node-1',
    metadata: '{}', createdAt: ago(DAY), ...overrides };
}

/** Read the whole feed, page by page. */
async function readAll(limit: number, role: Role = 'ADMIN') {
  const events: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await get(`/api/v1/hive/events?limit=${limit}${cursor ? `&after=${cursor}` : ''}`, role);
    expect(page.status).toBe(200);
    events.push(...page.body.data);
    if (!page.body.nextCursor) return events;
    cursor = page.body.nextCursor;
  }
  throw new Error('the feed did not end');
}

beforeEach(() => {
  const shared = ago(2 * DAY);
  store.rows = [
    row('cm0005', { createdAt: ago(3 * DAY) }),
    // Three notifications in the same millisecond: the ID breaks the tie.
    row('cm0003', { createdAt: shared }),
    row('cm0001', { createdAt: shared }),
    row('cm0002', { createdAt: shared }),
    row('cm0004', { type: 'node.recovered', severity: 'info', title: 'node-1 is back online', createdAt: ago(DAY) }),
    row('cm0006', { type: 'command.failed', severity: 'warning', title: 'Command failed on node-1',
      message: '"/usr/bin/curl -H Authorization: Bearer fixture-token-value" failed: exit 7', createdAt: ago(DAY - 1000) }),
    row('cm0007', { type: 'ardent.hivemem.renewal_failed', severity: 'critical', title: 'Ardent lead has lost HiveMem',
      message: 'The credential expired at 2026-11-01T00:00:00.000Z. Run Enable HiveMem on the profile to enroll it again. Last error: upstream said fixture-detail',
      metadata: JSON.stringify({ profile: 'lead', agentId: 'ardent-lead-0a1b2c3d', failures: 3 }), createdAt: ago(DAY - 2000) }),
    row('cm0008', { type: 'prediction.disk', severity: 'warning', nodeId: null, nodeName: null, title: 'Predicted: disk', createdAt: ago(DAY - 3000) }),
  ];
  store.queries = [];
  vi.clearAllMocks();
});

describe('GET /api/v1/hive/events', () => {
  it('serves oldest first by (occurredAt, id) and walks every page with the cursor', async () => {
    const all = await readAll(200);
    expect(all.map(event => event.sourceRef)).toEqual(['cm0005', 'cm0001', 'cm0002', 'cm0003', 'cm0004', 'cm0006', 'cm0007', 'cm0008']);
    for (const limit of [1, 2, 3]) expect(await readAll(limit), `limit ${limit}`).toEqual(all);
  });

  it('round-trips the cursor: the next page starts strictly after the last event', async () => {
    const first = await get('/api/v1/hive/events?limit=2');
    expect(first.body.data.map(event => event.sourceRef)).toEqual(['cm0005', 'cm0001']);
    const last = first.body.data[1]!;
    expect(decodeCursor(first.body.nextCursor!)).toEqual({ t: last.occurredAt, id: 'cm0001' });
    const second = await get(`/api/v1/hive/events?limit=2&after=${first.body.nextCursor}`);
    expect(second.body.data.map(event => event.sourceRef)).toEqual(['cm0002', 'cm0003']);
  });

  it('answers a null cursor once caught up, and an empty page after the last event', async () => {
    const page = await get('/api/v1/hive/events');
    expect(page.body.data).toHaveLength(8);
    expect(page.body.nextCursor).toBeNull();
    const last = store.rows.find(entry => entry.id === 'cm0008')!;
    const after = encodeCursor({ t: last.createdAt.toISOString(), id: last.id });
    expect((await get(`/api/v1/hive/events?after=${after}`)).body).toEqual({ data: [], nextCursor: null });
  });

  it('serves only the last 14 days, even after an older cursor', async () => {
    store.rows.push(row('cm0100', { createdAt: ago(14 * DAY + 60_000) }), row('cm0101', { createdAt: ago(14 * DAY - 60_000) }));
    const all = await readAll(200);
    expect(all.map(event => event.sourceRef)).not.toContain('cm0100');
    expect(all[0]!.sourceRef).toBe('cm0101');
    const old = encodeCursor({ t: ago(30 * DAY).toISOString(), id: 'cm0000' });
    const page = await get(`/api/v1/hive/events?after=${old}`);
    expect(page.body.data[0]!.sourceRef).toBe('cm0101');
    const since = (store.queries.at(-1) as { where: Where }).where.createdAt.gte.getTime();
    expect(Math.abs(Date.now() - 14 * DAY - since)).toBeLessThan(5_000);
  });

  it('bounds limit and refuses a malformed limit or cursor with 400', async () => {
    store.rows = Array.from({ length: 250 }, (_, index) => row(`cm${String(index).padStart(4, '0')}`, { createdAt: ago(DAY - index) }));
    expect((await get('/api/v1/hive/events')).body.data).toHaveLength(50);
    expect((await get('/api/v1/hive/events?limit=1')).body.data).toHaveLength(1);
    expect((await get('/api/v1/hive/events?limit=200')).body.data).toHaveLength(200);
    expect((await get('/api/v1/hive/events?limit=500')).body.data).toHaveLength(200);
    for (const query of ['limit=0', 'limit=-1', 'limit=abc', 'limit=1.5', 'limit=1&limit=2', 'after=%25%25', 'after=not-a-cursor',
      `after=${encodeCursor({ t: 'yesterday', id: 'cm0001' })}`, `after=${encodeCursor({ t: new Date().toISOString(), id: 'x/y' })}`,
      `after=${encodeCursor({ id: 'cm0001' })}`, `after=${'a'.repeat(600)}`]) {
      const response = await get(`/api/v1/hive/events?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.text, query).not.toContain('fixture');
    }
  });

  it('answers 401 without a session', async () => {
    expect((await get('/api/v1/hive/events', null)).status).toBe(401);
  });

  it('keeps Ardent notifications to ADMIN, as the Ardent routes do', async () => {
    const admin = await readAll(200, 'ADMIN');
    expect(admin.map(event => event.type)).toContain('ardent.hivemem.renewal_failed');
    for (const role of ['VIEWER', 'OPERATOR'] as const) {
      const events = await readAll(200, role);
      expect(events.map(event => event.sourceRef), role).toEqual(['cm0005', 'cm0001', 'cm0002', 'cm0003', 'cm0004', 'cm0006', 'cm0008']);
      expect(JSON.stringify(events), role).not.toMatch(/ardent|lead/iu);
    }
  });

  it('gives a record the same event, with the same ID, every time', async () => {
    const first = await readAll(200);
    const second = await readAll(3);
    expect(second).toEqual(first);
    expect(first.map(event => event.id)).toEqual(first.map(event => `magnus:notification:${String(event.sourceRef)}`));
    const source = store.rows[0]!;
    expect(notificationToHiveEvent({ ...source })).toEqual(notificationToHiveEvent({ ...source }));
    expect(notificationToHiveEvent(source)['id']).toBe('magnus:notification:cm0005');
  });

  it('serves only events that pass the strict HiveEvent validator and the published contract', async () => {
    const page = await get('/api/v1/hive/events?limit=200');
    for (const event of page.body.data) expect(validateHiveEvent(event, { strict: true }), String(event.id)).toMatchObject({ ok: true });
    expect(hiveEventFeedResponseSchema.parse(page.body)).toEqual(page.body);
    expect(magnusBrowserResponseSchema('/hive/events?limit=1')).toBe(hiveEventFeedResponseSchema);
  });

  it('maps severities, subjects and HiveXUI links', async () => {
    const events = Object.fromEntries((await readAll(200)).map(event => [event.sourceRef, event]));
    expect(events['cm0005']).toEqual({
      id: 'magnus:notification:cm0005', product: 'magnus', type: 'node.offline', severity: 'critical',
      title: 'node-1 went offline (cm0005)', summary: 'Node node-1 (node-1.example.com) has not sent a heartbeat.',
      occurredAt: store.rows[0]!.createdAt.toISOString(), subject: { nodeId: 'cmnode1' },
      link: { product: 'magnus', path: '/fleet/nodes/cmnode1' }, sourceRef: 'cm0005',
    });
    expect(events['cm0004']).toMatchObject({ type: 'node.recovered', severity: 'info' });
    expect(events['cm0007']).toMatchObject({
      severity: 'critical', subject: { actorId: 'ardent-lead-0a1b2c3d', agentRef: 'cmnode1~lead', nodeId: 'cmnode1' },
      link: { product: 'magnus', path: '/fleet/ardent/profiles/cmnode1~lead' },
      summary: 'The credential expired at 2026-11-01T00:00:00.000Z. Run Enable HiveMem on the profile to enroll it again.',
    });
    expect(events['cm0008']).toMatchObject({ severity: 'warning', link: { product: 'magnus', path: '/fleet/notifications' } });
    expect(events['cm0008']).not.toHaveProperty('subject');
  });

  it('never carries a command line, a credential or an upstream error', async () => {
    const page = await get('/api/v1/hive/events?limit=200');
    expect(page.text).not.toMatch(/fixture-token-value|fixture-detail|Authorization|\/usr\/bin/u);
    const failed = page.body.data.find(event => event.sourceRef === 'cm0006');
    expect(failed).toMatchObject({ type: 'command.failed', severity: 'warning', summary: 'A command failed on node-1. Open the node in Magnus for its result.' });
  });

  it('drops an event that fails validation, logs no content and still advances the cursor', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.rows = [row('cm0001', { createdAt: ago(3000) }), row('cm0002', { type: 'Bad Type', title: 'secret-title-text', createdAt: ago(2000) }), row('cm0003', { createdAt: ago(1000) })];
    const first = await get('/api/v1/hive/events?limit=2');
    expect(first.body.data.map(event => event.sourceRef)).toEqual(['cm0001']);
    expect(decodeCursor(first.body.nextCursor!)).toMatchObject({ id: 'cm0002' });
    expect((await get(`/api/v1/hive/events?after=${first.body.nextCursor}`)).body.data.map(event => event.sourceRef)).toEqual(['cm0003']);
    expect(warn).toHaveBeenCalledWith('[hive-events] dropped notification cm0002: type');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-title-text');
    warn.mockRestore();
  });

  it('omits identifiers the HiveEvent subject cannot carry instead of dropping the event', () => {
    const event = notificationToHiveEvent(row('cm0009', { nodeId: 'Node With Spaces', type: 'ardent.hivemem.renewal_failed', metadata: '{"profile":"Lead Profile","agentId":"X"}' }));
    expect(event['subject']).toBeUndefined();
    expect(event['link']).toEqual({ product: 'magnus', path: '/fleet/ardent/profiles/Node%20With%20Spaces~Lead%20Profile' });
    expect(validateHiveEvent(event, { strict: true }).ok).toBe(true);
  });
});
