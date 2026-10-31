import { it, expect, vi, afterEach } from 'vitest';
import { securityFusionEventBatchSchema } from '@hivemagnus/magnus-contracts';
import { enqueueSecurityObservations } from './security-export.js';
import type { Prisma } from '../db/index.js';
afterEach(() => vi.unstubAllEnvs());
it('preserves fail/recover/fail while retries and unchanged observations emit once', async () => {
  vi.stubEnv('SECURITY_FUSION_MODE', 'remote');
  const states = new Map<string, unknown>();
  const events = new Map<string, string>();
  const db = {
    $executeRaw: vi.fn(),
    securityServiceState: {
      findUnique: async (q: any) => states.get(q.where.nodeId_serviceName.serviceName),
      upsert: async (q: any) => {
        states.set(q.create.serviceName, q.create);
      },
    },
    securityExportOutbox: {
      upsert: async (q: any) => {
        if (!events.has(q.where.id)) events.set(q.where.id, q.create.payload);
      },
    },
  } as unknown as Prisma.TransactionClient;
  const observe = (id: string, status: string, time: string) =>
    enqueueSecurityObservations(
      db,
      'node',
      'Node',
      [...Array.from({ length: 51 }, (_, index) => ({ name: `healthy-${index}`, status: 'active' })), { name: 'nginx', status }],
      id,
      new Date('2026-09-17T' + time + 'Z'),
    );
  await observe('failure-1', 'failed', '10:00:00');
  await observe('failure-1', 'failed', '10:00:00');
  await observe('unchanged', 'failed', '10:10:00');
  await observe('recovery', 'active', '10:15:00');
  await observe('failure-2', 'failed', '18:00:00');
  await observe('failure-2', 'failed', '18:00:00');
  await observe('recovery', 'active', '10:15:00');
  expect(events.size).toBe(2);
  const parsed = [...events.values()].map((raw) => JSON.parse(raw));
  expect(parsed.map((e) => e.sourceEventId)).toEqual([
    'node:nginx:failed:failure-1',
    'node:nginx:failed:failure-2',
  ]);
  expect(
    securityFusionEventBatchSchema.safeParse({
      schemaVersion: '1.0',
      collectorId: 'magnus-control-api',
      sentAt: new Date().toISOString(),
      events: parsed,
    }).success,
  ).toBe(true);
});
