import { createHash, createHmac, randomBytes } from 'node:crypto';
import { getDb, type Prisma } from '../db/index.js';
import { incMetric, setMetricGauge } from '../routes/metrics.js';
export type SecurityFusionMode = 'off' | 'local' | 'remote';
/** Security Fusion is optional: `off` unless explicitly set to `local` or `remote`. */
export function securityFusionMode(): SecurityFusionMode {
  const mode = process.env['SECURITY_FUSION_MODE'];
  return mode === 'local' || mode === 'remote' ? mode : 'off';
}
/** Observations are exported to an external security console. */
export function securityFusionRemote(): boolean {
  return securityFusionMode() === 'remote';
}
/** Security Fusion cases, evidence and receipts are kept in this server's database. */
export function securityFusionLocal(): boolean {
  return securityFusionMode() === 'local';
}
/** Optional external security console URL shown to operators in remote mode. */
export function securityConsoleUrl(): string | undefined {
  const raw = process.env['MAGNUS_SECURITY_CONSOLE_URL'];
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString().replace(/\/$/, '') : undefined;
  } catch { return undefined; }
}
export async function enqueueSecurityObservations(
  db: Prisma.TransactionClient,
  nodeId: string,
  nodeName: string,
  services: Array<{ name?: string; status?: string }>,
  observationId: string,
  observedAt: Date,
): Promise<void> {
  if (!securityFusionRemote()) return;
  if (!observationId) throw new Error('Durable observation identity required');
  if (services.length > 500) throw new Error('Security service observation limit exceeded');
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${nodeId}, 917))`;
  for (const service of services.filter((s) => s.name && s.status)) {
    const identity = { nodeId, serviceName: service.name! };
    const previous = await db.securityServiceState.findUnique({
      where: { nodeId_serviceName: identity },
    });
    if (previous && (previous.observationId === observationId || previous.observedAt >= observedAt))
      continue;
    await db.securityServiceState.upsert({
      where: { nodeId_serviceName: identity },
      create: { ...identity, status: service.status!, observationId, observedAt },
      update: { status: service.status!, observationId, observedAt },
    });
    if (previous?.status === service.status || !['failed', 'inactive'].includes(service.status!))
      continue;
    const sourceEventId = `${nodeId}:${service.name}:${service.status}:${observationId}`;
    const eventId = createHash('sha256').update(`magnus:${sourceEventId}`).digest('hex');
    const event = {
      schemaVersion: '1.0',
      eventId,
      source: 'magnus',
      sourceEventId,
      kind: 'magnus.service.health',
      observedAt: observedAt.toISOString(),
      severity: service.status === 'failed' ? 'high' : 'medium',
      confidence: 0.88,
      summary: `${service.name} reported ${service.status} on ${nodeName}`,
      entities: [
        { type: 'host', value: nodeName },
        { type: 'service', value: service.name, label: service.name },
      ],
      attributes: { nodeId, serviceStatus: service.status },
      evidence: [
        {
          sourceLocator: `magnus-heartbeat:${nodeId}:${observationId}`,
          mediaType: 'application/json',
        },
      ],
    };
    await db.securityExportOutbox.upsert({
      where: { id: eventId },
      create: { id: eventId, payload: JSON.stringify(event) },
      update: {},
    });
  }
}
async function post(path: string, body: unknown) {
  const secret = process.env['SECURITY_EXPORT_SECRET'];
  const url = process.env['SECURITY_FUSION_API_URL'];
  if (!secret || !url || new URL(url).protocol !== 'https:')
    throw new Error('Security export not configured');
  const raw = JSON.stringify(body),
    timestamp = new Date().toISOString(),
    nonce = randomBytes(16).toString('hex'),
    id = 'magnus-control-api';
  const signature = createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${nonce}.${raw}`)
    .digest('hex');
  const r = await fetch(`${url}/api/v1/security-fusion/ingest/${path}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      'content-type': 'application/json',
      'x-security-collector-id': id,
      'x-security-timestamp': timestamp,
      'x-security-nonce': nonce,
      'x-security-signature': signature,
    },
    body: raw,
  });
  if (!r.ok) throw new Error(`Security export HTTP ${r.status}`);
}
let running = false;
export async function flushSecurityExports(): Promise<void> {
  if (running || !securityFusionRemote() || process.env['SECURITY_EXPORT_ENABLED'] !== 'true')
    return;
  running = true;
  try {
    const db = getDb();
    const now = new Date();
    const rows = await db.securityExportOutbox.findMany({
      where: { deliveredAt: null, nextAttemptAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    if (rows.length) {
      try {
        await post('events', {
          schemaVersion: '1.0',
          collectorId: 'magnus-control-api',
          sentAt: now.toISOString(),
          events: rows.map((r) => JSON.parse(r.payload)),
        });
        await db.securityExportOutbox.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { deliveredAt: new Date(), lastError: null },
        });
      } catch {
        for (const row of rows)
          await db.securityExportOutbox.update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              lastError: 'Security event delivery failed',
              nextAttemptAt: new Date(
                Date.now() + Math.min(300000, 5000 * 2 ** Math.min(row.attempts, 6)),
              ),
            },
          });
        incMetric('securityExportFailures');
      }
    }
    const pending = await db.securityExportOutbox.count({ where: { deliveredAt: null } });
    const oldest = await db.securityExportOutbox.findFirst({
      where: { deliveredAt: null },
      orderBy: { createdAt: 'asc' },
    });
    setMetricGauge('securityExportBacklog', pending);
    setMetricGauge(
      'securityExportOldestAgeSeconds',
      oldest ? (Date.now() - oldest.createdAt.getTime()) / 1000 : 0,
    );
    await post('source-status', {
      schemaVersion: '1.0',
      collectorId: 'magnus-control-api',
      sentAt: new Date().toISOString(),
      sources: [
        {
          source: 'magnus',
          status: pending ? 'degraded' : 'healthy',
          ...(pending ? { error: `${pending} observations awaiting delivery` } : {}),
        },
      ],
    });
    await db.securityExportOutbox.deleteMany({
      where: { deliveredAt: { lt: new Date(Date.now() - 7 * 86400000) } },
    });
  } finally {
    running = false;
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startSecurityExporter() {
  timer = setInterval(() => {
    void flushSecurityExports().catch(() => incMetric('securityExportFailures'));
  }, 60000);
  timer.unref();
}
export function stopSecurityExporter() {
  if (timer) clearInterval(timer);
}
