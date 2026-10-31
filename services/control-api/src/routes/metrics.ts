import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { getRedis } from '../queue/redis.js';
import { getHeartbeatStreamStats } from '../services/heartbeat-stream.js';
import { safeEqual } from '../utils/safe-equal.js';

export const metricsRouter = new Hono<AppVariables>();

// ── In-process counters ──
const counters = {
  securityExportFailures: 0,
  httpRequestsTotal: 0,
  httpErrorsTotal: 0,
  commandsDispatched: 0,
  commandsCompleted: 0,
  commandsFailed: 0,
  heartbeatsReceived: 0,
  webhooksDelivered: 0,
  webhooksFailed: 0,
  dbReadRetries: 0,
  rateLimiterFailures: 0,
  securityFusionEvidenceAccepted: 0,
  securityFusionEvidenceRejected: 0,
  securityFusionEvidenceTruncated: 0,
  securityFusionRelationshipTruncated: 0,
  securityFusionEvidenceDeleted: 0,
  securityFusionCasesArchived: 0,
  securityFusionCasesDeleted: 0,
};
const gauges = {
  securityExportBacklog: 0,
  securityExportOldestAgeSeconds: 0,
  securityFusionEvidenceReconciliationMismatchedCases: 0,
  securityFusionEvidenceQuarantinedArtifacts: 0,
};

const histogramBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const latencyObservations: number[] = [];
const routeLatencyObservations = new Map<string, number[]>();
const MAX_OBSERVATIONS = 10000;
const MAX_ROUTE_SERIES = 500;

/** Increment a named counter. */
export function incMetric(name: keyof typeof counters, value = 1): void {
  counters[name] += value;
}

/** Set a bounded in-process gauge. */
export function setMetricGauge(name: keyof typeof gauges, value: number): void {
  gauges[name] = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Record a request latency observation (ms). */
export function observeLatency(ms: number, route = 'unknown', status = 200): void {
  latencyObservations.push(ms);
  if (latencyObservations.length > MAX_OBSERVATIONS) {
    latencyObservations.splice(0, latencyObservations.length - MAX_OBSERVATIONS);
  }
  // `route` is the matched route pattern (bounded by the router); the series
  // cap is a defensive backstop against any unbounded caller.
  const routeTemplate = route.replace(/["\\\n|]/g, '_');
  const outcome = `${Math.floor(status / 100)}xx`;
  let key = `${routeTemplate}|${outcome}`;
  if (!routeLatencyObservations.has(key) && routeLatencyObservations.size >= MAX_ROUTE_SERIES) {
    key = `other|${outcome}`;
  }
  const values = routeLatencyObservations.get(key) ?? [];
  values.push(ms);
  if (values.length > 1000) values.splice(0, values.length - 1000);
  routeLatencyObservations.set(key, values);
}

export function buildHistogram(observations: number[], buckets: number[]): string {
  const prefix = 'magnus_http_request_duration_ms';
  const lines: string[] = [];
  lines.push(`# HELP ${prefix} HTTP request duration in milliseconds`);
  lines.push(`# TYPE ${prefix} histogram`);

  for (const le of buckets) {
    const cumulativeCount = observations.filter((v) => v <= le).length;
    lines.push(`${prefix}_bucket{le="${le}"} ${cumulativeCount}`);
  }
  lines.push(`${prefix}_bucket{le="+Inf"} ${observations.length}`);
  const sum = observations.reduce((a, b) => a + b, 0);
  lines.push(`${prefix}_sum ${sum}`);
  lines.push(`${prefix}_count ${observations.length}`);
  return lines.join('\n');
}

metricsRouter.get('/', async (c) => {
  const metricsToken = process.env['METRICS_TOKEN'] ?? '';
  if (metricsToken.length < 32) {
    return c.text('Metrics disabled: credential is not configured\n', 503);
  }
  const header = c.req.header('authorization') ?? '';
  if (!safeEqual(header, `Bearer ${metricsToken}`)) {
    return c.text('Unauthorized\n', 401);
  }

  const lines: string[] = [];

  // ── Counters ──
  for (const [name, value] of Object.entries(counters)) {
    const metricName = `magnus_${name.replace(/([A-Z])/g, '_$1').toLowerCase()}`;
    lines.push(`# HELP ${metricName} Counter for ${name}`);
    lines.push(`# TYPE ${metricName} counter`);
    lines.push(`${metricName} ${value}`);
  }
  for (const [name, value] of Object.entries(gauges)) {
    const metricName = `magnus_${name.replace(/([A-Z])/g, '_$1').toLowerCase()}`;
    lines.push(`# HELP ${metricName} Gauge for ${name}`);
    lines.push(`# TYPE ${metricName} gauge`);
    lines.push(`${metricName} ${value}`);
  }

  // ── Histogram ──
  if (latencyObservations.length > 0) {
    lines.push(buildHistogram(latencyObservations, histogramBuckets));
  }
  for (const [key, values] of routeLatencyObservations) {
    const [route, outcome] = key.split('|');
    lines.push(`magnus_http_route_duration_ms_count{route="${route}",outcome="${outcome}"} ${values.length}`);
    lines.push(`magnus_http_route_duration_ms_sum{route="${route}",outcome="${outcome}"} ${values.reduce((sum, value) => sum + value, 0)}`);
  }

  // ── Gauges from DB ──
  try {
    const db = getDb();
    const [nodeCount, onlineNodes, pendingCommands, staleNodes, versions, oldestQueued] = await Promise.all([
      db.node.count(),
      db.node.count({ where: { status: 'ONLINE' } }),
      db.remoteCommand.count({ where: { status: { in: ['PENDING', 'QUEUED'] } } }),
      db.node.count({ where: { lastHeartbeatAt: { lt: new Date(Date.now() - 120_000) } } }),
      db.agent.groupBy({ by: ['version'], _count: true }),
      db.remoteCommand.findFirst({ where: { status: { in: ['PENDING', 'QUEUED'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);

    lines.push('# HELP magnus_nodes_total Total registered nodes');
    lines.push('# TYPE magnus_nodes_total gauge');
    lines.push(`magnus_nodes_total ${nodeCount}`);

    lines.push('# HELP magnus_nodes_online Nodes currently online');
    lines.push('# TYPE magnus_nodes_online gauge');
    lines.push(`magnus_nodes_online ${onlineNodes}`);

    lines.push('# HELP magnus_commands_pending Commands pending or queued');
    lines.push('# TYPE magnus_commands_pending gauge');
    lines.push(`magnus_commands_pending ${pendingCommands}`);
    lines.push(`# HELP magnus_nodes_stale Nodes with heartbeat older than 120 seconds`);
    lines.push(`# TYPE magnus_nodes_stale gauge`);
    lines.push(`magnus_nodes_stale ${staleNodes}`);
    lines.push(`# HELP magnus_agent_version_skew Distinct agent versions beyond the expected single version`);
    lines.push(`# TYPE magnus_agent_version_skew gauge`);
    lines.push(`magnus_agent_version_skew ${Math.max(0, versions.length - 1)}`);
    lines.push(`# HELP magnus_command_queue_oldest_age_seconds Age of the oldest queued command`);
    lines.push(`# TYPE magnus_command_queue_oldest_age_seconds gauge`);
    lines.push(`magnus_command_queue_oldest_age_seconds ${oldestQueued ? Math.max(0, Math.floor((Date.now() - oldestQueued.createdAt.getTime()) / 1000)) : 0}`);
  } catch {
    // DB unavailable — skip gauges
  }

  try {
    const stream = await getHeartbeatStreamStats();
    lines.push(`# HELP magnus_heartbeat_stream_pending Pending heartbeat stream entries`);
    lines.push(`# TYPE magnus_heartbeat_stream_pending gauge`);
    lines.push(`magnus_heartbeat_stream_pending ${stream.pending}`);
    lines.push(`# HELP magnus_heartbeat_consumer_max_idle_ms Maximum heartbeat consumer idle age`);
    lines.push(`# TYPE magnus_heartbeat_consumer_max_idle_ms gauge`);
    lines.push(`magnus_heartbeat_consumer_max_idle_ms ${Math.max(0, ...stream.consumers.map((consumer) => consumer.idleMs))}`);
  } catch { /* Redis unavailable — dependency health reports the failure. */ }

  // ── Redis queue depth ──
  try {
    const redis = getRedis();
    const commandQueueLen = await redis.llen('bull:magnus:commands:wait');
    const webhookQueueLen = await redis.llen('bull:magnus:webhooks:wait');

    lines.push('# HELP magnus_queue_depth_commands Command queue depth');
    lines.push('# TYPE magnus_queue_depth_commands gauge');
    lines.push(`magnus_queue_depth_commands ${commandQueueLen}`);

    lines.push('# HELP magnus_queue_depth_webhooks Webhook queue depth');
    lines.push('# TYPE magnus_queue_depth_webhooks gauge');
    lines.push(`magnus_queue_depth_webhooks ${webhookQueueLen}`);
  } catch {
    // Redis unavailable — skip queue metrics
  }

  // ── Process metrics ──
  const mem = process.memoryUsage();
  lines.push('# HELP magnus_process_heap_bytes Process heap memory usage');
  lines.push('# TYPE magnus_process_heap_bytes gauge');
  lines.push(`magnus_process_heap_bytes ${mem.heapUsed}`);

  lines.push('# HELP magnus_process_rss_bytes Process RSS memory');
  lines.push('# TYPE magnus_process_rss_bytes gauge');
  lines.push(`magnus_process_rss_bytes ${mem.rss}`);

  const uptime = process.uptime();
  lines.push('# HELP magnus_process_uptime_seconds Process uptime');
  lines.push('# TYPE magnus_process_uptime_seconds gauge');
  lines.push(`magnus_process_uptime_seconds ${Math.floor(uptime)}`);

  c.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return c.body(lines.join('\n') + '\n');
});
