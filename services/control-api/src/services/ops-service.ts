import { statfs } from 'node:fs/promises';
import { getDb } from '../db/index.js';
import { getRedis } from '../queue/redis.js';
import { withReadRetry } from '../db/read-retry.js';
import { API_SECRET, IAM_CORE_URL, getNodeManagerSecret, getValidatedEnv } from '../utils/env.js';
import { secretFingerprint } from './credential-rotation-service.js';
import { queryAuditEvents } from './audit-service.js';
import { getRateLimitHealth } from '../middleware/rate-limit.js';
import { listHermesInstallations } from './hermes-service.js';
import { getHealthRetentionCutoffs, getHealthRetentionPolicy, getRetentionPolicyReadiness } from './health-retention.js';
import { getNotificationRetentionPolicy } from './notification-retention.js';

const STALE_THRESHOLD_MS = Number(process.env['STALE_NODE_THRESHOLD_MS'] ?? 120_000);

export interface DependencyHealthItem {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  message: string;
  latencyMs?: number;
}

/**
 * The readiness screen only needs one small health projection per node.  Do
 * not load `healthSnapshots` as a Prisma relation here: the bounded SQL query
 * avoids hydrating retained history before applying `take: 1`.
 */
interface LatestReadinessHealthSnapshot {
  nodeId: string;
  timestamp: Date;
  cpuUsagePercent: number;
  memoryPercent: number;
  disks: string;
}

function fingerprint(value: string): string | null {
  if (!value) return null;
  return secretFingerprint(value);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; latencyMs: number; error?: string }> {
  const started = performance.now();
  try {
    const value = await fn();
    return { value, latencyMs: Math.round((performance.now() - started) * 100) / 100 };
  } catch (err) {
    return {
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function describeDependencyError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === 'object') {
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
    const message = 'message' in cause && typeof cause.message === 'string' ? cause.message : undefined;
    if (code && message) return `${error.message} (${code}: ${message})`;
    if (code) return `${error.message} (${code})`;
    if (message) return `${error.message} (${message})`;
  }
  return error.message;
}

export function resolveRouterHealthUrl(routerUrl: string | undefined, explicitHealthUrl?: string): string | undefined {
  if (explicitHealthUrl) return explicitHealthUrl;
  if (!routerUrl) return undefined;
  const healthUrl = new URL(routerUrl);
  healthUrl.pathname = '/health';
  healthUrl.search = '';
  healthUrl.hash = '';
  return healthUrl.toString();
}

export async function checkHttp(name: string, url: string | undefined, timeoutMs = 2500): Promise<DependencyHealthItem> {
  if (!url) return { name, status: 'skip', message: 'not configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let status: number;
  try {
    const res = await fetch(url, { signal: controller.signal });
    status = res.status;
  } catch (error) {
    return {
      name,
      status: 'warn',
      message: describeDependencyError(error),
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
    };
  } finally {
    clearTimeout(timer);
  }
  return {
    name,
    status: status >= 200 && status < 300 ? 'pass' : 'warn',
    message: `HTTP ${status}`,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

export async function getDependencyHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: DependencyHealthItem[];
  generatedAt: string;
}> {
  const db = getDb();
  const env = getValidatedEnv();
  const checks: DependencyHealthItem[] = [];

  const dbResult = await timed(async () => db.$queryRaw`SELECT 1`);
  checks.push({
    name: 'postgres',
    status: dbResult.error ? 'fail' : 'pass',
    message: dbResult.error ?? 'connected',
    latencyMs: dbResult.latencyMs,
  });

  const redisResult = await timed(async () => getRedis().ping());
  checks.push({
    name: 'redis',
    status: redisResult.error ? 'warn' : 'pass',
    message: redisResult.error ?? `pong: ${redisResult.value}`,
    latencyMs: redisResult.latencyMs,
  });

  const fsResult = await timed(async () => statfs(process.env['DATABASE_DIR'] ?? process.cwd()));
  checks.push({
    name: 'filesystem',
    status: fsResult.error ? 'fail' : 'pass',
    message: fsResult.error ?? 'writable path stat available',
    latencyMs: fsResult.latencyMs,
  });

  checks.push(await checkHttp(
    'hive-router',
    resolveRouterHealthUrl(env.MAGNUS_ROUTER_URL ?? env.HIVE_ROUTER_URL, env.HIVE_ROUTER_HEALTH_URL),
  ));
  checks.push(await checkHttp(
    'hivemem',
    env.HIVEMEM_URL ? `${env.HIVEMEM_URL.replace(/\/+$/, '')}/health` : undefined,
  ));
  checks.push(await checkHttp(
    'hive-iam-verifier',
    IAM_CORE_URL ? `${IAM_CORE_URL.replace(/\/+$/, '')}/api/v1/auth/public-key` : undefined,
  ));

  const hermesResult = await timed(async () => db.hermesInstallation.count());
  checks.push({
    name: 'hermes-inventory',
    status: hermesResult.error ? 'warn' : 'pass',
    message: hermesResult.error ?? `${hermesResult.value ?? 0} installation records`,
    latencyMs: hermesResult.latencyMs,
  });

  const queueResult = await timed(async () => getRedis().llen('bull:magnus:commands:wait'));
  checks.push({
    name: 'command-queue',
    status: queueResult.error ? 'warn' : 'pass',
    message: queueResult.error ?? `${queueResult.value ?? 0} waiting`,
    latencyMs: queueResult.latencyMs,
  });

  const rateLimit = getRateLimitHealth();
  checks.push({
    name: 'rate-limiter',
    status: rateLimit.status,
    message: rateLimit.lastErrorAt ? `${rateLimit.message} at ${rateLimit.lastErrorAt}` : rateLimit.message,
  });

  const retentionPolicy = getRetentionPolicyReadiness();
  checks.push({
    name: 'retention-policy',
    status: retentionPolicy.status,
    message: retentionPolicy.message,
  });

  const failCount = checks.filter((check) => check.status === 'fail').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;
  const status = failCount > 0 ? 'unhealthy' : warnCount > 0 ? 'degraded' : 'healthy';

  return { status, checks, generatedAt: new Date().toISOString() };
}

export async function getFleetReadiness(): Promise<{
  generatedAt: string;
  thresholds: { staleNodeMs: number };
  expectedFingerprints: { nodeManagerSecret: string | null; apiSecret: string | null };
  nodes: Array<Record<string, unknown>>;
}> {
  const db = getDb();
  const [nodes, latestHealthSnapshots] = await withReadRetry('fleet readiness', () => Promise.all([
    db.node.findMany({
      orderBy: { name: 'asc' },
      include: {
        agent: true,
        hermesInstallations: { orderBy: { updatedAt: 'desc' }, take: 1 },
        role: { select: { name: true } },
      },
    }),
    db.$queryRaw<LatestReadinessHealthSnapshot[]>`
      SELECT snapshot."nodeId", snapshot."timestamp", snapshot."cpuUsagePercent", snapshot."memoryPercent", snapshot."disks"
      FROM "nodes" AS node
      INNER JOIN "health_snapshots" AS snapshot ON snapshot."id" = (
        SELECT candidate."id"
        FROM "health_snapshots" AS candidate
        WHERE candidate."nodeId" = node."id"
        ORDER BY candidate."timestamp" DESC
        LIMIT 1
      )
    `,
  ]));
  const healthByNodeId = new Map(latestHealthSnapshots.map((snapshot) => [snapshot.nodeId, snapshot]));

  const now = Date.now();
  return {
    generatedAt: new Date().toISOString(),
    thresholds: { staleNodeMs: STALE_THRESHOLD_MS },
    expectedFingerprints: {
      nodeManagerSecret: fingerprint(getNodeManagerSecret()),
      apiSecret: fingerprint(API_SECRET),
    },
    nodes: nodes.map((node) => {
      const heartbeatAgeMs = node.lastHeartbeatAt ? now - node.lastHeartbeatAt.getTime() : null;
      const stale = heartbeatAgeMs === null || heartbeatAgeMs > STALE_THRESHOLD_MS;
      const health = healthByNodeId.get(node.id) ?? null;
      const hermes = node.hermesInstallations[0] ?? null;
      const diskWarnings = health ? parseDiskWarnings(health.disks) : [];
      const metadata = parseMetadata(node.metadata);
      const observedNodeManagerSecret = typeof metadata['nodeManagerSecretFingerprint'] === 'string'
        ? metadata['nodeManagerSecretFingerprint']
        : null;
      const expectedNodeManagerSecret = fingerprint(getNodeManagerSecret());
      return {
        id: node.id,
        name: node.name,
        hostname: node.hostname,
        ipAddress: node.ipAddress,
        status: node.status,
        operationalStatus: stale ? 'STALE' : node.status,
        role: node.role?.name ?? null,
        agentVersion: node.agent?.version ?? null,
        agentStatus: node.agent?.status ?? null,
        nodeVersion: metadata['nodeVersion'] ?? null,
        os: node.os,
        arch: node.arch,
        lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
        heartbeatAgeMs,
        stale,
        deployEligible: !stale && ['ONLINE', 'DEGRADED', 'OFFLINE'].includes(node.status),
        destructiveActionsBlocked: stale,
        health: health ? {
          timestamp: health.timestamp.toISOString(),
          cpuUsagePercent: health.cpuUsagePercent,
          memoryPercent: health.memoryPercent,
          diskWarnings,
        } : null,
        hermes: hermes ? {
          status: hermes.status,
          version: hermes.version,
          gatewayStatus: hermes.gatewayStatus,
          lastDetectedAt: hermes.lastDetectedAt?.toISOString() ?? null,
        } : null,
        secretFingerprint: {
          expectedNodeManagerSecret,
          observedNodeManagerSecret,
          match: observedNodeManagerSecret === null ? 'unknown' : observedNodeManagerSecret === expectedNodeManagerSecret ? 'match' : 'mismatch',
        },
      };
    }),
  };
}

function parseMetadata(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

function parseDiskWarnings(raw: string): Array<{ mountPoint: string; usagePercent: number }> {
  try {
    const disks = JSON.parse(raw) as Array<{ mountPoint: string; usagePercent: number }>;
    return disks
      .filter((disk) => Number(disk.usagePercent) >= 85)
      .map((disk) => ({ mountPoint: disk.mountPoint, usagePercent: disk.usagePercent }));
  } catch {
    return [];
  }
}

export async function getFleetTimeline(limit = 80): Promise<Array<Record<string, unknown>>> {
  const db = getDb();
  const [notifications, commands, deployJobs, hermesJobs, logs, audit] = await withReadRetry(
    'fleet timeline',
    async () => Promise.all([
      db.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 25 }),
      db.remoteCommand.findMany({ orderBy: { createdAt: 'desc' }, take: 25, include: { node: { select: { name: true, hostname: true } } } }),
      db.deployJob.findMany({ orderBy: { startedAt: 'desc' }, take: 15 }),
      db.hermesOperationJob.findMany({ orderBy: { startedAt: 'desc' }, take: 15 }),
      db.logEntry.findMany({ orderBy: { timestamp: 'desc' }, take: 25, include: { node: { select: { name: true, hostname: true } } } }),
      queryAuditEvents({ pageSize: 20 }),
    ]),
  );

  const items: Array<Record<string, unknown>> = [
    ...notifications.map((item) => ({
      type: 'notification', severity: item.severity, title: item.title, node: item.nodeName,
      timestamp: item.createdAt.toISOString(), href: '/notifications',
    })),
    ...commands.map((item) => ({
      type: 'command', severity: item.status === 'FAILED' ? 'warning' : 'info',
      title: `${item.command} ${item.status.toLowerCase()}`, node: item.node.name,
      timestamp: item.createdAt.toISOString(), href: `/commands?commandId=${item.id}`,
    })),
    ...deployJobs.map((item) => ({
      type: 'deploy', severity: item.status === 'completed' ? 'info' : 'warning',
      title: `${item.type} ${item.status}`, timestamp: item.startedAt.toISOString(), href: '/governor/operations',
    })),
    ...hermesJobs.map((item) => ({
      type: 'hermes', severity: item.status === 'failed' ? 'warning' : 'info',
      title: `${item.type} ${item.status}`, node: item.targetHost,
      timestamp: item.startedAt.toISOString(), href: '/orchestra/installations',
    })),
    ...logs.map((item) => ({
      type: 'log', severity: item.level, title: item.message, node: item.node.name,
      timestamp: item.timestamp.toISOString(), href: '/logs',
    })),
    ...audit.events.map((item) => ({
      type: 'audit', severity: 'info', title: item.action, node: item.targetType,
      timestamp: item.timestamp, href: '/audit',
    })),
  ];

  return items
    .sort((a, b) => String(b['timestamp']).localeCompare(String(a['timestamp'])))
    .slice(0, limit);
}

export async function getRetentionSummary(): Promise<Record<string, unknown>> {
  const db = getDb();
  const generatedAt = new Date();
  const healthPolicy = getHealthRetentionPolicy();
  const healthCutoffs = getHealthRetentionCutoffs(generatedAt, healthPolicy);
  const recoveryExerciseRetentionDays = getValidatedEnv().ENGINEERING_EXERCISE_RETENTION_DAYS;
  const recoveryExerciseCutoff = new Date(generatedAt.getTime() - recoveryExerciseRetentionDays * 86_400_000);
  const notificationPolicy = getNotificationRetentionPolicy();
  const notificationReadCutoff = new Date(generatedAt.getTime() - notificationPolicy.readDays * 86_400_000);
  const notificationMaximumCutoff = new Date(generatedAt.getTime() - notificationPolicy.maximumDays * 86_400_000);
  const [health, gpu, engineeringMetrics, recoveryExercises, logs, notifications, securityEvents, commands, deploys, hermesJobs,
    oldestHealth, oldestGpu, oldestEngineeringMetric, oldestRecoveryExercise, oldestLog, oldestNotification, oldestSecurityEvent] = await withReadRetry(
    'retention summary',
    async () => Promise.all([
      db.healthSnapshot.count(),
      db.gpuSnapshot.count(),
      db.engineeringMetricSample.count(),
      db.engineeringRecoveryExercise.count(),
      db.logEntry.count(),
      db.notification.count(),
      db.securityFusionEvent.count(),
      db.remoteCommand.count(),
      db.deployJob.count(),
      db.hermesOperationJob.count(),
      db.healthSnapshot.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } }),
      db.gpuSnapshot.findFirst({ orderBy: { sampledAt: 'asc' }, select: { sampledAt: true } }),
      db.engineeringMetricSample.findFirst({ orderBy: { observedAt: 'asc' }, select: { observedAt: true } }),
      db.engineeringRecoveryExercise.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      db.logEntry.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } }),
      db.notification.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      db.securityFusionEvent.findFirst({ orderBy: { observedAt: 'asc' }, select: { observedAt: true } }),
    ]),
  );
  return {
    generatedAt: generatedAt.toISOString(),
    policyStatus: getRetentionPolicyReadiness(),
    tables: [
      { name: 'HealthSnapshot', count: health, oldestAt: oldestHealth?.timestamp.toISOString() ?? null, policy: `${healthPolicy.fullFidelityHours}h full; ${healthPolicy.sampleMinutes}m anomaly/extrema samples for ${healthPolicy.retentionDays}d`, cutoffs: { fullFidelityAfter: healthCutoffs.fullFidelityAfter.toISOString(), expiresBefore: healthCutoffs.expiresBefore.toISOString() } },
      { name: 'GpuSnapshot', count: gpu, oldestAt: oldestGpu?.sampledAt.toISOString() ?? null, policy: `30s samples for ${healthPolicy.retentionDays}d`, cutoffs: { expiresBefore: healthCutoffs.expiresBefore.toISOString() } },
      { name: 'EngineeringMetricSample', count: engineeringMetrics, oldestAt: oldestEngineeringMetric?.observedAt.toISOString() ?? null,
        policy: `${healthPolicy.fullFidelityHours}h full; ${healthPolicy.sampleMinutes}m last/min/max samples for ${healthPolicy.retentionDays}d`,
        cutoffs: { fullFidelityAfter: healthCutoffs.fullFidelityAfter.toISOString(), expiresBefore: healthCutoffs.expiresBefore.toISOString() } },
      { name: 'EngineeringRecoveryExercise', count: recoveryExercises, oldestAt: oldestRecoveryExercise?.createdAt.toISOString() ?? null,
        policy: `immutable records for ${recoveryExerciseRetentionDays}d`,
        cutoffs: { expiresBefore: recoveryExerciseCutoff.toISOString() } },
      { name: 'LogEntry', count: logs, oldestAt: oldestLog?.timestamp.toISOString() ?? null, policy: `${process.env['LOG_RETENTION_DAYS'] ?? 30} days` },
      { name: 'Notification', count: notifications, oldestAt: oldestNotification?.createdAt.toISOString() ?? null, policy: `read ${notificationPolicy.readDays}d; maximum ${notificationPolicy.maximumDays}d`, cutoffs: { readBefore: notificationReadCutoff.toISOString(), expiresBefore: notificationMaximumCutoff.toISOString() } },
      { name: 'SecurityFusionEvent', count: securityEvents, oldestAt: oldestSecurityEvent?.observedAt.toISOString() ?? null, policy: '90 days; linked evidence preserved by case policy' },
      { name: 'RemoteCommand', count: commands, oldestAt: null, policy: 'manual review' },
      { name: 'DeployJob', count: deploys, oldestAt: null, policy: 'manual review' },
      { name: 'HermesOperationJob', count: hermesJobs, oldestAt: null, policy: 'manual review' },
    ],
  };
}

export async function getTraceDependencyMap(): Promise<Record<string, unknown>> {
  const health = await getDependencyHealth();
  return {
    generatedAt: new Date().toISOString(),
    observedEdges: [
      { from: 'dashboard', to: 'control-api', source: 'configured proxy/fleetFetch' },
      { from: 'control-api', to: 'postgres', status: health.checks.find((c) => c.name === 'postgres')?.status },
      { from: 'control-api', to: 'redis', status: health.checks.find((c) => c.name === 'redis')?.status },
      { from: 'control-api', to: 'hive-router', status: health.checks.find((c) => c.name === 'hive-router')?.status },
      { from: 'control-api', to: 'hivemem', status: health.checks.find((c) => c.name === 'hivemem')?.status },
      { from: 'control-api', to: 'hive-iam', status: health.checks.find((c) => c.name === 'hive-iam-verifier')?.status },
      { from: 'agent', to: 'hermes-cli', source: 'node-local reconciliation' },
    ],
    notes: [
      'Traceparent headers are propagated today; full collector export can populate this map with observed spans.',
    ],
  };
}

export async function getPredictiveMaintenance(): Promise<Record<string, unknown>> {
  const readiness = await getFleetReadiness();
  return {
    generatedAt: new Date().toISOString(),
    nodes: readiness.nodes.map((node) => {
      const health = node['health'] as { memoryPercent?: number; diskWarnings?: unknown[] } | null;
      const stale = Boolean(node['stale']);
      const risks: string[] = [];
      if (stale) risks.push('heartbeat stale');
      if ((health?.memoryPercent ?? 0) >= 85) risks.push('memory pressure');
      if ((health?.diskWarnings ?? []).length > 0) risks.push('disk pressure');
      return {
        id: node['id'],
        name: node['name'],
        risk: risks.length === 0 ? 'low' : risks.length === 1 ? 'medium' : 'high',
        risks,
      };
    }),
  };
}

export async function getIncidentSummary(nodeId?: string, hours = 24): Promise<Record<string, unknown>> {
  const db = getDb();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [node, commands, logs, anomalies, notifications] = await withReadRetry('incident summary', async () => Promise.all([
    nodeId ? db.node.findUnique({ where: { id: nodeId }, select: { id: true, name: true, hostname: true, status: true, lastHeartbeatAt: true } }) : null,
    db.remoteCommand.findMany({
      where: { ...(nodeId ? { nodeId } : {}), createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    db.logEntry.findMany({
      where: { ...(nodeId ? { nodeId } : {}), timestamp: { gte: since }, level: { in: ['warn', 'error'] } },
      orderBy: { timestamp: 'desc' },
      take: 30,
    }),
    db.anomalyEvent.findMany({
      where: { ...(nodeId ? { nodeId } : {}), createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    db.notification.findMany({
      where: { ...(nodeId ? { nodeId } : {}), createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]));

  const likelyCauses = [
    ...(notifications.some((item) => item.type === 'node.offline') ? ['heartbeat outage or agent/control connectivity issue'] : []),
    ...(commands.some((item) => ['FAILED', 'TIMEOUT'].includes(item.status)) ? ['recent failed command or timeout'] : []),
    ...(anomalies.length > 0 ? ['health anomaly detected before or during incident window'] : []),
    ...(logs.some((item) => item.level === 'error') ? ['error-level service logs in incident window'] : []),
  ];

  return {
    generatedAt: new Date().toISOString(),
    node,
    windowHours: hours,
    likelyCauses: likelyCauses.length > 0 ? likelyCauses : ['no strong cause detected from current artifacts'],
    blastRadius: nodeId ? 'single-node scope requested' : 'fleet-wide scope requested',
    artifacts: {
      commands: commands.map((item) => ({ id: item.id, status: item.status, command: item.command, createdAt: item.createdAt.toISOString() })),
      logs: logs.map((item) => ({ id: item.id, level: item.level, source: item.source, message: item.message, timestamp: item.timestamp.toISOString() })),
      anomalies: anomalies.map((item) => ({ id: item.id, metric: item.metric, severity: item.severity, value: item.value, createdAt: item.createdAt.toISOString() })),
      notifications: notifications.map((item) => ({ id: item.id, type: item.type, severity: item.severity, title: item.title, createdAt: item.createdAt.toISOString() })),
    },
  };
}

export function classifyRemediationPlan(description: string): Record<string, unknown> {
  const text = description.toLowerCase();
  const destructive = /\b(rm\s+-rf|delete|format|reboot|shutdown|drop|wipe|purge)\b/.test(text);
  const risky = destructive || /\b(sudo|systemctl|deploy|upgrade|dist-upgrade|chmod|chown|firewall|ufw)\b/.test(text);
  const reversible = !destructive && /\b(restart|backup|copy|rollback|revert|restore)\b/.test(text);
  const level = destructive ? 'destructive' : risky ? 'risky' : reversible ? 'reversible' : 'observe-only';
  return {
    level,
    confidence: destructive || risky ? 0.82 : 0.68,
    requiresConfirmation: level === 'risky' || level === 'destructive',
    reasons: [
      ...(destructive ? ['destructive keyword detected'] : []),
      ...(risky && !destructive ? ['privileged or state-changing operation detected'] : []),
      ...(reversible ? ['rollback or backup language detected'] : []),
    ],
  };
}

export async function getHermesEffectiveState(): Promise<Record<string, unknown>> {
  const db = getDb();
  const [installations, assignments] = await withReadRetry('hermes effective state', async () => Promise.all([
    listHermesInstallations(),
    db.hermesSkillAssignment.findMany({ orderBy: { updatedAt: 'desc' } }),
  ]));
  const byInstallation = new Map<string, typeof assignments>();
  for (const assignment of assignments) {
    const current = byInstallation.get(assignment.installationId) ?? [];
    current.push(assignment);
    byInstallation.set(assignment.installationId, current);
  }
  return {
    generatedAt: new Date().toISOString(),
    installations: installations.map((installation) => {
      const desired = byInstallation.get(installation.id) ?? [];
      const applied = desired.filter((assignment) => assignment.status === 'applied' && assignment.enabled);
      const drifted = desired.filter((assignment) => assignment.status === 'drifted' || assignment.status === 'error');
      return {
        id: installation.id,
        hostname: installation.hostname,
        status: installation.status,
        profiles: installation.profiles?.length ?? 0,
        desiredSkills: desired.length,
        effectiveEnabledSkills: applied.length,
        driftedSkills: drifted.map((assignment) => ({ slug: assignment.skillSlug, status: assignment.status, error: assignment.error })),
        followOn: 'Confirm exact effective state on host with hermes skills list plus skills.disabled before destructive reconciliation.',
      };
    }),
  };
}

export async function getPackageSecurityPosture(): Promise<Record<string, unknown>> {
  const readiness = await getFleetReadiness();
  return {
    generatedAt: new Date().toISOString(),
    nodes: readiness.nodes.map((node) => ({
      id: node['id'],
      name: node['name'],
      os: node['os'],
      agentVersion: node['agentVersion'],
      nodeVersion: node['nodeVersion'],
      npmAudit: 'unknown',
      osUpdates: 'unknown',
      vulnerablePackages: 'unknown',
      followOn: 'Add agent collector for apt list --upgradable and npm audit --json.',
    })),
  };
}
