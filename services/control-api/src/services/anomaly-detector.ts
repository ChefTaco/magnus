/**
 * anomaly-detector.ts — Statistical anomaly detection using Z-score analysis.
 *
 * For each node+metric, maintains a rolling window of health samples (last 7 days)
 * and flags unusually high values. Statistical deviation identifies an anomaly;
 * operational pressure determines whether it is warning or critical.
 *
 * Resource pressure policy:
 *   CPU    warning at 80%, critical at 95%, sustained for 15 minutes
 *   Disk   warning at 80%, critical at 95%
 *   Memory warning at 85%, critical at 95%, only while swap is in use
 *   Swap   follows memory pressure; swap usage alone is informational
 */

import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { createNotification } from './notification-service.js';
import { eventBus, EventChannels } from './event-bus.js';
import { evaluateRemediation } from './remediation-service.js';

// ── Configuration ──

const Z_SCORE_THRESHOLD = Number(process.env['ANOMALY_Z_THRESHOLD'] ?? '4');
const BASELINE_DAYS = Number(process.env['ANOMALY_BASELINE_DAYS'] ?? '7');
const BASELINE_CACHE_MS = Number(process.env['ANOMALY_BASELINE_CACHE_MS'] ?? 5 * 60_000);
const CPU_WARNING_PERCENT = Number(process.env['ANOMALY_CPU_WARNING_PERCENT'] ?? '80');
const CPU_CRITICAL_PERCENT = Number(process.env['ANOMALY_CPU_CRITICAL_PERCENT'] ?? '95');
const CPU_SUSTAINED_MINUTES = Number(process.env['ANOMALY_CPU_SUSTAINED_MINUTES'] ?? '15');
const DISK_WARNING_PERCENT = Number(process.env['ANOMALY_DISK_WARNING_PERCENT'] ?? '80');
const DISK_CRITICAL_PERCENT = Number(process.env['ANOMALY_DISK_CRITICAL_PERCENT'] ?? '95');
const MEMORY_WARNING_PERCENT = Number(process.env['ANOMALY_MEMORY_WARNING_PERCENT'] ?? '85');
const MEMORY_CRITICAL_PERCENT = Number(process.env['ANOMALY_MEMORY_CRITICAL_PERCENT'] ?? '95');
const MIN_SAMPLES = 10; // Require at least N data points before detecting anomalies
const MAX_CPU_SAMPLE_GAP_MS = 90 * 1000;

// ── Types ──

export interface AnomalyResult {
  isAnomaly: boolean;
  zScore: number;
  mean: number;
  stdDev: number;
  current: number;
  severity: 'info' | 'warning' | 'critical';
}

type ResourceMetric = 'cpu' | 'memory' | 'swap' | 'disk';

interface MetricExtraction {
  metric: ResourceMetric;
  value: number;
}

interface BaselineSnapshot {
  cpuUsagePercent: number;
  memoryPercent: number;
  swapTotalBytes: bigint;
  swapUsedBytes: bigint;
  disks: string;
}

type MetricBaselines = Record<ResourceMetric, number[]>;

const baselineCache = new Map<string, { expiresAt: number; baselines: MetricBaselines }>();

export interface TimedMetricSample {
  timestamp: Date;
  value: number;
}

interface PressureContext {
  memoryPercent?: number;
  swapUsedBytes?: number;
  cpuSamples?: TimedMetricSample[];
}

// ── Core detection ──

/**
 * Compute z-score for a single metric value against its historical baseline.
 */
export function detectAnomaly(current: number, history: number[]): AnomalyResult {
  if (history.length < MIN_SAMPLES) {
    return { isAnomaly: false, zScore: 0, mean: current, stdDev: 0, current, severity: 'info' };
  }

  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
  const stdDev = Math.sqrt(variance);

  // Avoid division by zero — if all historic values are identical, any deviation is anomalous
  const zScore = stdDev === 0 ? (current === mean ? 0 : 999) : (current - mean) / stdDev;

  return {
    // Resource utilization decreasing unexpectedly is not operational pressure.
    isAnomaly: zScore >= Z_SCORE_THRESHOLD,
    zScore: Math.round(zScore * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    current,
    severity: 'info',
  };
}

/**
 * Require a continuous trailing run above the threshold. Sparse samples or a
 * single spike cannot promote CPU severity.
 */
export function hasSustainedCpuPressure(
  samples: TimedMetricSample[],
  threshold: number,
  durationMinutes: number = CPU_SUSTAINED_MINUTES,
): boolean {
  if (samples.length < 2) return false;

  const ordered = [...samples].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const newest = ordered[ordered.length - 1];
  if (!newest || newest.value < threshold) return false;

  let oldest = newest;
  for (let i = ordered.length - 2; i >= 0; i--) {
    const sample = ordered[i];
    if (!sample) break;
    const gap = oldest.timestamp.getTime() - sample.timestamp.getTime();
    if (gap > MAX_CPU_SAMPLE_GAP_MS || sample.value < threshold) break;
    oldest = sample;
  }

  return newest.timestamp.getTime() - oldest.timestamp.getTime() >= durationMinutes * 60 * 1000;
}

/** Promote statistical anomalies only when the resource is under real pressure. */
export function classifyResourceSeverity(
  metric: string,
  current: number,
  context: PressureContext = {},
): 'info' | 'warning' | 'critical' {
  switch (metric) {
    case 'cpu':
      if (hasSustainedCpuPressure(context.cpuSamples ?? [], CPU_CRITICAL_PERCENT)) return 'critical';
      if (hasSustainedCpuPressure(context.cpuSamples ?? [], CPU_WARNING_PERCENT)) return 'warning';
      return 'info';
    case 'disk':
      if (current >= DISK_CRITICAL_PERCENT) return 'critical';
      if (current >= DISK_WARNING_PERCENT) return 'warning';
      return 'info';
    case 'memory':
    case 'swap': {
      const memoryPercent = context.memoryPercent ?? (metric === 'memory' ? current : 0);
      const isSwapping = (context.swapUsedBytes ?? 0) > 0;
      if (!isSwapping) return 'info';
      if (memoryPercent >= MEMORY_CRITICAL_PERCENT) return 'critical';
      if (memoryPercent >= MEMORY_WARNING_PERCENT) return 'warning';
      return 'info';
    }
    default:
      return 'info';
  }
}

// ── Extract metrics from a health snapshot ──

interface HealthPayload {
  cpuUsagePercent?: number;
  memoryPercent?: number;
  swapTotalBytes?: number | bigint;
  swapUsedBytes?: number | bigint;
  disks?: Array<{ usagePercent?: number; mountpoint?: string; mountPoint?: string }>;
  network?: Array<{ rxBytes?: number; txBytes?: number }>;
}

function extractMetrics(metrics: HealthPayload): MetricExtraction[] {
  const result: MetricExtraction[] = [];

  if (metrics.cpuUsagePercent !== undefined) {
    result.push({ metric: 'cpu', value: metrics.cpuUsagePercent });
  }
  if (metrics.memoryPercent !== undefined) {
    result.push({ metric: 'memory', value: metrics.memoryPercent });
  }

  // Swap as percentage
  const swapTotal = Number(metrics.swapTotalBytes ?? 0);
  const swapUsed = Number(metrics.swapUsedBytes ?? 0);
  if (swapTotal > 0) {
    result.push({ metric: 'swap', value: (swapUsed / swapTotal) * 100 });
  }

  // Max disk usage
  const disks = metrics.disks ?? [];
  if (disks.length > 0) {
    const maxDisk = Math.max(...disks.map((d) => d.usagePercent ?? 0));
    result.push({ metric: 'disk', value: maxDisk });
  }

  return result;
}

// ── Fetch historical baseline for a node+metric ──

export function buildMetricBaselines(snapshots: BaselineSnapshot[]): MetricBaselines {
  const baselines: MetricBaselines = { cpu: [], memory: [], swap: [], disk: [] };
  for (const snapshot of snapshots) {
    baselines.cpu.push(snapshot.cpuUsagePercent);
    baselines.memory.push(snapshot.memoryPercent);
    const total = Number(snapshot.swapTotalBytes);
    const used = Number(snapshot.swapUsedBytes);
    baselines.swap.push(total > 0 ? (used / total) * 100 : 0);
    try {
      const disks = JSON.parse(snapshot.disks) as Array<{ usagePercent?: number }>;
      baselines.disk.push(Math.max(0, ...disks.map((disk) => disk.usagePercent ?? 0)));
    } catch {
      baselines.disk.push(0);
    }
  }
  return baselines;
}

async function getBaselines(nodeId: string): Promise<MetricBaselines> {
  const now = Date.now();
  const cached = baselineCache.get(nodeId);
  if (cached && cached.expiresAt > now) return cached.baselines;

  const db = getDb();
  const since = new Date(now - BASELINE_DAYS * 24 * 60 * 60 * 1000);

  const snapshots = await db.healthSnapshot.findMany({
    where: { nodeId, timestamp: { gte: since } },
    select: {
      cpuUsagePercent: true,
      memoryPercent: true,
      swapTotalBytes: true,
      swapUsedBytes: true,
      disks: true,
    },
    orderBy: { timestamp: 'asc' },
  });
  const baselines = buildMetricBaselines(snapshots);
  baselineCache.set(nodeId, { expiresAt: now + BASELINE_CACHE_MS, baselines });
  return baselines;
}

async function getRecentCpuSamples(nodeId: string): Promise<TimedMetricSample[]> {
  const db = getDb();
  // Include one extra sample interval so a full 15-minute trailing run can be proven.
  const since = new Date(Date.now() - (CPU_SUSTAINED_MINUTES * 60 * 1000 + MAX_CPU_SAMPLE_GAP_MS));
  const snapshots = await db.healthSnapshot.findMany({
    where: { nodeId, timestamp: { gte: since } },
    select: { timestamp: true, cpuUsagePercent: true },
    orderBy: { timestamp: 'asc' },
  });
  return snapshots.map((snapshot) => ({
    timestamp: snapshot.timestamp,
    value: snapshot.cpuUsagePercent,
  }));
}

// ── Main evaluation entry point ──

/**
 * Evaluate a node's health metrics for anomalies. Called after storing each heartbeat snapshot.
 */
export async function evaluateAnomalies(
  nodeId: string,
  nodeName: string,
  metrics: HealthPayload,
  healthSnapshotId?: string,
): Promise<AnomalyResult[]> {
  const db = getDb();
  const extractions = extractMetrics(metrics);
  const results: AnomalyResult[] = [];
  const [baselines, cpuSamples] = await Promise.all([
    getBaselines(nodeId),
    extractions.some(({ metric }) => metric === 'cpu')
      ? getRecentCpuSamples(nodeId)
      : Promise.resolve([]),
  ]);

  for (const { metric, value } of extractions) {
    const history = baselines[metric];
    const result = detectAnomaly(value, history);
    result.severity = classifyResourceSeverity(metric, value, {
      memoryPercent: metrics.memoryPercent,
      swapUsedBytes: Number(metrics.swapUsedBytes ?? 0),
      cpuSamples,
    });
    results.push(result);

    const existing = await db.anomalyEvent.findFirst({
      where: { nodeId, metric, resolved: false },
      orderBy: { lastSeenAt: 'desc' },
    });

    if (result.isAnomaly) {
      let anomalyId: string;

      if (existing) {
        // Roll up — update the existing anomaly event
        anomalyId = existing.id;
        await db.anomalyEvent.update({
          where: { id: existing.id },
          data: {
            value: result.current,
            zScore: result.zScore,
            mean: result.mean,
            stdDev: result.stdDev,
            severity: result.severity,
            ...(healthSnapshotId ? { healthSnapshotId } : {}),
            lastSeenAt: new Date(),
            occurrenceCount: { increment: 1 },
          },
        });
      } else {
        // Create a new anomaly event
        anomalyId = nanoid();
        await db.anomalyEvent.create({
          data: {
            id: anomalyId,
            nodeId,
            metric,
            value: result.current,
            zScore: result.zScore,
            mean: result.mean,
            stdDev: result.stdDev,
            severity: result.severity,
            ...(healthSnapshotId ? { healthSnapshotId } : {}),
          },
        });
      }

      // Publish to event bus
      await eventBus.publish(EventChannels.ALERT_FIRED, {
        type: 'anomaly',
        nodeId,
        nodeName,
        metric,
        value: result.current,
        zScore: result.zScore,
        severity: result.severity,
      });

      // Create notification for warning+ anomalies
      if (result.severity === 'warning' || result.severity === 'critical') {
        const metricLabel = metric.toUpperCase();
        await createNotification({
          type: `anomaly.${metric}` as 'node.degraded',
          severity: result.severity,
          title: `Anomaly: ${metricLabel} on ${nodeName} (z=${result.zScore})`,
          message: `Statistical anomaly detected: ${metricLabel} is ${result.current.toFixed(1)}% (mean: ${result.mean.toFixed(1)}%, z-score: ${result.zScore}). This is unusual for this node.`,
          nodeId,
          nodeName,
          metadata: {
            metric,
            value: result.current,
            zScore: result.zScore,
            mean: result.mean,
            stdDev: result.stdDev,
            severity: result.severity,
          },
        });
      }

      // Evaluate auto-remediation rules (fire-and-forget)
      evaluateRemediation({
        id: anomalyId,
        nodeId,
        nodeName,
        metric,
        value: result.current,
        zScore: result.zScore,
        severity: result.severity,
      }).catch((err) => {
        console.error(`[remediation] evaluate error for ${nodeId}/${metric}:`, err instanceof Error ? err.message : err);
      });
    } else if (existing) {
      // Close the rollup when the metric returns to its normal range. Previously
      // these events stayed active forever and made one-off spikes look current.
      await db.anomalyEvent.update({
        where: { id: existing.id },
        data: { resolved: true, resolvedAt: new Date() },
      });
    }
  }

  return results;
}

// ── Query helpers ──

export async function listAnomalyEvents(params: {
  nodeId?: string;
  metric?: string;
  severity?: string;
  resolved?: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ anomalies: unknown[]; total: number }> {
  const db = getDb();
  const page = params.page ?? 1;
  const pageSize = Math.min(params.pageSize ?? 50, 100);
  const skip = (page - 1) * pageSize;

  const where: Record<string, unknown> = {};
  if (params.nodeId) where['nodeId'] = params.nodeId;
  if (params.metric) where['metric'] = params.metric;
  if (params.severity) where['severity'] = params.severity;
  if (params.resolved !== undefined) where['resolved'] = params.resolved;

  const [anomalies, total] = await Promise.all([
    db.anomalyEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      include: { node: { select: { name: true, hostname: true } } },
    }),
    db.anomalyEvent.count({ where }),
  ]);

  return { anomalies, total };
}

export async function getNodeAnomalySummary(nodeId: string): Promise<{
  total: number;
  active: number;
  byMetric: Record<string, number>;
  recent: unknown[];
}> {
  const db = getDb();

  const [total, active, recent] = await Promise.all([
    db.anomalyEvent.count({ where: { nodeId } }),
    db.anomalyEvent.count({ where: { nodeId, resolved: false } }),
    db.anomalyEvent.findMany({
      where: { nodeId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  // Compute by-metric breakdown
  const byMetricRaw = await db.anomalyEvent.groupBy({
    by: ['metric'],
    where: { nodeId, resolved: false },
    _count: true,
  });
  const byMetric: Record<string, number> = {};
  for (const row of byMetricRaw) {
    byMetric[row.metric] = row._count;
  }

  return { total, active, byMetric, recent };
}

export async function resolveAnomaly(id: string): Promise<void> {
  const db = getDb();
  await db.anomalyEvent.update({
    where: { id },
    data: { resolved: true, resolvedAt: new Date() },
  });
}

export async function resolveNodeAnomalies(nodeId: string, metric?: string): Promise<number> {
  const db = getDb();
  const where: Record<string, unknown> = { nodeId, resolved: false };
  if (metric) where['metric'] = metric;

  const result = await db.anomalyEvent.updateMany({
    where,
    data: { resolved: true, resolvedAt: new Date() },
  });
  return result.count;
}

/**
 * Get a fleet-wide anomaly summary for the AI heartbeat.
 */
export async function getFleetAnomalySummary(): Promise<{
  totalActive: number;
  byNode: Array<{ nodeId: string; nodeName: string; count: number; metrics: string[] }>;
  bySeverity: Record<string, number>;
}> {
  const db = getDb();

  const activeAnomalies = await db.anomalyEvent.findMany({
    where: { resolved: false },
    include: { node: { select: { name: true } } },
  });

  const totalActive = activeAnomalies.length;

  // Group by node
  const nodeMap = new Map<string, { nodeName: string; count: number; metrics: Set<string> }>();
  const severityMap: Record<string, number> = { info: 0, warning: 0, critical: 0 };

  for (const a of activeAnomalies) {
    const entry = nodeMap.get(a.nodeId) ?? {
      nodeName: a.node.name,
      count: 0,
      metrics: new Set<string>(),
    };
    entry.count++;
    entry.metrics.add(a.metric);
    nodeMap.set(a.nodeId, entry);

    severityMap[a.severity] = (severityMap[a.severity] ?? 0) + 1;
  }

  const byNode = Array.from(nodeMap.entries()).map(([nodeId, v]) => ({
    nodeId,
    nodeName: v.nodeName,
    count: v.count,
    metrics: Array.from(v.metrics),
  }));

  return { totalActive, byNode, bySeverity: severityMap };
}

/**
 * Purge old resolved anomalies beyond the retention period.
 * Returns the number of deleted rows.
 */
export async function purgeResolvedAnomalies(retentionDays: number = 30): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db.anomalyEvent.deleteMany({
    where: {
      resolved: true,
      resolvedAt: { lt: cutoff },
    },
  });
  return result.count;
}
