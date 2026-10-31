import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { createNotificationInTransaction } from './notification-service.js';
import { matchingMaintenance } from './maintenance-service.js';
import { eventBus, EventChannels } from './event-bus.js';

// ─── Alert Service — evaluate health against threshold rules ───

interface HealthMetrics {
  cpuUsagePercent?: number;
  memoryPercent?: number;
  swapUsedBytes?: number;
  swapTotalBytes?: number;
  disks?: Array<{ mountpoint?: string; usagePercent?: number }>;
  gpuFanPercent?: number;
  gpuSampledAt?: Date;
  gpuSampleIsNew?: boolean;
  gpuDevices?: Array<{
    index: number;
    vendor: string;
    uuid: string | null;
    fanPercent: number | null;
  }>;
}

const MAX_OBSERVATION_GAP_MS = 5 * 60 * 1000;

/**
 * Evaluate all active alert rules against a node's health snapshot.
 * Called from the heartbeat route after writing the snapshot.
 */
export async function evaluateHealth(
  nodeId: string,
  nodeName: string,
  metrics: HealthMetrics,
): Promise<void> {
  const db = getDb();

  const rules = await db.alertRule.findMany({ where: { active: true } });
  if (rules.length === 0) return;

  for (const rule of rules) {
    // Check node filter
    if (!matchesNodeFilter(rule.nodeFilter, nodeId, nodeName)) continue;
    if (rule.metric === 'gpu_fan' && !metrics.gpuSampleIsNew) continue;

    const value = extractMetric(rule.metric, metrics);
    if (value === null) {
      if (rule.durationSeconds > 0 && rule.metric !== 'gpu_fan') {
        await clearConditionState(rule.id, nodeId);
      }
      continue;
    }

    const violated = evaluateOperator(value, rule.operator, rule.threshold);

    if (violated) {
      const observedAt = rule.metric === 'gpu_fan'
        ? metrics.gpuSampledAt ?? new Date()
        : new Date();
      if (await hasMetDuration(rule, nodeId, value, observedAt, metrics)) {
        await handleViolation(rule, nodeId, nodeName, value);
      }
    } else {
      if (rule.durationSeconds > 0 && rule.metric !== 'gpu_fan') {
        await clearConditionState(rule.id, nodeId);
      }
      await resolveViolation(rule.id, nodeId);
    }
  }
}

function matchesNodeFilter(filter: string, nodeId: string, nodeName: string): boolean {
  if (filter === '*') return true;

  const parts = filter.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.some((part) =>
    part === nodeId || part === nodeName || nodeName.includes(part),
  );
}

function extractMetric(metric: string, metrics: HealthMetrics): number | null {
  switch (metric) {
    case 'cpu':
      return metrics.cpuUsagePercent ?? null;
    case 'memory':
      return metrics.memoryPercent ?? null;
    case 'swap': {
      const total = Number(metrics.swapTotalBytes ?? 0);
      const used = Number(metrics.swapUsedBytes ?? 0);
      if (total === 0) return 0;
      return (used / total) * 100;
    }
    case 'disk': {
      // Use the highest disk usage across all mountpoints
      const disks = metrics.disks ?? [];
      if (disks.length === 0) return null;
      return Math.max(...disks.map((d) => d.usagePercent ?? 0));
    }
    case 'gpu_fan':
      return metrics.gpuFanPercent ?? null;
    default:
      return null;
  }
}

async function clearConditionState(ruleId: string, nodeId: string): Promise<void> {
  const db = getDb();
  await db.alertConditionState.deleteMany({ where: { ruleId, nodeId } });
}

async function hasMetDuration(
  rule: { id: string; metric: string; operator: string; threshold: number; durationSeconds: number },
  nodeId: string,
  value: number,
  observedAt: Date,
  metrics: HealthMetrics,
): Promise<boolean> {
  if (rule.durationSeconds <= 0) return true;
  if (rule.metric === 'gpu_fan') {
    return hasGpuFanMetDuration(rule, nodeId, observedAt, metrics.gpuDevices ?? []);
  }

  const db = getDb();
  const existing = await db.alertConditionState.findUnique({
    where: { ruleId_nodeId: { ruleId: rule.id, nodeId } },
  });
  const duplicateOrOlderSample = existing && observedAt.getTime() <= existing.lastObservedAt.getTime();
  if (duplicateOrOlderSample) {
    return existing.lastObservedAt.getTime() - existing.breachedAt.getTime() > rule.durationSeconds * 1000;
  }

  const hasGap = existing
    && observedAt.getTime() - existing.lastObservedAt.getTime() > MAX_OBSERVATION_GAP_MS;
  const breachedAt = !existing || hasGap ? observedAt : existing.breachedAt;

  await db.alertConditionState.upsert({
    where: { ruleId_nodeId: { ruleId: rule.id, nodeId } },
    update: { breachedAt, lastObservedAt: observedAt, lastValue: value },
    create: { ruleId: rule.id, nodeId, breachedAt, lastObservedAt: observedAt, lastValue: value },
  });

  return observedAt.getTime() - breachedAt.getTime() > rule.durationSeconds * 1000;
}

function gpuDeviceKey(device: { index: number; vendor: string; uuid: string | null }): string {
  return device.uuid || `${device.vendor}:${device.index}`;
}

async function hasGpuFanMetDuration(
  rule: { operator: string; threshold: number; durationSeconds: number },
  nodeId: string,
  observedAt: Date,
  currentDevices: NonNullable<HealthMetrics['gpuDevices']>,
): Promise<boolean> {
  const candidates = currentDevices.filter((device) =>
    device.fanPercent !== null && evaluateOperator(device.fanPercent, rule.operator, rule.threshold));
  if (candidates.length === 0) return false;

  const windowStart = new Date(observedAt.getTime() - rule.durationSeconds * 1000 - MAX_OBSERVATION_GAP_MS);
  const snapshots = await getDb().gpuSnapshot.findMany({
    where: { nodeId, sampledAt: { gte: windowStart, lte: observedAt } },
    orderBy: { sampledAt: 'desc' },
    select: { sampledAt: true, devices: true },
  });

  return candidates.some((candidate) => {
    const key = gpuDeviceKey(candidate);
    let newestEvidenceAt = observedAt;
    for (const snapshot of snapshots) {
      if (newestEvidenceAt.getTime() - snapshot.sampledAt.getTime() > MAX_OBSERVATION_GAP_MS) return false;
      let devices: NonNullable<HealthMetrics['gpuDevices']> = [];
      try {
        const parsed = JSON.parse(snapshot.devices) as unknown;
        if (Array.isArray(parsed)) devices = parsed as NonNullable<HealthMetrics['gpuDevices']>;
      } catch {
        return false;
      }
      const matching = devices.find((device) => gpuDeviceKey(device) === key);
      if (!matching || matching.fanPercent === null
        || !evaluateOperator(matching.fanPercent, rule.operator, rule.threshold)) return false;
      if (observedAt.getTime() - snapshot.sampledAt.getTime() > rule.durationSeconds * 1000) return true;
      newestEvidenceAt = snapshot.sampledAt;
    }
    return false;
  });
}

function metricLabel(metric: string): string {
  return metric.replaceAll('_', ' ').toUpperCase();
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds % 3600 === 0) return ` for ${seconds / 3600}h`;
  if (seconds % 60 === 0) return ` for ${seconds / 60}m`;
  return ` for ${seconds}s`;
}

function evaluateOperator(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
    default:
      return false;
  }
}

async function handleViolation(
  rule: { id: string; name: string; metric: string; threshold: number; durationSeconds: number; severity: string; cooldownMinutes: number },
  nodeId: string,
  nodeName: string,
  value: number,
): Promise<void> {
  const db = getDb();
  const maintenance = await matchingMaintenance(nodeId);
  const created = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`alert:${rule.id}:${nodeId}`}, 0))`;
    // Check if there's already an active violation for this rule + node.
    const existing = await tx.alertViolation.findFirst({
      where: {
        ruleId: rule.id,
        nodeId,
        status: 'active',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      // Check cooldown — don't create a new notification within the cooldown period.
      const cooldownMs = rule.cooldownMinutes * 60 * 1000;
      if (Date.now() - existing.createdAt.getTime() < cooldownMs) {
        return false; // Within cooldown
      }
    }

    // Create new violation and its notification outbox in one transaction.
    await tx.alertViolation.create({
      data: {
        id: nanoid(),
        ruleId: rule.id,
        nodeId,
        nodeName,
        metric: rule.metric,
        value,
        threshold: rule.threshold,
        severity: rule.severity,
      },
    });

    const label = metricLabel(rule.metric);
    const duration = formatDuration(rule.durationSeconds);
    const severity = rule.severity as 'info' | 'warning' | 'critical';
    await createNotificationInTransaction(tx, {
      type: `alert.${rule.metric}` as 'node.degraded',
      severity,
      title: `${rule.name}: ${label} ${value.toFixed(1)}% on ${nodeName}`,
      message: `Alert rule "${rule.name}" triggered: ${label} is ${value.toFixed(1)}% (threshold: ${rule.threshold}%${duration}) on node ${nodeName}.`,
      nodeId,
      nodeName,
      sourceRef: rule.id,
      metadata: {
        alertRuleId: rule.id,
        metric: rule.metric,
        value,
        threshold: rule.threshold,
        severity: rule.severity,
      },
    }, maintenance?.id ?? null);
    return true;
  });
  if (!created) return;

  void eventBus.publish(EventChannels.ALERT_FIRED, {
    type: 'health.alert', nodeId, nodeName, metric: rule.metric,
    value, threshold: rule.threshold, severity: rule.severity,
    timestamp: new Date().toISOString(), source: 'control-api',
  });
}

async function resolveViolation(ruleId: string, nodeId: string): Promise<void> {
  const db = getDb();

  await db.alertViolation.updateMany({
    where: { ruleId, nodeId, status: 'active' },
    data: { status: 'resolved', resolvedAt: new Date() },
  });
}

// ─── CRUD helpers ───

export async function listAlertRules(): Promise<unknown[]> {
  const db = getDb();
  return db.alertRule.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { violations: true } } },
  });
}

export async function getAlertRule(id: string): Promise<unknown> {
  const db = getDb();
  return db.alertRule.findUnique({
    where: { id },
    include: {
      _count: { select: { violations: true } },
      violations: {
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });
}

export async function createAlertRule(data: {
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  durationSeconds?: number;
  severity?: string;
  nodeFilter?: string;
  cooldownMinutes?: number;
  createdBy?: string;
}): Promise<unknown> {
  const db = getDb();
  return db.alertRule.create({
    data: {
      id: nanoid(),
      name: data.name,
      metric: data.metric,
      operator: data.operator,
      threshold: data.threshold,
      durationSeconds: data.durationSeconds ?? 0,
      severity: data.severity ?? 'warning',
      nodeFilter: data.nodeFilter ?? '*',
      cooldownMinutes: data.cooldownMinutes ?? 15,
      createdBy: data.createdBy ?? null,
    },
  });
}

export async function updateAlertRule(
  id: string,
  data: Partial<{
    name: string;
    metric: string;
    operator: string;
    threshold: number;
    durationSeconds: number;
    severity: string;
    nodeFilter: string;
    active: boolean;
    cooldownMinutes: number;
  }>,
): Promise<unknown> {
  const db = getDb();
  return db.alertRule.update({ where: { id }, data });
}

export async function deleteAlertRule(id: string): Promise<void> {
  const db = getDb();
  await db.alertRule.delete({ where: { id } });
}

export async function listAlertViolations(params: {
  ruleId?: string;
  nodeId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ violations: unknown[]; total: number }> {
  const db = getDb();
  const page = params.page ?? 1;
  const pageSize = Math.min(params.pageSize ?? 50, 100);
  const skip = (page - 1) * pageSize;

  const where: Record<string, unknown> = {};
  if (params.ruleId) where['ruleId'] = params.ruleId;
  if (params.nodeId) where['nodeId'] = params.nodeId;
  if (params.status) where['status'] = params.status;

  const [violations, total] = await Promise.all([
    db.alertViolation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      include: { rule: { select: { name: true } } },
    }),
    db.alertViolation.count({ where }),
  ]);

  return { violations, total };
}
