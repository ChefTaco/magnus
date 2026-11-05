import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';

const nodeCount = vi.fn().mockResolvedValue(0);
const nodeFindMany = vi.fn().mockResolvedValue([]);
const emptyCount = { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) };

vi.mock('../db/index.js', () => ({
  getDb: () => ({ node: { count: nodeCount, findMany: nodeFindMany }, remoteCommand: emptyCount, cronJob: emptyCount }),
}));
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../services/audit-service.js', () => ({ queryAuditEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }) }));
vi.mock('../services/codex-service.js', () => ({ getCodexFleetPosture: vi.fn().mockResolvedValue({}) }));

const { statsRouter } = await import('./stats.js');

describe('GET /stats/overview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not count sentinel records as fleet nodes', async () => {
    await statsRouter.request('/overview');
    expect(nodeCount.mock.calls.length).toBeGreaterThan(0);
    for (const [query] of [...nodeCount.mock.calls, ...nodeFindMany.mock.calls]) {
      expect(query.where.id).toEqual({ notIn: SENTINEL_NODE_IDS });
    }
  });
});
