import { enqueueSecurityObservations, securityFusionLocal } from '../services/security-export.js';
import { warnOnAgentVersionMismatch } from '../services/agent-version-warnings.js';
import { recordSelfUpgradeReport } from '../services/agent-upgrade-service.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import type { AppVariables, HermesNodeState } from '../types/index.js';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { HttpError } from '../middleware/error-handler.js';
import { createNotificationInTransaction } from '../services/notification-service.js';
import { matchingMaintenance } from '../services/maintenance-service.js';
import { evaluateHealth } from '../services/alert-service.js';
import { evaluateAnomalies } from '../services/anomaly-detector.js';
import { evaluatePredictionsForHeartbeat } from '../services/prediction-service.js';
import { recordManagedHermesState } from '../services/hermes-service.js';
import { NODE_MANAGER_SECRET } from '../utils/env.js';
import {
  getCredentialStatus,
  secretFingerprint,
  verifyWithRotation,
} from '../services/credential-rotation-service.js';
import { eventBus, EventChannels } from '../services/event-bus.js';
import { parseBody, safeParse } from '../utils/validate.js';
import { heartbeatHealthSchema } from '../schemas/node-responses.js';
import { normalizeIpAddress, isLoopbackOrUnroutableIp, isUsableNodeIp } from '../utils/ip.js';
import { AGENT_VERSION } from '../config/version.js';
import { getHeartbeatStreamStats } from '../services/heartbeat-stream.js';
import { ingestMagnusServiceHealth } from '../services/security-fusion-service.js';
import {
  deriveAgentCertificateHostname,
  selectAgentEndpointHostname,
  verifyAgentCertificateHostname,
} from '../utils/node-url.js';
import { heartbeatPeerAddress } from '../utils/heartbeat-peer.js';
import { authMiddleware } from '../middleware/auth.js';

export const heartbeatRouter = new Hono<AppVariables>();

const DEV_NODE_NAME = 'dev-local';

interface HeartbeatNetworkInfo {
  ipAddress?: string;
}

interface HeartbeatCpuInfo {
  usagePercent?: number;
  cores?: number;
  loadAverage?: [number, number, number];
}

interface HeartbeatMemoryInfo {
  totalBytes?: number;
  usedBytes?: number;
  usagePercent?: number;
  swapTotalBytes?: number;
  swapUsedBytes?: number;
}

interface HeartbeatHealthPayload {
  cpu?: HeartbeatCpuInfo;
  memory?: HeartbeatMemoryInfo;
  disks?: unknown[];
  network?: HeartbeatNetworkInfo[];
  services?: unknown[];
  wazuh?: unknown;
  systemUpdates?: unknown;
  gpu?: unknown;
  cockpitAvailable?: boolean;
  source?: string;
}

interface HeartbeatRequestBody {
  agentVersion?: string;
  fqdn?: string;
  platform?: string;
  arch?: string;
  health?: HeartbeatHealthPayload;
  hermes?: unknown;
  securityCapabilities?: { isolation?: boolean; serviceRestart?: boolean };
  selfUpgrade?: unknown;
  nodeVersion?: unknown;
}

/**
 * Envelope validation for agent heartbeats. Deliberately lenient: unknown
 * fields pass through (agents send uptime/status and newer agents may add
 * more), and only the types of fields this route reads are enforced. The
 * health payload is validated in detail later by heartbeatHealthSchema.
 */
export const heartbeatRequestSchema = z.object({
  agentVersion: z.string().max(64).optional(),
  fqdn: z.string().max(253).nullable().optional(),
  platform: z.string().max(64).optional(),
  arch: z.string().max(64).optional(),
  health: z.object({
    // No count cap: container hosts report one veth per container, and the
    // request body limit already bounds the array.
    network: z.array(z.object({ ipAddress: z.string().max(64).nullable().optional() }).passthrough())
      .nullable().optional(),
  }).passthrough().nullable().optional(),
  hermes: z.unknown().optional(),
  securityCapabilities: z.object({
    isolation: z.boolean().optional(),
    serviceRestart: z.boolean().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

function isHermesNodeState(value: unknown): value is HermesNodeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return typeof state['installed'] === 'boolean'
    && typeof state['status'] === 'string'
    && typeof state['hermesHome'] === 'string'
    && typeof state['hermesBin'] === 'string'
    && Boolean(state['configuration'] && typeof state['configuration'] === 'object');
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((v) => normalizeIpAddress(v)).filter(Boolean))];
}

function getHealthNetworkIps(body: HeartbeatRequestBody): string[] {
  return uniqueNonEmpty(
    (body.health?.network ?? [])
      .map((n) => n.ipAddress ?? '')
      .filter((ip) => isUsableNodeIp(ip)),
  );
}

async function tryResolveFqdnToIp(fqdn: string): Promise<string | null> {
  try {
    const records = await dns.lookup(fqdn, { all: true, verbatim: true });
    const ip = records.map((r) => normalizeIpAddress(r.address)).find((candidate) => isUsableNodeIp(candidate));
    return ip ?? null;
  } catch {
    return null;
  }
}

async function tryResolveCertificateHostnameToIp(hostname: string): Promise<string | null> {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records
      .map((record) => normalizeIpAddress(record.address))
      .find((candidate) => isIP(candidate) !== 0) ?? null;
  } catch {
    return null;
  }
}

export function selectPreferredNodeIp(options: {
  callerIp: string;
  healthNetworkIps: string[];
  fqdnResolvedIp: string | null;
}): string | null {
  const candidates = uniqueNonEmpty([
    options.fqdnResolvedIp ?? '',
    options.callerIp,
    ...options.healthNetworkIps,
  ]);

  const best = candidates.find((candidate) => isUsableNodeIp(candidate));
  return best ?? null;
}

export function shouldRepairNodeIp(currentIp: string): boolean {
  return isLoopbackOrUnroutableIp(currentIp);
}

/**
 * Try to resolve FQDN server-side via reverse DNS lookup.
 * Returns the FQDN if found, otherwise null.
 */
async function tryReverseDns(ipAddress: string): Promise<string | null> {
  try {
    // Skip loopback / non-routable addresses
    if (!isUsableNodeIp(ipAddress)) return null;
    const hostnames = await dns.reverse(ipAddress);
    const fqdn = hostnames.find((h) => h.includes('.'));
    return fqdn ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate the shared secret from the x-node-token header.
 */
function validateSharedSecret(token: string): string {
  if (!NODE_MANAGER_SECRET) {
    throw new HttpError(500, 'CONFIG_ERROR', 'NODE_MANAGER_SECRET not configured on control-api');
  }
  if (!verifyWithRotation('NODE_MANAGER_SECRET', NODE_MANAGER_SECRET, token)) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid node token');
  }
  return secretFingerprint(token);
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function recordNodeSecretFingerprint(nodeId: string, observedFingerprint: string): Promise<void> {
  const db = getDb();
  const row = await db.node.findUnique({ where: { id: nodeId }, select: { metadata: true } });
  const metadata = parseMetadata(row?.metadata ?? '');
  const status = getCredentialStatus('NODE_MANAGER_SECRET', NODE_MANAGER_SECRET);
  const state = observedFingerprint === status.activeFingerprint
    ? 'active'
    : observedFingerprint === status.previousFingerprint
      ? 'previous'
      : 'unknown';

  metadata['nodeManagerSecretFingerprint'] = observedFingerprint;
  metadata['nodeManagerSecretState'] = state;
  metadata['nodeManagerSecretObservedAt'] = new Date().toISOString();

  await db.node.update({
    where: { id: nodeId },
    data: { metadata: JSON.stringify(metadata) },
  });
}

interface ResolvedNode {
  nodeId: string;
  existing: { id: string; name: string; ipAddress: string; hostname: string; status: string } | null;
}

/**
 * Resolve the calling node by its FQDN / hostname.
 *
 * 1. Look up existing node by FQDN match on hostname or name
 * 2. If not found and this is localhost, find/create the dev-local node
 * 3. Otherwise return null — the heartbeat handler will still accept the
 *    heartbeat but won't be able to update a specific node.
 */
async function resolveNodeByFqdn(fqdn: string | null, callerIp: string, candidateIps: string[]): Promise<ResolvedNode | null> {
  const db = getDb();

  // ── 1. Match by FQDN against hostname or name ──
  if (fqdn) {
    const shortName = fqdn.split('.')[0] || fqdn;
    // Optional DNS suffix (for example a private overlay network domain) under
    // which agents may report their FQDN while inventory stores a short name.
    const dnsSuffix = process.env['MAGNUS_NODE_DNS_SUFFIX']?.trim().replace(/^\.+|\.+$/g, '');
    const aliasHostnames = [
      fqdn,
      shortName,
      ...(dnsSuffix ? [`${shortName}.${dnsSuffix}`] : []),
    ];
    const byHostname = await db.node.findFirst({
      where: {
        status: { not: 'DECOMMISSIONED' },
        OR: [
          { hostname: { in: aliasHostnames } },
          { name: { in: aliasHostnames } },
          { name: shortName },
        ],
      },
      select: { id: true, name: true, ipAddress: true, hostname: true, status: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (byHostname) {
      return { nodeId: byHostname.id, existing: byHostname };
    }
  }

  // ── 2. Match by IP address ──
  for (const ip of uniqueNonEmpty([callerIp, ...candidateIps])) {
    if (!isUsableNodeIp(ip)) continue;

    const byIp = await db.node.findFirst({
      where: { ipAddress: ip },
      select: { id: true, name: true, ipAddress: true, hostname: true, status: true },
    });
    if (byIp) {
      return { nodeId: byIp.id, existing: byIp };
    }
  }

  // ── 3. Dev-local fallback (only for true dev: local connection + no FQDN) ──
  const isLocal = !callerIp || callerIp === '127.0.0.1' || callerIp === '::1' || callerIp === '0.0.0.0';
  if (isLocal && !fqdn) {
    let devNode = await db.node.findUnique({
      where: { name: DEV_NODE_NAME },
      select: { id: true, name: true, ipAddress: true, hostname: true, status: true },
    });

    if (!devNode) {
      const id = nanoid();
      devNode = await db.node.create({
        data: {
          id,
          name: DEV_NODE_NAME,
          hostname: 'localhost',
          ipAddress: '127.0.0.1',
          port: 4100,
          os: process.platform,
          arch: process.arch,
          token: `local-${id}`,
          status: 'ONLINE',
        },
        select: { id: true, name: true, ipAddress: true, hostname: true, status: true },
      });
      await db.agent.create({
        data: { nodeId: id, version: 'dev', status: 'RUNNING', capabilities: '[]' },
      });
      console.log(`[Dev] Auto-registered local node: ${id}`);
    }

    return { nodeId: devNode.id, existing: devNode };
  }

  return null;
}

// ── Receive heartbeat from node agents ──
heartbeatRouter.post('/', async (c) => {
  const db = getDb();
  const token = c.req.header('x-node-token');
  if (!token) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Missing x-node-token');

  // Validate the shared secret
  const observedNodeManagerSecretFingerprint = validateSharedSecret(token);

  const body = await parseBody(c, heartbeatRequestSchema) as HeartbeatRequestBody;

  // Determine FQDN — prefer agent-reported, then try reverse DNS from caller IP
  let fqdn: string | null = body.fqdn ?? null;

  // The direct socket peer is authoritative. Proxy metadata is only a fallback
  // when the Node adapter does not expose connection data.
  const callerIp = heartbeatPeerAddress(c);

  const healthNetworkIps = getHealthNetworkIps(body);
  const fqdnResolvedIp = fqdn ? await tryResolveFqdnToIp(fqdn) : null;
  const preferredNodeIp = selectPreferredNodeIp({ callerIp, healthNetworkIps, fqdnResolvedIp });
  const ipCandidates = uniqueNonEmpty([callerIp, ...healthNetworkIps, fqdnResolvedIp ?? '']);
  const agentCertificateHostname = deriveAgentCertificateHostname(
    fqdn,
    process.env['AGENT_TLS_DOMAIN_SUFFIX'],
  );
  const agentCertificateIp = agentCertificateHostname
    ? await tryResolveCertificateHostnameToIp(agentCertificateHostname)
    : null;
  const verifiedAgentCertificateHostname = verifyAgentCertificateHostname(
    agentCertificateHostname,
    agentCertificateIp,
    ipCandidates,
  );

  let resolved = await resolveNodeByFqdn(fqdn, callerIp, ipCandidates);

  // ── Auto-register unknown agents ──────────────────────────────────────────
  // Token is valid but node isn't in our DB — create a record automatically.
  // This handles migrated agents arriving at a new control node.
  if (!resolved && (fqdn || callerIp)) {
    const nodeName = fqdn || preferredNodeIp || callerIp;
    const nodeHostname = fqdn || nodeName;
    const nodeIp = verifiedAgentCertificateHostname ?? preferredNodeIp ?? '0.0.0.0';

    try {
      const id = nanoid();
      const newNode = await db.node.create({
        data: {
          id,
          name: nodeName,
          hostname: nodeHostname,
          ipAddress: nodeIp,
          port: 4100,
          os: typeof body.platform === 'string' ? body.platform.slice(0, 32) : 'linux',
          arch: typeof body.arch === 'string' ? body.arch.slice(0, 32) : 'unknown',
          token: `auto-${id}`,
          status: 'ONLINE',
          lastHeartbeatAt: new Date(),
        },
        select: { id: true, name: true, ipAddress: true, hostname: true, status: true },
      });
      await db.agent.create({
        data: {
          nodeId: id,
          version: body.agentVersion ?? 'unknown',
          status: 'RUNNING',
          capabilities: '[]',
        },
      });
      console.log(`[Heartbeat] Auto-registered node: ${nodeName} (${nodeIp})`);
      resolved = { nodeId: id, existing: newNode };
    } catch {
      // Name collision (unique constraint) — find the existing node
      const existing = await db.node.findUnique({
        where: { name: nodeName },
        select: { id: true, name: true, ipAddress: true, hostname: true, status: true },
      });
      if (existing) {
        resolved = { nodeId: existing.id, existing };
      }
    }
  }

  if (!resolved) {
    // Secret is valid but we truly can't identify the node — accept silently
    return c.json({ success: true, data: { accepted: true } });
  }

  const { nodeId, existing } = resolved;

  if (body.securityCapabilities && existing) {
    const currentNode = await db.node.findUnique({ where: { id: nodeId }, select: { metadata: true } });
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(currentNode?.metadata ?? '{}') as Record<string, unknown>; } catch { /* preserve an empty metadata object */ }
    await db.node.update({
      where: { id: nodeId },
      data: { metadata: JSON.stringify({
        ...metadata,
        securityIsolationCapable: body.securityCapabilities.isolation === true,
        securityServiceRestartCapable: body.securityCapabilities.serviceRestart === true,
      }) },
    });
  }

  if (existing && body.selfUpgrade !== undefined) {
    await recordSelfUpgradeReport({ id: nodeId, name: existing.name }, body).catch((err: unknown) => {
      console.error(`[agent-upgrade] could not record the self-upgrade report of ${existing.name}:`, err instanceof Error ? err.message : err);
    });
  }

  if (!fqdn && existing) {
    // If the node's hostname already contains a dot it's likely an FQDN — skip lookup
    if (!existing.hostname.includes('.')) {
      fqdn = await tryReverseDns(existing.ipAddress);
    }
  }

  const repairedAgentAddress =
    existing && existing.name !== DEV_NODE_NAME
      ? verifiedAgentCertificateHostname ??
        (shouldRepairNodeIp(existing.ipAddress) ? preferredNodeIp : null)
      : null;

  // Update node heartbeat
  // When FQDN is available, update hostname and name.
  // Prefer a DNS identity whose resolved IP was present in this authenticated
  // heartbeat. This keeps hostname verification working even when a legacy
  // node record stored a LAN IP that is not present in the agent certificate.
  const recoveryMaintenance = existing ? await matchingMaintenance(existing.id) : null;
  let recoveredFrom: string | null = null;
  await db.$transaction(async tx => {
    const current = existing ? await tx.node.findUnique({ where: { id: existing.id }, select: { status: true } }) : null;
    if (fqdn && existing) {
      const endpointHostname = selectAgentEndpointHostname(
        verifiedAgentCertificateHostname,
        fqdn,
        existing.hostname,
        existing.ipAddress,
      );
      const autoGenerated =
        existing.name === DEV_NODE_NAME ||
        existing.name.startsWith('node-') ||
        /^\d+\.\d+\.\d+\.\d+/.test(existing.name) ||
        existing.name === fqdn;
      await tx.node.update({
        where: { id: existing.id },
        data: {
          lastHeartbeatAt: new Date(),
          status: 'ONLINE',
          hostname: endpointHostname,
          ...(typeof body.platform === 'string' ? { os: body.platform.slice(0, 32) } : {}),
          ...(typeof body.arch === 'string' ? { arch: body.arch.slice(0, 32) } : {}),
          ...(repairedAgentAddress ? { ipAddress: repairedAgentAddress } : {}),
          ...(autoGenerated ? { name: fqdn } : {}),
        },
      });
    } else if (existing) {
      await tx.node.update({
        where: { id: existing.id },
        data: {
          lastHeartbeatAt: new Date(),
          status: 'ONLINE',
          ...(repairedAgentAddress ? { ipAddress: repairedAgentAddress } : {}),
        },
      });
    } else {
      // Fallback: node verified by JWT but not found by id (edge case)
      await tx.node.updateMany({
        where: { id: nodeId },
        data: {
          lastHeartbeatAt: new Date(),
          status: 'ONLINE',
        },
      });
    }

    // ── Recovery notification: node was OFFLINE/DEGRADED and just came back ──
    if (existing && (current?.status === 'OFFLINE' || current?.status === 'DEGRADED')) {
      recoveredFrom = current.status;
      await createNotificationInTransaction(tx, {
        type: 'node.recovered',
        severity: 'info',
        title: `${existing.name} is back online`,
        message: `Node ${existing.name} (${existing.hostname}) recovered from ${current.status} status.`,
        nodeId: existing.id,
        nodeName: existing.name,
        metadata: { previousStatus: current.status },
      }, recoveryMaintenance?.id ?? null);
    }
  });
  if (existing && recoveredFrom) {
    void eventBus.publish(EventChannels.NODE_STATUS, {
      type: 'node.recovered', nodeId: existing.id, nodeName: existing.name,
      previousStatus: recoveredFrom, currentStatus: 'ONLINE',
      timestamp: new Date().toISOString(), source: 'control-api',
    });
  }

  // Update agent check-in
  if (body.agentVersion) {
    await db.agent.updateMany({
      where: { nodeId },
      data: {
        lastCheckIn: new Date(),
        version: body.agentVersion,
      },
    });
  }

  await recordNodeSecretFingerprint(nodeId, observedNodeManagerSecretFingerprint);

  if (isHermesNodeState(body.hermes)) {
    await recordManagedHermesState(nodeId, body.hermes).catch((err: unknown) => {
      console.warn(`[Heartbeat] Failed to record Hermes posture for ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else if (body.hermes !== undefined) {
    console.warn(`[Heartbeat] Invalid Hermes posture payload from ${nodeId}`);
  }

  // Store health snapshot if provided (validated against schema)
  if (body.health) {
    const parsed = safeParse(body.health, heartbeatHealthSchema);
    if (parsed.success) {
      const h = parsed.data;
      const gpuSampledAt = h.gpu ? new Date(h.gpu.sampledAt) : null;
      const gpuSampleIsSane = gpuSampledAt !== null
        && gpuSampledAt.getTime() <= Date.now() + 5 * 60 * 1000;
      const gpuUtilizationValues = h.gpu?.devices
        .map((device) => device.utilizationPercent)
        .filter((value): value is number => value !== null) ?? [];
      const gpuFanValues = h.gpu?.devices
        .map((device) => device.fanPercent)
        .filter((value): value is number => value !== null) ?? [];
      let gpuSampleIsNew = false;

      if (h.gpu && gpuSampledAt && gpuSampleIsSane) {
        const inserted = await db.gpuSnapshot.createMany({
          data: [{
            nodeId,
            sampledAt: gpuSampledAt,
            sampleIntervalSeconds: h.gpu.sampleIntervalSeconds,
            status: h.gpu.status,
            devices: JSON.stringify(h.gpu.devices),
            maxUtilizationPercent: gpuUtilizationValues.length > 0 ? Math.max(...gpuUtilizationValues) : null,
            maxFanPercent: gpuFanValues.length > 0 ? Math.max(...gpuFanValues) : null,
          }],
          skipDuplicates: true,
        });
        gpuSampleIsNew = inserted.count > 0;
      }

      const healthSnapshot = await db.$transaction(async (tx) => {
      const snapshot = await tx.healthSnapshot.create({
        data: {
          nodeId,
          cpuUsagePercent: h.cpu?.usagePercent ?? 0,
          cpuCores: h.cpu?.cores ?? 0,
          cpuLoadAverage: JSON.stringify(h.cpu?.loadAverage ?? [0, 0, 0]),
          memoryTotalBytes: BigInt(h.memory?.totalBytes ?? 0),
          memoryUsedBytes: BigInt(h.memory?.usedBytes ?? 0),
          memoryPercent: h.memory?.usagePercent ?? 0,
          swapTotalBytes: BigInt(h.memory?.swapTotalBytes ?? 0),
          swapUsedBytes: BigInt(h.memory?.swapUsedBytes ?? 0),
          disks: JSON.stringify(h.disks ?? []),
          network: JSON.stringify(h.network ?? []),
          services: JSON.stringify(h.services ?? []),
          wazuh: JSON.stringify(h.wazuh ?? {}),
          systemUpdates: JSON.stringify(h.systemUpdates ?? {}),
          cockpitAvailable: h.cockpitAvailable ?? false,
          source: h.source ?? 'system-probe',
        },
      });
      await enqueueSecurityObservations(tx,nodeId,existing?.name ?? fqdn ?? nodeId,(h.services ?? []) as Array<{name?:string;status?:string}>,snapshot.id,snapshot.timestamp);
      return snapshot;
      });

      if (securityFusionLocal()) void ingestMagnusServiceHealth(
        nodeId,
        existing?.name ?? fqdn ?? nodeId,
        (h.services ?? []) as Array<{ name?: string; status?: string }>,
      ).catch((err: unknown) => {
        console.error(`[security-fusion] heartbeat conversion failed for ${nodeId}:`, err instanceof Error ? err.message : err);
      });

      // Evaluate health against alert rules (fire-and-forget)
      const alertNodeName = existing?.name ?? fqdn ?? nodeId;
      evaluateHealth(nodeId, alertNodeName, {
        cpuUsagePercent: h.cpu?.usagePercent,
        memoryPercent: h.memory?.usagePercent,
        swapUsedBytes: h.memory?.swapUsedBytes,
        swapTotalBytes: h.memory?.swapTotalBytes,
        disks: h.disks as Array<{ mountpoint?: string; usagePercent?: number }>,
        gpuFanPercent: gpuFanValues.length > 0 ? Math.max(...gpuFanValues) : undefined,
        gpuSampledAt: gpuSampleIsSane ? gpuSampledAt ?? undefined : undefined,
        gpuSampleIsNew,
        gpuDevices: h.gpu?.devices,
      }).catch((err) => {
        console.error(`[alert] evaluate error for ${nodeId}:`, err instanceof Error ? err.message : err);
      });

      // Evaluate anomaly detection (fire-and-forget)
      evaluateAnomalies(nodeId, alertNodeName, {
        cpuUsagePercent: h.cpu?.usagePercent,
        memoryPercent: h.memory?.usagePercent,
        swapUsedBytes: h.memory?.swapUsedBytes,
        swapTotalBytes: h.memory?.swapTotalBytes,
        disks: h.disks as Array<{ usagePercent?: number; mountpoint?: string }>,
      }, healthSnapshot.id).catch((err) => {
        console.error(`[anomaly] evaluate error for ${nodeId}:`, err instanceof Error ? err.message : err);
      });

      // Evaluate predictive failure detection (fire-and-forget, throttled per node)
      evaluatePredictionsForHeartbeat(nodeId, alertNodeName).catch((err) => {
        console.error(`[prediction] evaluate error for ${nodeId}:`, err instanceof Error ? err.message : err);
      });
    } else {
      console.warn(`[Heartbeat] Invalid health payload from ${nodeId}: ${parsed.error}`);
    }
  }

  const expectedVersion = AGENT_VERSION;
  const { updateAvailable } = warnOnAgentVersionMismatch({ id: nodeId, name: existing?.name ?? fqdn ?? nodeId }, body.agentVersion, expectedVersion);

  return c.json({ success: true, data: { accepted: true, expectedVersion, updateAvailable } });
});

// ── Retired Redis Streams heartbeat ingress ──
// No agent or script used it. It stored the shared node secret in plaintext in
// a Redis stream and replayed it over loopback, losing the caller address.
// Agents POST /heartbeat directly; the read-only stats route below remains.
heartbeatRouter.post('/stream', (c) => c.json({
  success: false,
  error: {
    code: 'HEARTBEAT_STREAM_RETIRED',
    message: 'Redis stream heartbeat ingestion is retired; POST /api/v1/heartbeat instead.',
  },
}, 410));

/**
 * Stats endpoint for the dashboard.
 */
heartbeatRouter.get('/stream/stats', authMiddleware, async (c) => {
  const stats = await getHeartbeatStreamStats();
  return c.json({ success: true, data: stats });
});
