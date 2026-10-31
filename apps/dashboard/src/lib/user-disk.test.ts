import { describe, expect, it } from 'vitest';
import {
  getUserDisk,
  getUserDiskSeverity,
  getWorstPersistentDisk,
  parseDisks,
} from './user-disk';

const rootDisk = {
  mountPoint: '/',
  totalBytes: 100,
  usedBytes: 40,
  freeBytes: 60,
  usagePercent: 40,
  filesystem: '/dev/root',
};

const homeDisk = {
  mountPoint: '/home',
  totalBytes: 200,
  usedBytes: 182,
  freeBytes: 18,
  usagePercent: 91,
  filesystem: '/dev/home',
};

describe('user disk selection', () => {
  it('selects a dedicated /home filesystem', () => {
    expect(getUserDisk([rootDisk, homeDisk])).toEqual(homeDisk);
  });

  it('falls back to the root filesystem when /home is not separate', () => {
    expect(getUserDisk(JSON.stringify([rootDisk]))).toEqual(rootDisk);
  });

  it('prefers the Unraid user share and otherwise selects the fullest data mount', () => {
    const dataDisk = { ...homeDisk, mountPoint: '/mnt/data', usagePercent: 80 };
    const unraidDisk = { ...homeDisk, mountPoint: '/mnt/user', usagePercent: 91 };
    expect(getUserDisk([rootDisk, dataDisk, unraidDisk])).toEqual(unraidDisk);
    expect(getUserDisk([rootDisk, dataDisk])).toEqual(dataDisk);
  });

  it('handles missing and malformed disk telemetry', () => {
    expect(getUserDisk(null)).toBeNull();
    expect(parseDisks('{not-json')).toEqual([]);
  });

  it('surfaces the fullest workload volume even when /home is healthy', () => {
    const healthyHome = { ...homeDisk, usagePercent: 40 };
    const criticalModels = { ...homeDisk, mountPoint: '/srv/models', usagePercent: 97 };
    expect(getWorstPersistentDisk([rootDisk, healthyHome, criticalModels])).toEqual(criticalModels);
  });

  it('excludes known system and read-only mounts from severity', () => {
    const boot = { ...homeDisk, mountPoint: '/boot', usagePercent: 99 };
    const readOnly = { ...homeDisk, mountPoint: '/mnt/media', filesystemType: 'iso9660', usagePercent: 100 };
    expect(getWorstPersistentDisk([rootDisk, boot, readOnly])).toEqual(rootDisk);
  });
});

describe('user disk severity', () => {
  it('uses the fleet disk warning and critical thresholds', () => {
    expect(getUserDiskSeverity(79.9)).toBe('normal');
    expect(getUserDiskSeverity(80)).toBe('warning');
    expect(getUserDiskSeverity(94.9)).toBe('warning');
    expect(getUserDiskSeverity(95)).toBe('critical');
  });
});
