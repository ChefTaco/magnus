/**
 * prediction-service.ts — Predictive failure detection using exponential smoothing.
 *
 * Uses double exponential smoothing (Holt's method) to forecast CPU, memory,
 * disk, and swap metrics 1–6 hours ahead. When a metric is predicted to exceed
 * a critical threshold within the forecast window, a prediction alert is fired.
 *
 * Run after each heartbeat, alongside the existing z-score anomaly detection.
 */

import { getDb } from '../db/index.js';
import { createNotification } from './notification-service.js';
import { eventBus, EventChannels } from './event-bus.js';
import type { NotificationType } from '../types/index.js';

// ── Configuration ──

const FORECAST_HOURS = Number(process.env['PREDICTION_FORECAST_HOURS'] ?? '6');
const LOOKBACK_HOURS = Number(process.env['PREDICTION_LOOKBACK_HOURS'] ?? '24');
const MIN_DATA_POINTS = 6;

/** Alpha: responsiveness to level changes (0–1) */
const ALPHA = 0.3;
/** Beta: responsiveness to trend changes (0–1) */
const BETA = 0.1;

/** Metric thresholds — predicted value at which we alert */
const THRESHOLDS: Record<string, number> = {
  cpu: 90,
  memory: 90,
  swap: 80,
  disk: 90,
};

// ── Types ──

export interface PredictionResult {
  metric: string;
  currentValue: number;
  predictedValue: number;
  hoursAhead: number;
  predictedAt: string; // ISO timestamp
  confidence: number;  // 0–1 based on data quality
  severity: 'info' | 'warning' | 'critical';
  breachesThreshold: boolean;
  threshold: number;
  trend: 'rising' | 'falling' | 'stable';
  trendPerHour: number;
}

// ── Holt's Double Exponential Smoothing ──

interface SmoothedResult {
  level: number;
  trend: number;
  fitted: number[];
}

function holtSmoothing(
  series: number[],
  alpha: number = ALPHA,
  beta: number = BETA,
): SmoothedResult {
  if (series.length < 2) {
    const val = series[0] ?? 0;
    return { level: val, trend: 0, fitted: [val] };
  }

  // Initialize: level = first value, trend = avg diff of first few points
  let level = series[0]!;
  let trend = 0;
  const initLen = Math.min(5, series.length);
  for (let i = 1; i < initLen; i++) {
    trend += (series[i]! - series[i - 1]!) / (initLen - 1);
  }

  const fitted: number[] = [level];

  for (let i = 1; i < series.length; i++) {
    const prevLevel = level;
    const value = series[i]!;

    level = alpha * value + (1 - alpha) * (prevLevel + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    fitted.push(level + trend);
  }

  return { level, trend, fitted };
}

/**
 * Forecast `stepsAhead` periods into the future.
 */
function forecast(smoothed: SmoothedResult, stepsAhead: number): number {
  return Math.max(0, smoothed.level + smoothed.trend * stepsAhead);
}

// ── Metric Extraction from Snapshots ──

interface SnapshotRow {
  timestamp: Date;
  cpuUsagePercent: number;
  memoryPercent: number;
  swapTotalBytes: bigint;
  swapUsedBytes: bigint;
  disks: string;
}

function extractTimeSeries(snapshots: SnapshotRow[], metric: string): number[] {
  return snapshots.map((s) => {
    switch (metric) {
      case 'cpu':
        return s.cpuUsagePercent;
      case 'memory':
        return s.memoryPercent;
      case 'swap': {
        const total = Number(s.swapTotalBytes);
        const used = Number(s.swapUsedBytes);
        return total > 0 ? (used / total) * 100 : 0;
      }
      case 'disk': {
        try {
          const disks = JSON.parse(s.disks) as Array<{ usagePercent?: number }>;
          return Math.max(0, ...disks.map((d) => d.usagePercent ?? 0));
        } catch {
          return 0;
        }
      }
      default:
        return 0;
    }
  });
}

// ── Confidence Scoring ──

function computeConfidence(
  fitted: number[],
  actual: number[],
  dataPoints: number,
): number {
  if (dataPoints < MIN_DATA_POINTS) return 0;

  // Mean absolute percentage error (MAPE)
  let totalError = 0;
  let validCount = 0;
  for (let i = 0; i < fitted.length && i < actual.length; i++) {
    const a = actual[i]!;
    if (a > 0.01) { // Avoid division by near-zero
      totalError += Math.abs((a - fitted[i]!) / a);
      validCount++;
    }
  }
  const mape = validCount > 0 ? totalError / validCount : 1;

  // Convert MAPE to confidence (0–1): low error = high confidence
  // Also scale down for fewer data points
  const dataFactor = Math.min(1, dataPoints / 20); // Full confidence at 20+ points
  const errorFactor = Math.max(0, 1 - mape);

  return Math.round(errorFactor * dataFactor * 100) / 100;
}

// ── Main Prediction Entry Point ──

/**
 * Generate predictions for a node's metrics. Called after each heartbeat.
 */
export async function evaluatePredictions(
  nodeId: string,
  nodeName: string,
): Promise<PredictionResult[]> {
  const db = getDb();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  const snapshots = await db.healthSnapshot.findMany({
    where: { nodeId, timestamp: { gte: since } },
    orderBy: { timestamp: 'asc' },
    select: {
      timestamp: true,
      cpuUsagePercent: true,
      memoryPercent: true,
      swapTotalBytes: true,
      swapUsedBytes: true,
      disks: true,
    },
  });

  if (snapshots.length < MIN_DATA_POINTS) return [];

  // Compute average interval between snapshots (in hours)
  const firstTs = snapshots[0]!.timestamp.getTime();
  const lastTs = snapshots[snapshots.length - 1]!.timestamp.getTime();
  const intervalMs = (lastTs - firstTs) / (snapshots.length - 1);
  const intervalHours = intervalMs / (60 * 60 * 1000);
  if (intervalHours <= 0) return [];

  const stepsAhead = Math.ceil(FORECAST_HOURS / intervalHours);
  const results: PredictionResult[] = [];
  const metrics = ['cpu', 'memory', 'swap', 'disk'];

  for (const metric of metrics) {
    const series = extractTimeSeries(snapshots as SnapshotRow[], metric);
    const current = series[series.length - 1] ?? 0;

    const smoothed = holtSmoothing(series);
    const predicted = forecast(smoothed, stepsAhead);
    const confidence = computeConfidence(smoothed.fitted, series, series.length);
    const threshold = THRESHOLDS[metric] ?? 90;
    const breaches = predicted >= threshold;

    // Determine trend direction
    const trendPerHour = smoothed.trend / intervalHours;
    let trendDir: 'rising' | 'falling' | 'stable' = 'stable';
    if (Math.abs(trendPerHour) > 0.5) {
      trendDir = trendPerHour > 0 ? 'rising' : 'falling';
    }

    // Severity: only if breaching threshold
    let severity: 'info' | 'warning' | 'critical' = 'info';
    if (breaches && confidence >= 0.3) {
      // How far above threshold?
      const excess = predicted - threshold;
      severity = excess > 10 || trendPerHour > 5 ? 'critical' : 'warning';
    }

    const predictedAt = new Date(Date.now() + FORECAST_HOURS * 60 * 60 * 1000);

    results.push({
      metric,
      currentValue: Math.round(current * 100) / 100,
      predictedValue: Math.round(Math.min(predicted, 100) * 100) / 100,
      hoursAhead: FORECAST_HOURS,
      predictedAt: predictedAt.toISOString(),
      confidence,
      severity,
      breachesThreshold: breaches,
      threshold,
      trend: trendDir,
      trendPerHour: Math.round(trendPerHour * 100) / 100,
    });

    // Fire alerts for predicted breaches
    if (breaches && confidence >= 0.3 && (severity === 'warning' || severity === 'critical')) {
      const metricLabel = metric.toUpperCase();
      await createNotification({
        type: `prediction.${metric}` as NotificationType,
        severity,
        title: `Predicted: ${metricLabel} on ${nodeName} will reach ${predicted.toFixed(1)}%`,
        message: `${metricLabel} is predicted to reach ${predicted.toFixed(1)}% within ${FORECAST_HOURS}h (current: ${current.toFixed(1)}%, trend: ${trendPerHour > 0 ? '+' : ''}${trendPerHour.toFixed(2)}%/h, confidence: ${(confidence * 100).toFixed(0)}%).`,
        nodeId,
        nodeName,
        metadata: {
          metric,
          currentValue: current,
          predictedValue: predicted,
          hoursAhead: FORECAST_HOURS,
          confidence,
          trendPerHour,
          threshold,
        },
      });

      await eventBus.publish(EventChannels.ALERT_FIRED, {
        type: 'prediction',
        nodeId,
        nodeName,
        metric,
        currentValue: current,
        predictedValue: predicted,
        hoursAhead: FORECAST_HOURS,
        confidence,
        severity,
      });
    }
  }

  return results;
}

// ── Heartbeat-driven evaluation (throttled) ──

const HEARTBEAT_EVALUATION_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_NODES = 10_000;
const lastHeartbeatEvaluation = new Map<string, number>();

/**
 * Heartbeat entry point. Forecasts look 24h back and ahead, so re-running
 * them on every heartbeat only multiplies snapshot reads; evaluate each node
 * at most once per interval. Returns null when the evaluation was skipped.
 */
export async function evaluatePredictionsForHeartbeat(
  nodeId: string,
  nodeName: string,
  now = Date.now(),
): Promise<PredictionResult[] | null> {
  const last = lastHeartbeatEvaluation.get(nodeId);
  if (last !== undefined && now - last < HEARTBEAT_EVALUATION_INTERVAL_MS) return null;
  if (last === undefined && lastHeartbeatEvaluation.size >= MAX_TRACKED_NODES) {
    for (const [key, at] of lastHeartbeatEvaluation) {
      if (now - at >= HEARTBEAT_EVALUATION_INTERVAL_MS) lastHeartbeatEvaluation.delete(key);
    }
    if (lastHeartbeatEvaluation.size >= MAX_TRACKED_NODES) {
      const oldest = lastHeartbeatEvaluation.keys().next().value;
      if (oldest !== undefined) lastHeartbeatEvaluation.delete(oldest);
    }
  }
  lastHeartbeatEvaluation.delete(nodeId);
  lastHeartbeatEvaluation.set(nodeId, now);
  return evaluatePredictions(nodeId, nodeName);
}

// ── Query Predictions for a Node ──

/**
 * Get current predictions for a node (on-demand, not cached).
 */
export async function getNodePredictions(nodeId: string): Promise<PredictionResult[]> {
  const db = getDb();
  const node = await db.node.findUnique({
    where: { id: nodeId },
    select: { name: true, hostname: true },
  });
  if (!node) return [];
  return evaluatePredictions(nodeId, node.name ?? node.hostname ?? nodeId);
}

/**
 * Get predictions for all nodes (fleet-wide).
 */
export async function getFleetPredictions(): Promise<{
  atRisk: Array<{
    nodeId: string;
    nodeName: string;
    predictions: PredictionResult[];
  }>;
  summary: {
    totalNodes: number;
    nodesAtRisk: number;
    byMetric: Record<string, number>;
  };
}> {
  const db = getDb();
  const nodes = await db.node.findMany({
    where: { status: 'ONLINE' },
    select: { id: true, name: true, hostname: true },
  });

  const atRisk: Array<{
    nodeId: string;
    nodeName: string;
    predictions: PredictionResult[];
  }> = [];

  const byMetric: Record<string, number> = {};

  for (const node of nodes) {
    const name = node.name ?? node.hostname ?? node.id;
    const predictions = await evaluatePredictions(node.id, name);
    const risky = predictions.filter((p) => p.breachesThreshold && p.confidence >= 0.3);

    if (risky.length > 0) {
      atRisk.push({ nodeId: node.id, nodeName: name, predictions: risky });
      for (const p of risky) {
        byMetric[p.metric] = (byMetric[p.metric] ?? 0) + 1;
      }
    }
  }

  // Sort by highest severity first
  atRisk.sort((a, b) => {
    const sevOrder = { critical: 0, warning: 1, info: 2 };
    const aMax = Math.min(...a.predictions.map((p) => sevOrder[p.severity]));
    const bMax = Math.min(...b.predictions.map((p) => sevOrder[p.severity]));
    return aMax - bMax;
  });

  return {
    atRisk,
    summary: {
      totalNodes: nodes.length,
      nodesAtRisk: atRisk.length,
      byMetric,
    },
  };
}
