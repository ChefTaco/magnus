import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
vi.mock('../db/index.js', () => ({
  getDb: () => ({ healthSnapshot: { findMany }, node: { findMany: vi.fn() } }),
}));

const { capacityRecommendation, forecastDisk } = await import('./forecast-service.js');

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
