import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateHiveEvent } from '@hivemagnus/hive-common/events';

/**
 * The feed query against PostgreSQL: the cursor's (createdAt, id) comparison, the tie order and
 * the 14-day window, which a mocked client can only restate.
 */
describe.skipIf(!process.env['TEST_DATABASE_URL'])('HiveEvent feed against PostgreSQL', () => {
  const prefix = `hive-events-${randomUUID()}`;
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let feed: typeof import('./hive-events.js');
  const now = new Date();
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    process.env['DATABASE_URL'] = url;
    db = (await import('../db/index.js')).getDb();
    feed = await import('./hive-events.js');
    // Other suites may share the database, so the checks below look only at this suite's rows.
    const shared = at(2 * DAY);
    const rows = [
      { id: `${prefix}-old`, createdAt: at(15 * DAY) },
      { id: `${prefix}-c`, createdAt: shared },
      { id: `${prefix}-a`, createdAt: shared },
      { id: `${prefix}-b`, createdAt: shared },
      { id: `${prefix}-d`, createdAt: at(DAY) },
      { id: `${prefix}-ardent`, createdAt: at(DAY - 1), type: 'ardent.hivemem.renewal_failed', metadata: '{"profile":"lead","agentId":"ardent-lead-0a1b2c3d"}' },
    ];
    for (const row of rows) {
      await db.notification.create({ data: {
        id: row.id, type: row.type ?? 'node.offline', severity: 'warning', title: prefix, message: 'fixture',
        nodeName: prefix, metadata: row.metadata ?? '{}', createdAt: row.createdAt,
      } });
    }
  });

  afterAll(async () => {
    await db?.notification.deleteMany({ where: { title: prefix } });
  });

  async function ours(access: { ardent: boolean }, limit: number) {
    const ids: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 1000; pages += 1) {
      const page = await feed.listHiveEvents({ after, limit, access, now });
      for (const event of page.data) {
        expect(validateHiveEvent(event, { strict: true }).ok).toBe(true);
        if (event.title === prefix) ids.push(event.sourceRef!);
      }
      if (!page.nextCursor) return ids;
      after = page.nextCursor;
    }
    throw new Error('the feed did not end');
  }

  it('orders by (createdAt, id), pages with the cursor and keeps to 14 days', async () => {
    const expected = ['a', 'b', 'c', 'd', 'ardent'].map(suffix => `${prefix}-${suffix}`);
    expect(await ours({ ardent: true }, 200)).toEqual(expected);
    expect(await ours({ ardent: true }, 1)).toEqual(expected);
    expect(await ours({ ardent: true }, 2)).toEqual(expected);
  });

  it('leaves Ardent notifications out for non-ADMIN callers', async () => {
    expect(await ours({ ardent: false }, 2)).toEqual(['a', 'b', 'c', 'd'].map(suffix => `${prefix}-${suffix}`));
  });
});
