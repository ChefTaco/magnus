import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';

const findMany = vi.fn();
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findMany } }) }));

const { scanTopology } = await import('./topology-service.js');

describe('fleet topology', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries real fleet members only, so sentinel records are neither listed nor probed', async () => {
    findMany.mockResolvedValue([]);
    await expect(scanTopology(1)).resolves.toMatchObject({ nodes: [], subnets: [], edges: [] });
    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ id: { notIn: SENTINEL_NODE_IDS }, status: { not: 'DECOMMISSIONED' } });
  });
});
