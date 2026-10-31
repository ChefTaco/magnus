import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  securityFusionEvent: {
    findMany: vi.fn(),
  },
  securityFusionRuleVersion: {
    upsert: vi.fn(),
  },
  securityFusionSourceState: {
    upsert: vi.fn(),
  },
}));

vi.mock('../db/index.js', () => ({ getDb: () => db }));

import { ingestMagnusServiceHealth } from './security-fusion-service.js';

describe('Security Fusion heartbeat ingestion', () => {
  let testTime = new Date('2026-08-19T03:30:00.000Z').getTime();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    testTime += 2 * 60_000;
    vi.setSystemTime(testTime);
  });

  afterAll(() => vi.useRealTimers());

  it('does not run event ingestion for a daily service observation already stored', async () => {
    db.securityFusionEvent.findMany.mockImplementation(async ({ where }: {
      where: { sourceEventId: { in: string[] } };
    }) => (
      where.sourceEventId.in.map((sourceEventId: string) => ({ sourceEventId }))
    ));

    await ingestMagnusServiceHealth('node-1', 'node-b', [
      { name: 'logrotate', status: 'failed' },
    ]);

    expect(db.securityFusionEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ source: 'magnus' }),
      select: { sourceEventId: true },
    }));
    expect(db.securityFusionRuleVersion.upsert).not.toHaveBeenCalled();
  });

  it('coalesces fleet-wide source freshness writes within one minute', async () => {
    await ingestMagnusServiceHealth('node-1', 'one', []);
    await ingestMagnusServiceHealth('node-2', 'two', []);

    expect(db.securityFusionSourceState.upsert).toHaveBeenCalledTimes(1);
    expect(db.securityFusionEvent.findMany).not.toHaveBeenCalled();
  });
});
