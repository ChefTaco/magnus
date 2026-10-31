import { getDb } from '../db/index.js';

import type { DiskForecast } from '../types/index.js';

// ─── Linear Regression ───

interface Point {
  x: number;
  y: number;
}

interface RegressionResult {
  slope: number;
  intercept: number;
  r2: number;
}

function linearRegression(points: Point[]): RegressionResult {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };

  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumX2 = points.reduce((a, p) => a + p.x ** 2, 0);

  const denom = n * sumX2 - sumX ** 2;
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R² for confidence
  const yMean = sumY / n;
  const ssTot = points.reduce((a, p) => a + (p.y - yMean) ** 2, 0);
  if (ssTot === 0) return { slope, intercept, r2: 1 };

  const ssRes = points.reduce(
    (a, p) => a + (p.y - (slope * p.x + intercept)) ** 2,
    0,
  );
  const r2 = 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}

// ─── Disk info shape from JSON ───

interface DiskInfoRaw {
  mountPoint: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
  filesystem: string;
  filesystemType?: string;
}

// ─── Forecast for a single node ───

const MS_PER_DAY = 86_400_000;
const MIN_DATA_POINTS = 3;
const MIN_FORECAST_CONFIDENCE = 0.25;
const DEFAULT_LOOKBACK_DAYS = 30;

const SYSTEM_MOUNT_PREFIXES = ['/boot', '/snap', '/var/lib/docker/', '/var/lib/containers/'];
const READ_ONLY_FILESYSTEMS = new Set(['iso9660', 'squashfs']);

function isForecastableVolume(disk: DiskInfoRaw): boolean {
  const workloadPath = disk.mountPoint === '/'
    || disk.mountPoint === '/home'
    || disk.mountPoint.startsWith('/home/')
    || disk.mountPoint.startsWith('/mnt/')
    || disk.mountPoint.startsWith('/srv/');
  return workloadPath
    && !SYSTEM_MOUNT_PREFIXES.some((prefix) => disk.mountPoint === prefix || disk.mountPoint.startsWith(prefix))
    && !READ_ONLY_FILESYSTEMS.has((disk.filesystemType ?? '').toLowerCase());
}

export function capacityRecommendation(mountPoint: string): Pick<DiskForecast, 'workloadClass' | 'recommendation'> {
  if (/\b(models?|checkpoints?|weights?|ollama|huggingface)\b/i.test(mountPoint)) {
    return {
      workloadClass: 'models',
      recommendation: 'Move inactive model checkpoints to colder storage, remove superseded weights, or expand this model volume before the forecast horizon.',
    };
  }
  if (/\b(cache|download|tmp|artifact)\b/i.test(mountPoint)) {
    return {
      workloadClass: 'downloads-cache',
      recommendation: 'Expire completed downloads and cache entries, cap cache size, or redirect new artifacts to a larger persistent volume.',
    };
  }
  return {
    workloadClass: 'general',
    recommendation: 'Review the largest growing directories, enforce retention, and plan volume expansion before the forecast horizon.',
  };
}

export async function forecastDisk(
  nodeId: string,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
): Promise<DiskForecast[]> {
  const db = getDb();
  const since = new Date(Date.now() - lookbackDays * MS_PER_DAY);

  const snapshots = await db.healthSnapshot.findMany({
    where: { nodeId, timestamp: { gte: since } },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, disks: true },
  });

  if (snapshots.length < MIN_DATA_POINTS) return [];

  // Collect per-mount time series: mountPoint → { timestamp, usedBytes, totalBytes }[]
  const mountSeries = new Map<
    string,
    { timestamp: number; usedBytes: number; totalBytes: number }[]
  >();

  for (const snap of snapshots) {
    let disks: DiskInfoRaw[];
    try {
      disks = JSON.parse(snap.disks) as DiskInfoRaw[];
    } catch {
      continue;
    }

    const ts = snap.timestamp.getTime();
    for (const d of disks) {
      if (!d || typeof d.mountPoint !== 'string' || !Number.isFinite(d.usedBytes) || !Number.isFinite(d.totalBytes) || !isForecastableVolume(d)) continue;
      if (!mountSeries.has(d.mountPoint)) {
        mountSeries.set(d.mountPoint, []);
      }
      mountSeries.get(d.mountPoint)!.push({
        timestamp: ts,
        usedBytes: d.usedBytes,
        totalBytes: d.totalBytes,
      });
    }
  }

  const forecasts: DiskForecast[] = [];

  for (const [mountPoint, series] of mountSeries) {
    if (series.length < MIN_DATA_POINTS) continue;

    const latest = series[series.length - 1]!;
    const totalBytes = latest.totalBytes;
    const currentUsagePercent =
      totalBytes > 0 ? (latest.usedBytes / totalBytes) * 100 : 0;

    // Build regression points: x = days since first sample, y = usedBytes
    const t0 = series[0]!.timestamp;
    const points: Point[] = series.map((s) => ({
      x: (s.timestamp - t0) / MS_PER_DAY,
      y: s.usedBytes,
    }));

    const reg = linearRegression(points);
    const growthRatePerDay = reg.slope; // bytes per day

    let estimatedFullDate: string | null = null;
    let daysUntilFull: number | null = null;

    if (growthRatePerDay > 0 && reg.r2 >= MIN_FORECAST_CONFIDENCE) {
      const availableBytes = totalBytes - latest.usedBytes;
      daysUntilFull = Math.ceil(availableBytes / growthRatePerDay);
      const fullDate = new Date(Date.now() + daysUntilFull * MS_PER_DAY);
      estimatedFullDate = fullDate.toISOString().split('T')[0] ?? null;
    }

    forecasts.push({
      mountPoint,
      currentUsagePercent: Math.round(currentUsagePercent * 100) / 100,
      growthRatePerDay: Math.round(growthRatePerDay),
      estimatedFullDate,
      daysUntilFull,
      confidence: Math.round(Math.max(0, reg.r2) * 100) / 100,
      ...capacityRecommendation(mountPoint),
    });
  }

  return forecasts;
}

// ─── Fleet-wide at-risk nodes ───

export async function forecastAtRisk(
  daysThreshold = 30,
): Promise<{ nodeId: string; hostname: string | null; forecasts: DiskForecast[] }[]> {
  const db = getDb();

  const nodes = await db.node.findMany({
    select: { id: true, hostname: true },
  });

  const results: { nodeId: string; hostname: string | null; forecasts: DiskForecast[] }[] = [];

  for (const node of nodes) {
    const forecasts = await forecastDisk(node.id);
    const atRisk = forecasts.filter(
      (f) => f.daysUntilFull !== null && f.daysUntilFull <= daysThreshold,
    );

    if (atRisk.length > 0) {
      results.push({
        nodeId: node.id,
        hostname: node.hostname,
        forecasts: atRisk,
      });
    }
  }

  // Sort by most urgent first
  results.sort((a, b) => {
    const aMin = Math.min(
      ...a.forecasts.map((f) => f.daysUntilFull ?? Infinity),
    );
    const bMin = Math.min(
      ...b.forecasts.map((f) => f.daysUntilFull ?? Infinity),
    );
    return aMin - bMin;
  });

  return results;
}
