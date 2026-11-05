import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const nodeFindMany = vi.fn();
vi.mock('../db/index.js', () => ({
  getDb: () => ({ healthSnapshot: { findMany }, node: { findMany: nodeFindMany } }),
}));

const { capacityRecommendation, forecastAtRisk, forecastDisk } = await import('./forecast-service.js');

const disk = (mountPoint: string, usedBytes: number, totalBytes: number) => ({ mountPoint, usedBytes, totalBytes, filesystem: '/dev/data', filesystemType: 'ext4' });
const snapshot = (at: number, disks: unknown[]) => ({ timestamp: new Date(at), disks: JSON.stringify(disks) });

describe('capacity forecasting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calculates per-volume growth and model-aware days-to-full guidance', async () => {
    findMany.mockResolvedValue([
      { timestamp: new Date('2026-08-16T00:00:00Z'), disks: JSON.stringify([{ mountPoint: '/srv/models', usedBytes: 700, totalBytes: 1000, filesystem: '/dev/data', filesystemType: 'ext4' }]) },
      { timestamp: new Date('2026-08-17T00:00:00Z'), disks: JSON.stringify([{ mountPoint: '/srv/models', usedBytes: 750, totalBytes: 1000, filesystem: '/dev/data', filesystemType: 'ext4' }]) },
      { timestamp: new Date('2026-08-18T00:00:00Z'), disks: JSON.stringify([{ mountPoint: '/srv/models', usedBytes: 800, totalBytes: 1000, filesystem: '/dev/data', filesystemType: 'ext4' }]) },
    ]);

    await expect(forecastDisk('node-1')).resolves.toEqual([
      expect.objectContaining({
        mountPoint: '/srv/models',
        currentUsagePercent: 80,
        growthRatePerDay: 50,
        daysUntilFull: 4,
        workloadClass: 'models',
        recommendation: expect.stringContaining('model checkpoints'),
      }),
    ]);
  });

  it('answers for a flat disk, whose rounding residue once overflowed the fill date', async () => {
    // Identical samples leave a tiny positive slope at any heartbeat spacing, which put the date past the valid range.
    const start = Date.parse('2026-08-16T00:00:00Z');
    const mounts = Array.from({ length: 40 }, (_, index) => disk(`/srv/volume-${index}`, 100_000_000_000 + index * 37_000_000_019, 2_000_000_000_000));
    for (const gapMs of [7, 30_000, 3_600_000]) {
      findMany.mockResolvedValue(Array.from({ length: 12 }, (_, index) => snapshot(start + index * gapMs + (index % 3), mounts)));
      const forecasts = await forecastDisk('node-1');
      expect(forecasts).toHaveLength(40);
      for (const forecast of forecasts) {
        expect(forecast.growthRatePerDay).toBe(0);
        expect(forecast.estimatedFullDate).toBeNull();
        expect(forecast.daysUntilFull).toBeNull();
      }
    }
  });

  it('draws no trend from a burst of heartbeats', async () => {
    const start = Date.parse('2026-08-16T00:00:00Z');
    findMany.mockResolvedValue([0, 3, 9, 14].map((offset, index) => snapshot(start + offset, [disk('/', 1_000_000 + index * 4096, 2_000_000)])));
    await expect(forecastDisk('node-1')).resolves.toEqual([
      expect.objectContaining({ mountPoint: '/', growthRatePerDay: 0, confidence: 0, estimatedFullDate: null, daysUntilFull: null }),
    ]);
  });

  it('publishes no fill date further out than any useful forecast', async () => {
    const start = Date.parse('2026-08-16T00:00:00Z');
    findMany.mockResolvedValue([0, 1, 2].map((day) => snapshot(start + day * 86_400_000, [disk('/', 1_000 + day, 9_000_000_000_000)])));
    await expect(forecastDisk('node-1')).resolves.toEqual([
      expect.objectContaining({ growthRatePerDay: 1, estimatedFullDate: null, daysUntilFull: null }),
    ]);
  });

  it('treats a volume already past full as due now, not in negative days', async () => {
    const start = Date.parse('2026-08-16T00:00:00Z');
    findMany.mockResolvedValue([0, 1, 2].map((day) => snapshot(start + day * 86_400_000, [disk('/', 1_100 + day * 100, 1_000)])));
    await expect(forecastDisk('node-1')).resolves.toEqual([expect.objectContaining({ daysUntilFull: 0 })]);
  });

  it('leaves sentinel records out of the at-risk fleet scan', async () => {
    nodeFindMany.mockResolvedValue([]);
    await forecastAtRisk();
    expect(nodeFindMany.mock.calls[0]?.[0]?.where).toEqual({ id: { notIn: ['__control-api__', '__dashboard__'] } });
  });

  it('provides cache-aware and general recommendations', () => {
    expect(capacityRecommendation('/mnt/download-cache').workloadClass).toBe('downloads-cache');
    expect(capacityRecommendation('/home').workloadClass).toBe('general');
  });

  it('does not publish a fill date for a low-confidence positive trend', async () => {
    findMany.mockResolvedValue([
      { timestamp: new Date('2026-08-16T00:00:00Z'), disks: JSON.stringify([{ mountPoint: '/', usedBytes: 100, totalBytes: 1000, filesystem: '/dev/root', filesystemType: 'ext4' }]) },
      { timestamp: new Date('2026-08-17T00:00:00Z'), disks: JSON.stringify([{ mountPoint: '/', usedBytes: 900, totalBytes: 1000, filesystem: '/dev/root', filesystemType: 'ext4' }]) },
      { timestamp: new Date('2026-08-18T00:00:00Z'), disks: JSON.stringify([{ mountPoint: '/', usedBytes: 200, totalBytes: 1000, filesystem: '/dev/root', filesystemType: 'ext4' }]) },
    ]);

    await expect(forecastDisk('node-1')).resolves.toEqual([
      expect.objectContaining({
        mountPoint: '/',
        growthRatePerDay: 50,
        confidence: 0.01,
        estimatedFullDate: null,
        daysUntilFull: null,
      }),
    ]);
  });
});
