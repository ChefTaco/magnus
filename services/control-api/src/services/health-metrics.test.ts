import { describe, expect, it } from 'vitest';
import { extractMetric } from './health-metrics.js';

describe('health time-series metrics', () => {
  it('reads the disk series from the usagePercent the agent reports', () => {
    // The shape packages/agent/src/collectors/health-collector.ts stores in HealthSnapshot.disks.
    const disks = JSON.stringify([
      { mountPoint: '/', device: '/dev/sda1', fsType: 'ext4', totalBytes: 100, usedBytes: 42, availableBytes: 58, usagePercent: 42 },
      { mountPoint: '/data', device: '/dev/sdb1', fsType: 'ext4', totalBytes: 100, usedBytes: 90, availableBytes: 10, usagePercent: 90 },
    ]);
    expect(extractMetric({ disks }, 'disk')).toBe(42);
    expect(extractMetric({ disks: JSON.parse(disks) }, 'disk')).toBe(42);
  });

  it('answers 0 for a snapshot without usable disk data', () => {
    expect(extractMetric({ disks: '[]' }, 'disk')).toBe(0);
    expect(extractMetric({ disks: 'not json' }, 'disk')).toBe(0);
    expect(extractMetric({ disks: JSON.stringify([{ mountPoint: '/' }]) }, 'disk')).toBe(0);
    expect(extractMetric({}, 'disk')).toBe(0);
  });

  it('keeps the other metrics', () => {
    expect(extractMetric({ cpuUsagePercent: 12.5 }, 'cpu')).toBe(12.5);
    expect(extractMetric({ memoryPercent: 60 }, 'memory')).toBe(60);
    expect(extractMetric({ swapTotalBytes: 200, swapUsedBytes: 50 }, 'swap')).toBe(25);
    expect(extractMetric({ swapTotalBytes: 0, swapUsedBytes: 0 }, 'swap')).toBe(0);
  });
});
