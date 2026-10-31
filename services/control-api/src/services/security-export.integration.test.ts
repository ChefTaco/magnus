import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { enqueueSecurityObservations } from './security-export.js';
describe.skipIf(!process.env['TEST_DATABASE_URL'])(
  'security observations on disposable PostgreSQL',
  () => {
    let db: ReturnType<(typeof import('../db/index.js'))['getDb']>;
    const node = `review-${randomUUID()}`;
    beforeAll(async () => {
      const url = process.env['TEST_DATABASE_URL']!;
      if (!new URL(url).pathname.startsWith('/magnus_ideas'))
        throw new Error('Disposable database required');
      vi.stubEnv('DATABASE_URL', url);
      vi.stubEnv('SECURITY_FUSION_MODE', 'remote');
      db = (await import('../db/index.js')).getDb();
    });
    afterAll(async () => {
      if (db) {
        await db.securityExportOutbox.deleteMany({ where: { payload: { contains: node } } });
        await db.securityServiceState.deleteMany({ where: { nodeId: node } });
        await db.$disconnect();
      }
      vi.unstubAllEnvs();
    });
    const services = (status: string) => [{ name: 'fixture', status }];
    it('commits each transition exactly once across concurrent retries and rollback', async () => {
      const observed = new Date('2026-09-17T10:00:00Z');
      await expect(
        db.$transaction(async (tx) => {
          await enqueueSecurityObservations(tx, node, node, services('failed'), 'first', observed);
          throw new Error('injected transaction failure');
        }),
      ).rejects.toThrow('injected');
      expect(await db.securityServiceState.count({ where: { nodeId: node } })).toBe(0);
      expect(await db.securityExportOutbox.count({ where: { payload: { contains: node } } })).toBe(
        0,
      );
      await Promise.all(
        Array.from({ length: 8 }, () =>
          db.$transaction((tx) =>
            enqueueSecurityObservations(tx, node, node, services('failed'), 'first', observed),
          ),
        ),
      );
      await db.$transaction((tx) =>
        enqueueSecurityObservations(
          tx,
          node,
          node,
          services('active'),
          'recovery',
          new Date('2026-09-17T10:15:00Z'),
        ),
      );
      await Promise.all(
        Array.from({ length: 8 }, () =>
          db.$transaction((tx) =>
            enqueueSecurityObservations(
              tx,
              node,
              node,
              services('failed'),
              'second',
              new Date('2026-09-17T18:00:00Z'),
            ),
          ),
        ),
      );
      const events = await db.securityExportOutbox.findMany({
        where: { payload: { contains: node } },
      });
      expect(events).toHaveLength(2);
      expect(new Set(events.map((e) => e.id)).size).toBe(2);
    });
  },
);
