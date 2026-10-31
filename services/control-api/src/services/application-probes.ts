import { createHash } from 'node:crypto';
import { recordMonitorPulse } from './monitor-pulse.js';
import { getDb } from '../db/index.js';
import { getApplicationConfigs, type ApplicationConfig } from './operations-config.js';
import { createNotificationInTransaction } from './notification-service.js';
import { matchingMaintenance } from './maintenance-service.js';
import type { NotificationType } from '../types/index.js';
import { engineeringMetricEvidenceSha256 } from './engineering-metric-evidence.js';

export type ProbeResult = {
  status: 'pass' | 'fail' | 'unknown' | 'unconfigured';
  observedAt: string;
  checks: Array<{
    name: string;
    status: 'pass' | 'fail' | 'unknown' | 'unconfigured';
    detail: string;
    method?: 'GET' | 'POST';
    path?: string;
    httpStatus?: number | null;
    durationMs?: number;
    gpuQueueDepth?: number;
  }>;
  releaseRevision: string | null;
  probeContractSha256?: string;
};

export function applicationProbeContractDigest(config: ApplicationConfig): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1, id: config.id, projectId: config.projectId, serviceId: config.serviceId,
    nodeId: config.nodeId, baseUrl: config.baseUrl, healthPath: config.healthPath,
    readinessPath: config.readinessPath ?? null, queuePath: config.queuePath ?? null,
    maxQueueAgeMs: config.maxQueueAgeMs, tokenEnv: config.tokenEnv ?? null, kind: config.kind,
  })).digest('hex');
}

export async function boundedJson(response: Response, maxBytes = 65536): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error('Response limit exceeded');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function summarizeProbeBody(
  body: unknown,
  kind: ApplicationConfig['kind'],
): {
  status: 'pass' | 'fail' | 'unknown';
  releaseRevision: string | null;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { status: 'unknown', releaseRevision: null };
  const value = body as Record<string, unknown>;
  const status = String(value['status'] ?? '').toLowerCase();
  const failed =
    ['fail', 'failed', 'degraded', 'unhealthy', 'error', 'unavailable'].includes(status) ||
    value['ok'] === false;
  const good =
    ['ok', 'ready', 'healthy', 'pass', 'online'].includes(status) || value['ok'] === true;
  const revision = value['revision'] ?? value['commit'];
  const result: ReturnType<typeof summarizeProbeBody> = {
    status: failed ? 'fail' : good ? 'pass' : 'unknown',
    releaseRevision:
      typeof revision === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(revision) ? revision : null,
  };
  const nested =
    value['data'] && typeof value['data'] === 'object'
      ? (value['data'] as Record<string, unknown>)
      : value;
  // `workflow-queue`: a worker service that reports readiness and a workflow queue.
  if (kind === 'workflow-queue' && typeof nested['ready'] === 'boolean')
    result.status = nested['ready'] ? 'pass' : 'fail';
  if (kind === 'workflow-queue' && value['workflows'] && typeof value['workflows'] === 'object') {
    const queue = value['workflows'] as Record<string, unknown>;
    result.status =
      typeof queue['workers'] !== 'number'
        ? 'unknown'
        : queue['workers'] < 1 || queue['paused'] === true
          ? 'fail'
          : 'pass';
  }
  // `backend-pool`: a gateway that reports a pool of backends and a draining flag.
  if (kind === 'backend-pool' && Array.isArray(value['backends'])) {
    result.status = value['backends'].some(
      (b) => b && typeof b === 'object' && b.status === 'healthy',
    )
      ? 'pass'
      : 'fail';
  }
  if (kind === 'backend-pool' && value['draining'] === true) result.status = 'fail';
  return result;
}

export async function probeApplication(config: ApplicationConfig): Promise<ProbeResult> {
  const result: ProbeResult = {
    status: 'unknown',
    observedAt: new Date().toISOString(),
    checks: [],
    releaseRevision: null,
    probeContractSha256: applicationProbeContractDigest(config),
  };
  for (const [name, path, authenticated] of [
    ['reachability', config.healthPath, false],
    ...(config.readinessPath ? [['readiness', config.readinessPath, true]] : []),
    ...(config.queuePath ? [['worker-queue', config.queuePath, true]] : []),
  ] as Array<[string, string, boolean]>) {
    const token = config.tokenEnv ? process.env[config.tokenEnv] : undefined;
    if (authenticated && config.tokenEnv && !token) {
      result.checks.push({
        name,
        status: 'unconfigured',
        detail: 'Scoped credential is not configured',
        method: 'GET',
        path, httpStatus: null,
      });
      continue;
    }
    const probeStarted = Date.now();
    try {
      // Targets are operator-defined HTTPS origins; never follow a redirect with credentials.
      const response = await fetch(new URL(path, config.baseUrl), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        result.checks.push({
          name,
          status: 'fail',
          method: 'GET', path, httpStatus: response.status,
          durationMs: Date.now() - probeStarted,
          detail:
            response.status === 401 || response.status === 403
              ? 'Credential rejected'
              : `HTTP ${response.status}`,
        });
        continue;
      }
      const body = await boundedJson(response);
      const summary = summarizeProbeBody(body, config.kind);
      let gpuQueueDepth: number | undefined;
      if (config.kind === 'hive-router' && name === 'readiness') {
        summary.status =
          body &&
          typeof body === 'object' &&
          Array.isArray((body as Record<string, unknown>)['data'])
            ? 'pass'
            : 'unknown';
      }
      if (config.kind === 'workflow-queue' && body && typeof body === 'object') {
        const queue = (body as { workflows?: { latencyMsP50?: number; counts?: Record<string, unknown> } }).workflows;
        if (typeof queue?.latencyMsP50 === 'number' && queue.latencyMsP50 > config.maxQueueAgeMs)
          summary.status = 'fail';
        if (name === 'worker-queue' && queue?.counts && typeof queue.counts === 'object') {
          const values = ['waiting', 'delayed', 'paused'].map(key => queue.counts?.[key]);
          if (values.every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0))
            gpuQueueDepth = (values as number[]).reduce((total, value) => total + value, 0);
        }
      }
      result.checks.push({
        name,
        status: summary.status,
        method: 'GET', path, httpStatus: response.status,
        durationMs: Date.now() - probeStarted,
        ...(gpuQueueDepth === undefined ? {} : { gpuQueueDepth }),
        detail:
          summary.status === 'pass'
            ? 'Application contract passed'
            : 'Application readiness not proven',
      });
      result.releaseRevision = summary.releaseRevision ?? result.releaseRevision;
    } catch {
      result.checks.push({
        name,
        status: 'fail',
        detail: 'Transport, timeout, or response-contract failure',
        method: 'GET',
        path, httpStatus: null, durationMs: Date.now() - probeStarted,
      });
    }
  }
  result.status = result.checks.some((c) => c.status === 'fail')
    ? 'fail'
    : result.checks.some((c) => c.status === 'unconfigured')
      ? 'unconfigured'
      : result.checks.length && result.checks.every((c) => c.status === 'pass')
        ? 'pass'
        : 'unknown';
  return result;
}

const collector = { startedAt: null as string | null, completedAt: null as string | null, durationMs: 0, configured: 0, errors: 0 };
export function getApplicationProbeCollectorStatus() { return { ...collector, running }; }

export async function collectApplicationProbes(): Promise<void> {
  const configs = getApplicationConfigs();
  const started = Date.now();
  collector.startedAt = new Date(started).toISOString();
  collector.configured = configs.length;
  collector.errors = 0;
  let next = 0;
  // At most 25 requests at once. Even 100 applications with three eight-second
  // timeouts fit in 96 seconds, leaving room inside the 180-second freshness TTL.
  await Promise.all(Array.from({ length: Math.min(25, configs.length) }, async () => {
    for (;;) {
      const config = configs[next++];
      if (!config) return;
      try { await collectApplicationProbe(config); }
      catch { collector.errors++; console.error('[applications] observation persistence failed'); }
    }
  }));
  collector.durationMs = Date.now() - started;
  collector.completedAt = new Date().toISOString();
}

async function collectApplicationProbe(config: ApplicationConfig): Promise<void> {
  const result = await probeApplication(config);
  await persistApplicationProbeResult(config, result);
}

export async function persistApplicationProbeResult(
  config: ApplicationConfig, result: ProbeResult, afterObservation?: () => Promise<void>,
): Promise<void> {
  const db = getDb();
  const retainedResult = { ...result, probeContractSha256: applicationProbeContractDigest(config) };
  const maintenance = await matchingMaintenance(config.nodeId, config.serviceId);
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`application:${config.id}`}, 0))`;
    const previous = await tx.applicationObservation.findUnique({ where: { id: config.id } });
    await tx.applicationObservation.upsert({
      where: { id: config.id },
      create: {
        id: config.id,
        projectId: config.projectId,
        serviceId: config.serviceId,
        nodeId: config.nodeId,
        status: result.status,
        resultJson: JSON.stringify(retainedResult),
        observedAt: new Date(result.observedAt),
      },
      update: {
        projectId: config.projectId,
        serviceId: config.serviceId,
        nodeId: config.nodeId,
        status: result.status,
        resultJson: JSON.stringify(retainedResult),
        observedAt: new Date(result.observedAt),
      },
    });
    const observedAt = new Date(result.observedAt);
    const metricRows = result.checks.flatMap(check => {
      const rows: Array<{ applicationId: string; nodeId: string; metric: string; sourceKey: string;
        unit: string; value: number; observedAt: Date; probeContractSha256: string; method: string;
        path: string; httpStatus: number; evidenceSha256: string }> = [];
      if (check.status === 'pass' && check.httpStatus !== null && check.httpStatus !== undefined
          && check.method && check.path && check.durationMs !== undefined && Number.isFinite(check.durationMs) && check.durationMs >= 0) {
        const sample = { applicationId: config.id, nodeId: config.nodeId, metric: 'dependency_latency',
          sourceKey: check.name, unit: 'ms', value: check.durationMs, observedAt,
          probeContractSha256: applicationProbeContractDigest(config), method: check.method, path: check.path,
          httpStatus: check.httpStatus };
        rows.push({ ...sample, evidenceSha256: engineeringMetricEvidenceSha256(sample) });
      }
      if (check.status === 'pass' && check.gpuQueueDepth !== undefined
          && check.method && check.path && check.httpStatus !== null && check.httpStatus !== undefined
          && Number.isInteger(check.gpuQueueDepth) && check.gpuQueueDepth >= 0) {
        const sample = { applicationId: config.id, nodeId: config.nodeId, metric: 'gpu_queue',
          sourceKey: check.name, unit: 'jobs', value: check.gpuQueueDepth, observedAt,
          probeContractSha256: applicationProbeContractDigest(config), method: check.method, path: check.path,
          httpStatus: check.httpStatus };
        rows.push({ ...sample, evidenceSha256: engineeringMetricEvidenceSha256(sample) });
      }
      return rows;
    });
    if (metricRows.length) await tx.engineeringMetricSample.createMany({ data: metricRows, skipDuplicates: true });
    await afterObservation?.();
    if (
      result.status !== previous?.status &&
      (result.status === 'fail' || (previous?.status === 'fail' && result.status === 'pass'))
    ) {
      await createNotificationInTransaction(tx, {
        type: `application.${result.status === 'fail' ? 'failed' : 'recovered'}` as NotificationType,
        severity: result.status === 'fail' ? 'warning' : 'info',
        title: `${config.serviceId}: ${result.status === 'fail' ? 'readiness failed' : 'recovered'}`,
        message: result.checks.map((c) => `${c.name}: ${c.detail}`).join('; '),
        nodeId: config.nodeId,
        sourceRef: config.id,
        metadata: {
          serviceId: config.serviceId,
          applicationId: config.id,
          observedAt: result.observedAt,
        },
      }, maintenance?.id ?? null);
    }
  });
}
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
export function startApplicationProbes() {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await collectApplicationProbes();
      if (!collector.errors) recordMonitorPulse('applications');
      await (await import('./incident-lessons.js')).reconcileLessonInvalidations();
    } catch {
      console.error('[applications] collection failed');
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), 60000);
  timer.unref();
  void tick();
}
export function stopApplicationProbes() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
