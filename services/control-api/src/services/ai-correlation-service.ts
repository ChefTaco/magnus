/**
 * ai-correlation-service.ts — Cross-fleet anomaly correlation engine.
 *
 * Groups anomalies by time proximity, identifies fleet-wide patterns,
 * and correlates anomalies with recent commands/events.
 */

import { getDb } from '../db/index.js';

export interface CorrelatedGroup {
  id: string;
  timeWindow: { start: string; end: string };
  anomalies: Array<{
    id: string;
    nodeId: string;
    metric: string;
    value: number;
    severity: string;
    zScore: number;
    createdAt: string;
  }>;
  affectedNodes: string[];
  metrics: string[];
  pattern: string; // Description of the pattern
  relatedCommands: Array<{
    id: string;
    nodeId: string;
    command: string;
    status: string;
    createdAt: string;
  }>;
}

export interface AnomalyCorrelationDetails {
  anomaly: {
    id: string;
    nodeId: string;
    metric: string;
    value: number;
    severity: string;
    zScore: number;
    createdAt: string;
    resolved: boolean;
  };
  group: CorrelatedGroup;
  analysis: {
    blastRadius: 'single-node' | 'multi-node';
    suspectedTriggers: string[];
    recommendedActions: string[];
    summary: string;
  };
}

/**
 * Correlate active anomalies by grouping them within time windows (±5 minutes).
 * Also fetches related commands executed around the same time.
 */
export async function correlateAnomalies(options?: {
  windowMinutes?: number;
  includeResolved?: boolean;
}): Promise<CorrelatedGroup[]> {
  const db = getDb();
  const windowMs = (options?.windowMinutes ?? 5) * 60 * 1000;

  const anomalies = await db.anomalyEvent.findMany({
    where: options?.includeResolved ? {} : { resolved: false },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  if (anomalies.length === 0) return [];

  // Group anomalies into time-based clusters
  const groups: CorrelatedGroup[] = [];
  let currentGroup: typeof anomalies = [anomalies[0]!];

  for (let i = 1; i < anomalies.length; i++) {
    const prev = currentGroup[currentGroup.length - 1]!;
    const curr = anomalies[i]!;

    if (curr.createdAt.getTime() - prev.createdAt.getTime() <= windowMs) {
      currentGroup.push(curr);
    } else {
      if (currentGroup.length > 0) {
        groups.push(await buildGroup(db, currentGroup, groups.length));
      }
      currentGroup = [curr];
    }
  }

  // Don't forget the last group
  if (currentGroup.length > 0) {
    groups.push(await buildGroup(db, currentGroup, groups.length));
  }

  return groups;
}

export async function getAnomalyTimeline(options?: {
  hours?: number;
  nodeId?: string;
}): Promise<Record<string, unknown>> {
  const db = getDb();
  const hours = Math.min(Math.max(options?.hours ?? 24, 1), 24 * 30);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const anomalyWhere: Record<string, unknown> = { createdAt: { gte: since } };
  const healthWhere: Record<string, unknown> = { timestamp: { gte: since } };
  if (options?.nodeId) {
    anomalyWhere['nodeId'] = options.nodeId;
    healthWhere['nodeId'] = options.nodeId;
  }

  const [anomalies, healthSnapshots] = await Promise.all([
    db.anomalyEvent.findMany({
      where: anomalyWhere,
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true,
        nodeId: true,
        metric: true,
        value: true,
        severity: true,
        zScore: true,
        resolved: true,
        createdAt: true,
      },
    }),
    db.healthSnapshot.findMany({
      where: healthWhere,
      orderBy: { timestamp: 'asc' },
      take: 200,
      select: {
        nodeId: true,
        timestamp: true,
        cpuUsagePercent: true,
        memoryPercent: true,
      },
    }),
  ]);

  return {
    timeRange: { start: since.toISOString(), end: new Date().toISOString() },
    anomalyCount: anomalies.length,
    anomalies: anomalies.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    healthContext: healthSnapshots.map((item) => ({
      nodeId: item.nodeId,
      timestamp: item.timestamp.toISOString(),
      cpu: item.cpuUsagePercent,
      memory: item.memoryPercent,
    })),
  };
}

async function buildGroup(
  db: ReturnType<typeof getDb>,
  anomalies: Array<{
    id: string;
    nodeId: string;
    metric: string;
    value: number;
    severity: string;
    zScore: number;
    mean: number;
    stdDev: number;
    resolved: boolean;
    createdAt: Date;
  }>,
  index: number,
): Promise<CorrelatedGroup> {
  const start = anomalies[0]!.createdAt;
  const end = anomalies[anomalies.length - 1]!.createdAt;
  const affectedNodes = [...new Set(anomalies.map(a => a.nodeId))];
  const metrics = [...new Set(anomalies.map(a => a.metric))];

  // Find commands executed within ±30 minutes of the anomaly window
  const windowStart = new Date(start.getTime() - 30 * 60 * 1000);
  const windowEnd = new Date(end.getTime() + 30 * 60 * 1000);

  const relatedCommands = await db.remoteCommand.findMany({
    where: {
      nodeId: { in: affectedNodes },
      createdAt: { gte: windowStart, lte: windowEnd },
    },
    select: { id: true, nodeId: true, command: true, status: true, createdAt: true },
    take: 20,
    orderBy: { createdAt: 'desc' },
  });

  // Generate pattern description
  let pattern: string;
  if (affectedNodes.length > 1 && metrics.length === 1) {
    pattern = `Fleet-wide ${metrics[0]} anomaly across ${affectedNodes.length} nodes`;
  } else if (affectedNodes.length === 1 && metrics.length > 1) {
    pattern = `Multi-metric anomaly on single node (${metrics.join(', ')})`;
  } else if (affectedNodes.length > 1 && metrics.length > 1) {
    pattern = `Correlated multi-metric anomaly across ${affectedNodes.length} nodes`;
  } else {
    pattern = `Isolated ${metrics[0] ?? 'unknown'} anomaly`;
  }

  return {
    id: `corr-${index}`,
    timeWindow: { start: start.toISOString(), end: end.toISOString() },
    anomalies: anomalies.map(a => ({
      id: a.id,
      nodeId: a.nodeId,
      metric: a.metric,
      value: a.value,
      severity: a.severity,
      zScore: a.zScore,
      createdAt: a.createdAt.toISOString(),
    })),
    affectedNodes,
    metrics,
    pattern,
    relatedCommands: relatedCommands.map(c => ({
      id: c.id,
      nodeId: c.nodeId,
      command: c.command,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

/**
 * Get a concise summary of current anomaly correlations.
 */
export async function getCorrelationSummary(): Promise<{
  totalGroups: number;
  fleetWidePatterns: number;
  affectedNodes: number;
  criticalGroups: number;
  summary: string;
}> {
  const groups = await correlateAnomalies();
  const fleetWide = groups.filter(g => g.affectedNodes.length > 1);
  const allAffected = new Set(groups.flatMap(g => g.affectedNodes));
  const critical = groups.filter(g =>
    g.anomalies.some(a => a.severity === 'critical'),
  );

  const parts: string[] = [];
  if (groups.length === 0) {
    parts.push('No active anomaly correlations detected.');
  } else {
    parts.push(`${groups.length} anomaly group(s) detected.`);
    if (fleetWide.length > 0) {
      parts.push(`${fleetWide.length} fleet-wide pattern(s) affecting multiple nodes.`);
    }
    if (critical.length > 0) {
      parts.push(`${critical.length} group(s) contain critical-severity anomalies.`);
    }
  }

  return {
    totalGroups: groups.length,
    fleetWidePatterns: fleetWide.length,
    affectedNodes: allAffected.size,
    criticalGroups: critical.length,
    summary: parts.join(' '),
  };
}

export async function getAnomalyCorrelationDetails(anomalyId: string): Promise<AnomalyCorrelationDetails | null> {
  const db = getDb();
  const anomaly = await db.anomalyEvent.findUnique({ where: { id: anomalyId } });
  if (!anomaly) return null;

  const groups = await correlateAnomalies({ windowMinutes: 10, includeResolved: true });
  let group = groups.find((candidate) => candidate.anomalies.some((entry) => entry.id === anomalyId)) ?? null;

  if (!group) {
    group = await buildGroup(db, [anomaly], 0);
  }

  const suspectedTriggers = group.relatedCommands.length > 0
    ? group.relatedCommands.slice(0, 3).map((command) => command.command)
    : ['No nearby command activity detected'];

  const recommendedActions = [
    group.metrics.some((metric) => metric.includes('disk')) ? 'Inspect disk usage growth and recent package/file operations.' : null,
    group.metrics.some((metric) => metric.includes('cpu')) ? 'Check recent process spikes, deploys, or runaway services.' : null,
    group.metrics.some((metric) => metric.includes('memory')) ? 'Review top memory consumers and restart leaky services if needed.' : null,
    group.metrics.some((metric) => metric.includes('network')) ? 'Validate upstream dependencies, routing, and packet loss on affected nodes.' : null,
    group.relatedCommands.length === 0 ? 'Correlate with external incidents or scheduled jobs outside Magnus command history.' : null,
  ].filter((item): item is string => Boolean(item));

  if (recommendedActions.length === 0) {
    recommendedActions.push('Review node health history and recent configuration changes for the affected systems.');
  }

  const blastRadius = group.affectedNodes.length > 1 ? 'multi-node' : 'single-node';
  const summary = blastRadius === 'multi-node'
    ? `${group.pattern}. ${group.anomalies.length} anomalies were detected across ${group.affectedNodes.length} nodes in the same time window.`
    : `${group.pattern}. The issue currently appears isolated to a single node, but it still correlates with ${group.relatedCommands.length} nearby command event(s).`;

  return {
    anomaly: {
      id: anomaly.id,
      nodeId: anomaly.nodeId,
      metric: anomaly.metric,
      value: anomaly.value,
      severity: anomaly.severity,
      zScore: anomaly.zScore,
      createdAt: anomaly.createdAt.toISOString(),
      resolved: anomaly.resolved,
    },
    group,
    analysis: {
      blastRadius,
      suspectedTriggers,
      recommendedActions,
      summary,
    },
  };
}
