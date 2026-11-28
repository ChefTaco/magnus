/**
 * Values the health time-series route (`GET /nodes/:nodeId/health/timeseries`) charts, read from
 * one stored health snapshot.
 */

export type MetricName = 'cpu' | 'memory' | 'swap' | 'disk';

/** One chart value, in percent, from a health snapshot row. */
export function extractMetric(snapshot: Record<string, unknown>, metric: MetricName): number {
  switch (metric) {
    case 'cpu': return Number(snapshot['cpuUsagePercent'] ?? 0);
    case 'memory': return Number(snapshot['memoryPercent'] ?? 0);
    case 'swap': {
      const total = Number(snapshot['swapTotalBytes'] ?? 0);
      const used = Number(snapshot['swapUsedBytes'] ?? 0);
      return total > 0 ? (used / total) * 100 : 0;
    }
    case 'disk': {
      try {
        const disks: unknown = typeof snapshot['disks'] === 'string' ? JSON.parse(snapshot['disks']) : snapshot['disks'];
        // The agent reports each disk's `usagePercent` (packages/agent/src/collectors/health-collector.ts); the first is the root mount.
        const first: unknown = Array.isArray(disks) ? disks[0] : undefined;
        if (first && typeof first === 'object') return Number((first as { usagePercent?: unknown }).usagePercent ?? 0) || 0;
      } catch { /* ignore */ }
      return 0;
    }
  }
}
