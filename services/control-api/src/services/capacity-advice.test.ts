import { expect, it, vi } from 'vitest';
const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../db/index.js', () => ({
  getDb: () => ({ node: { findMany: () => Promise.resolve(rows.value) } }),
}));
import { getCapacityAdvice } from './operational-observations.js';
it('marks missing, malformed and stale GPU sensors unknown and hot sensors advisory', async () => {
  rows.value = [
    { id: 'missing', hostname: 'missing', gpuSnapshots: [] },
    { id: 'bad', hostname: 'bad', gpuSnapshots: [{ sampledAt: new Date(), devices: '[null]' }] },
    {
      id: 'old',
      hostname: 'old',
      gpuSnapshots: [
        { sampledAt: new Date(0), devices: '[{"utilizationPercent":2,"temperatureCelsius":40}]' },
      ],
    },
    {
      id: 'hot',
      hostname: 'hot',
      gpuSnapshots: [
        { sampledAt: new Date(), devices: '[{"utilizationPercent":92,"temperatureCelsius":88}]' },
      ],
    },
  ];
  const advice = await getCapacityAdvice();
  expect(advice.advisoryOnly).toBe(true);
  expect(advice.nodes.map((n) => n.capacity)).toEqual([
    'unknown',
    'unknown',
    'unknown',
    'constrained',
  ]);
});
