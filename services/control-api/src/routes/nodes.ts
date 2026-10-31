import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { nanoid } from 'nanoid';
import { AGENT_VERSION } from '../config/index.js';
import { getDb } from '../db/index.js';
import { promises as dns } from 'node:dns';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import { HttpError } from '../middleware/error-handler.js';
import { parseBody } from '../utils/validate.js';
import { bulkNodeTagsSchema, registerNodeSchema, updateNodeSchema } from '../schemas/nodes.js';
import { normalizeIpAddress, isUsableNodeIp } from '../utils/ip.js';
import { deleteNodeCascade } from '../services/node-service.js';
import { serializeStringArray, serializeRecord } from '../utils/json-fields.js';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';
import { NodeApiClient } from '../sdk/index.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { ensureControlHostNode } from '../services/control-host-node.js';
import { withReadRetry } from '../db/read-retry.js';
import {
  parseTailscaleNodeKeyPosture,
  summarizeTailscaleNodeKeys,
  TAILSCALE_RENEWAL_WARNING_DAYS,
} from '../services/tailscale-node-key-service.js';

interface WazuhAgentPosture {
  installed: boolean;
  serviceStatus: 'active' | 'inactive' | 'failed' | 'not_installed' | 'unknown';
  enabled: 'enabled' | 'disabled' | 'static' | 'unknown';
  version: string | null;
  managerAddresses: string[];
}

interface SystemUpdatePosture {
  supported: boolean;
  platform: string;
  automaticUpdates: 'enabled' | 'disabled' | 'partial' | 'unsupported' | 'unknown';
  unattendedUpgradesInstalled: boolean;
  periodicUpdateListsEnabled: boolean;
  periodicUnattendedUpgradeEnabled: boolean;
  fullUpgradePolicyEnabled: boolean;
  timers: Array<{ name: string; enabled: boolean; active: boolean; state: string }>;
  rebootRequired: boolean;
  rebootRequiredPackages: string[];
}

function parseSystemUpdatePosture(value: string): SystemUpdatePosture | null {
  try {
    const parsed = JSON.parse(value) as Partial<SystemUpdatePosture>;
    if (
      typeof parsed.supported !== 'boolean' ||
      typeof parsed.platform !== 'string' ||
      !['enabled', 'disabled', 'partial', 'unsupported', 'unknown'].includes(parsed.automaticUpdates ?? '') ||
      typeof parsed.unattendedUpgradesInstalled !== 'boolean' ||
      typeof parsed.periodicUpdateListsEnabled !== 'boolean' ||
      typeof parsed.periodicUnattendedUpgradeEnabled !== 'boolean' ||
      !Array.isArray(parsed.timers) ||
      typeof parsed.rebootRequired !== 'boolean' ||
      !Array.isArray(parsed.rebootRequiredPackages)
    ) return null;
    return {
      ...parsed,
      // Older agents did not report this field. Treat them as not covered so
      // fleet posture cannot mistake the old security-only policy for full upgrades.
      fullUpgradePolicyEnabled: parsed.fullUpgradePolicyEnabled === true,
    } as SystemUpdatePosture;
  } catch {
    return null;
  }
}

function parseWazuhPosture(value: string): WazuhAgentPosture | null {
  try {
    const parsed = JSON.parse(value) as Partial<WazuhAgentPosture>;
    if (
      typeof parsed.installed !== 'boolean' ||
      !['active', 'inactive', 'failed', 'not_installed', 'unknown'].includes(parsed.serviceStatus ?? '') ||
      !['enabled', 'disabled', 'static', 'unknown'].includes(parsed.enabled ?? '') ||
      !(parsed.version === null || typeof parsed.version === 'string') ||
      !Array.isArray(parsed.managerAddresses) ||
      !parsed.managerAddresses.every((address) => typeof address === 'string')
    ) {
      return null;
    }
    return parsed as WazuhAgentPosture;
  } catch {
    return null;
  }
}

interface NodeAddressRepairRequest {
  ipAddress?: string;
  hostname?: string;
  resolveDns?: boolean;
}

async function tryResolveHostnameToIp(hostname: string): Promise<string | null> {
  const normalizedHost = hostname.trim();
  if (!normalizedHost) return null;

  // Allow IP literals directly (e.g., hostname accidentally set to IP)
  if (isUsableNodeIp(normalizedHost)) {
    return normalizeIpAddress(normalizedHost);
  }

  try {
    const records = await dns.lookup(normalizedHost, { all: true, verbatim: true });
    const candidate = records
      .map((record) => normalizeIpAddress(record.address))
      .find((address) => isUsableNodeIp(address));
    return candidate ?? null;
  } catch {
    return null;
  }
}

export const nodesRouter = new Hono<AppVariables>();

// All routes require auth
nodesRouter.use('*', authMiddleware);

// ── List nodes ──
nodesRouter.get('/', async (c) => {
  await ensureControlHostNode();

  const db = getDb();
  const page = Number(c.req.query('page') ?? '1');
  const pageSize = Math.min(Number(c.req.query('pageSize') ?? '50'), 100);
  const status = c.req.query('status');
  const tag = c.req.query('tag');
  const query = (c.req.query('query') ?? '').trim();

  const baseWhere: Record<string, unknown> = { id: { notIn: SENTINEL_NODE_IDS } };
  if (status) baseWhere['status'] = status.toUpperCase() as never;
  // Tags remain a wire-compatible JSON string, so search for a quoted member.
  if (tag) baseWhere['tags'] = { contains: `"${tag}"` };
  if (query) {
    baseWhere['OR'] = [
      { name: { contains: query } },
      { hostname: { contains: query } },
      { ipAddress: { contains: query } },
    ];
  }
  const where = baseWhere;
  const [nodes, total] = await withReadRetry('nodes list', () => Promise.all([
    db.node.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { name: 'asc' },
      include: { agent: true, role: { select: { id: true, name: true } } },
    }),
    db.node.count({ where }),
  ]));

  // Strip token from API response — never expose node secrets to the frontend
  const safeNodes = nodes.map(({ token: _token, ...rest }) => rest);

  return c.json({
    success: true,
    data: safeNodes,
    meta: { total, page, pageSize, hasMore: page * pageSize < total },
  });
});

// ── Get all unique tags with counts ──
nodesRouter.get('/tags', async (c) => {
  const db = getDb();
  const nodes = await db.node.findMany({
    where: { id: { notIn: SENTINEL_NODE_IDS } },
    select: { tags: true },
  });

  const tagCounts = new Map<string, number>();
  for (const node of nodes) {
    const tags: string[] = JSON.parse((node.tags as string) || '[]');
    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const tags = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return c.json({ success: true, data: tags });
});

// ── Fleet Wazuh inventory from each node's latest heartbeat ──
nodesRouter.get('/wazuh/summary', async (c) => {
  const db = getDb();
  const nodes = await db.node.findMany({
    where: { id: { notIn: SENTINEL_NODE_IDS } },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      hostname: true,
      status: true,
      lastHeartbeatAt: true,
      healthSnapshots: {
        orderBy: { timestamp: 'desc' },
        take: 1,
        select: { timestamp: true, wazuh: true },
      },
    },
  });

  const inventory = nodes.map((node) => {
    const snapshot = node.healthSnapshots[0] ?? null;
    return {
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      nodeStatus: node.status,
      lastHeartbeatAt: node.lastHeartbeatAt,
      observedAt: snapshot?.timestamp ?? null,
      wazuh: snapshot ? parseWazuhPosture(snapshot.wazuh) : null,
    };
  });

  return c.json({
    success: true,
    data: {
      total: inventory.length,
      reporting: inventory.filter((node) => node.wazuh !== null).length,
      installed: inventory.filter((node) => node.wazuh?.installed).length,
      active: inventory.filter((node) => node.wazuh?.serviceStatus === 'active').length,
      failed: inventory.filter((node) => node.wazuh?.serviceStatus === 'failed').length,
      nodes: inventory,
    },
  });
});

// ── Fleet Tailscale node-key renewal posture ──
nodesRouter.get('/tailscale/summary', async (c) => {
  const db = getDb();
  const nodes = await db.node.findMany({
    where: { id: { notIn: SENTINEL_NODE_IDS } },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      hostname: true,
      status: true,
      lastHeartbeatAt: true,
      healthSnapshots: {
        orderBy: { timestamp: 'desc' },
        take: 1,
        select: { timestamp: true, services: true },
      },
    },
  });
  const nowMs = Date.now();
  const inventory = nodes.map((node) => {
    const snapshot = node.healthSnapshots[0] ?? null;
    return {
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      nodeStatus: node.status,
      lastHeartbeatAt: node.lastHeartbeatAt,
      observedAt: snapshot?.timestamp ?? null,
      tailscale: snapshot
        ? parseTailscaleNodeKeyPosture(snapshot.services, nowMs, TAILSCALE_RENEWAL_WARNING_DAYS)
        : null,
    };
  });

  return c.json({
    success: true,
    data: summarizeTailscaleNodeKeys(inventory, TAILSCALE_RENEWAL_WARNING_DAYS),
  });
});

// ── Fleet automatic-update and reboot posture ──
nodesRouter.get('/system-updates/summary', async (c) => {
  const db = getDb();
  const nodes = await db.node.findMany({
    where: { id: { notIn: SENTINEL_NODE_IDS } },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      hostname: true,
      status: true,
      lastHeartbeatAt: true,
      healthSnapshots: {
        orderBy: { timestamp: 'desc' },
        take: 1,
        select: { timestamp: true, systemUpdates: true },
      },
    },
  });
  const inventory = nodes.map((node) => {
    const snapshot = node.healthSnapshots[0] ?? null;
    return {
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      nodeStatus: node.status,
      lastHeartbeatAt: node.lastHeartbeatAt,
      observedAt: snapshot?.timestamp ?? null,
      systemUpdates: snapshot ? parseSystemUpdatePosture(snapshot.systemUpdates) : null,
    };
  });
  return c.json({
    success: true,
    data: {
      total: inventory.length,
      reporting: inventory.filter((node) => node.systemUpdates !== null).length,
      enabled: inventory.filter((node) => node.systemUpdates?.automaticUpdates === 'enabled').length,
      actionNeeded: inventory.filter((node) => ['disabled', 'partial'].includes(node.systemUpdates?.automaticUpdates ?? '')).length,
      rebootRequired: inventory.filter((node) => node.systemUpdates?.rebootRequired).length,
      nodes: inventory,
    },
  });
});

nodesRouter.post('/:nodeId/system-updates/enable', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const nodeId = c.req.param('nodeId')!;
  const node = await db.node.findUnique({ where: { id: nodeId } });
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  if (node.status !== 'ONLINE') {
    throw new HttpError(409, 'INVALID_STATE', `Node is ${node.status}, must be ONLINE`);
  }

  try {
    const client = new NodeApiClient({
      baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
      resourceNodeId: node.id,
      nodeToken: getNodeManagerSecret(),
      timeout: 20 * 60_000,
    });
    const response = await client.enableSystemUpdates();
    if (!response.success || !response.data) throw new Error('Node agent rejected the update policy change');
    await logAuditEvent({
      action: 'node.system_updates.enable',
      actorId: user.userId,
      targetType: 'node',
      targetId: nodeId,
      details: { hostname: node.hostname, automaticUpdates: response.data.automaticUpdates },
    });
    return c.json({ success: true, data: response.data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logAuditEvent({
      action: 'node.system_updates.enable_failed',
      actorId: user.userId,
      targetType: 'node',
      targetId: nodeId,
      details: { hostname: node.hostname, error: message },
    });
    throw new HttpError(502, 'NODE_UPDATE_POLICY_FAILED', message);
  }
});

// ── Bulk tag operations (add/remove across multiple nodes) ──
nodesRouter.post('/tags/bulk', async (c) => {
  const db = getDb();
  const user = getUser(c);
  if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
    throw new HttpError(403, 'FORBIDDEN', 'Operator or admin access required');
  }

  const body = await parseBody(c, bulkNodeTagsSchema);

  const tagsToApply = [...new Set(
    body.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0),
  )];

  const nodes = await db.node.findMany({
    where: { id: { in: body.nodeIds } },
    select: { id: true, tags: true },
  });

  const updates = nodes.map((node) => {
    const currentTags: string[] = JSON.parse((node.tags as string) || '[]');
    let newTags: string[];

    if (body.action === 'add') {
      newTags = [...new Set([...currentTags, ...tagsToApply])];
    } else {
      newTags = currentTags.filter((t) => !tagsToApply.includes(t));
    }

    return db.node.update({
      where: { id: node.id },
      data: { tags: JSON.stringify(newTags) },
    });
  });

  await Promise.all(updates);

  await logAuditEvent({
    action: 'node.tags.bulk',
    actorId: user.userId,
    targetType: 'node',
    targetId: nodes.length === 1 ? nodes[0]!.id : 'bulk',
    details: { action: body.action, tags: tagsToApply, nodeIds: nodes.map((node) => node.id), updated: nodes.length },
  });

  return c.json({
    success: true,
    data: { updated: nodes.length, action: body.action, tags: tagsToApply },
  });
});

// ── Compare nodes side-by-side ──
nodesRouter.get('/compare', async (c) => {
  const idsParam = c.req.query('ids');
  if (!idsParam) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'ids query parameter is required (comma-separated node IDs)');
  }

  const ids = idsParam.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length < 2 || ids.length > 5) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Provide 2-5 node IDs to compare');
  }

  const db = getDb();

  const nodes = await db.node.findMany({
    where: { id: { in: ids } },
    include: {
      agent: { select: { version: true } },
      healthSnapshots: {
        orderBy: { timestamp: 'desc' },
        take: 1,
      },
      skillInstalls: true,
      roleApplications: {
        include: { role: { select: { name: true } } },
      },
    },
  });

  if (nodes.length < 2) {
    throw new HttpError(404, 'NOT_FOUND', 'One or more nodes not found');
  }

  // Build comparison structure
  const comparison = nodes.map((node) => {
    const health = node.healthSnapshots[0] ?? null;
    const tags = (() => { try { return JSON.parse(node.tags ?? '[]'); } catch { return []; } })();

    return {
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      ipAddress: node.ipAddress,
      status: node.status,
      agentVersion: node.agent?.version ?? 'unknown',
      os: node.os,
      arch: node.arch,
      tags,
      health: health
        ? {
            cpuUsagePercent: health.cpuUsagePercent,
            memoryPercent: health.memoryPercent,
            disks: health.disks,
            timestamp: health.timestamp,
          }
        : null,
      skills: node.skillInstalls.map((s) => ({
        name: s.skillName,
        version: s.version,
        status: s.status,
      })),
      roles: node.roleApplications.map((ra) => ({
        roleName: ra.role.name,
        action: ra.action,
        status: ra.status,
      })),
    };
  });

  // Identify differences
  const diffFields: string[] = [];
  const reference = comparison[0];
  if (!reference) {
    throw new HttpError(500, 'INTERNAL_ERROR', 'Comparison failed');
  }

  const fieldChecks = ['status', 'agentVersion', 'os', 'arch'] as const;
  for (const field of fieldChecks) {
    const values = new Set(comparison.map((n) => n[field]));
    if (values.size > 1) diffFields.push(field);
  }

  // Check health metric differences (>10% threshold)
  if (comparison.every((n) => n.health)) {
    const healthFields = ['cpuUsagePercent', 'memoryPercent'] as const;
    for (const field of healthFields) {
      const values = comparison.map((n) => n.health?.[field] ?? 0);
      const range = Math.max(...values) - Math.min(...values);
      if (range > 10) diffFields.push(`health.${field}`);
    }
  }

  // Check skill differences
  const skillSets = comparison.map((n) => new Set(n.skills.map((s) => `${s.name}@${s.version}`)));
  const allSkills = new Set(skillSets.flatMap((s) => [...s]));
  for (const skill of allSkills) {
    if (!skillSets.every((s) => s.has(skill))) {
      diffFields.push('skills');
      break;
    }
  }

  return c.json({
    success: true,
    data: {
      nodes: comparison,
      diffFields,
    },
  });
});

// ── Scan all online nodes for linux users ──
nodesRouter.get('/scan-users', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const nodes = await db.node.findMany({
    where: { status: 'ONLINE', id: { notIn: SENTINEL_NODE_IDS } },
    select: { id: true, name: true, ipAddress: true, port: true },
  });

  const results: Record<string, string[]> = {};

  await Promise.allSettled(
    nodes.map(async (node) => {
      try {
        const client = new NodeApiClient({
          baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
          resourceNodeId: node.id,
          nodeToken: getNodeManagerSecret(),
          timeout: 10_000,
        });
        const res = await client.listUsers();
        if (res.success && res.data) {
          for (const username of res.data) {
            if (!results[username]) results[username] = [];
            results[username].push(node.id);
          }
        }
      } catch {
        // Skip unreachable nodes
      }
    }),
  );

  return c.json({ success: true, data: results });
});

// ── Get single node ──
nodesRouter.get('/:nodeId', async (c) => {
  const db = getDb();
  const node = await db.node.findUnique({
    where: { id: c.req.param('nodeId')! },
    include: { agent: true, role: { select: { id: true, name: true } } },
  });
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  const { token: _token, ...safeNode } = node;
  return c.json({ success: true, data: safeNode });
});

// ── Register a new node ──
nodesRouter.post('/register', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const body = await parseBody(c, registerNodeSchema);
  const token = `node-${nanoid()}`;

  const node = await db.node.create({
    data: {
      name: body.name,
      hostname: body.hostname,
      ipAddress: body.ipAddress,
      port: body.port ?? 4100,
      os: body.os ?? 'unknown',
      arch: body.arch ?? 'unknown',
      tags: serializeStringArray(body.tags),
      metadata: serializeRecord(body.metadata as Record<string, unknown> | undefined),
      token,
      status: 'PROVISIONING',
    },
  });

  // Create agent record
  await db.agent.create({
    data: {
      nodeId: node.id,
      version: body.agentVersion ?? AGENT_VERSION,
      status: 'RUNNING',
      capabilities: serializeStringArray([]),
    },
  });

  await logAuditEvent({
    action: 'node.register',
    actorId: user.userId,
    targetType: 'node',
    targetId: node.id,
    details: { name: body.name, hostname: body.hostname },
  });

  return c.json(
    {
      success: true,
      data: {
        nodeId: node.id,
        token,
        controlApiUrl: process.env['CONTROL_API_URL'] ?? 'https://localhost:4000',
      },
    },
    201,
  );
});

// ── Update node ──
nodesRouter.patch('/:nodeId', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const nodeId = c.req.param('nodeId')!;
  const body = await parseBody(c, updateNodeSchema);

  // Build update payload explicitly to satisfy Prisma's union input types
  const data: Record<string, unknown> = {};
  if (body.name) data['name'] = body.name;
  if (body.tags) data['tags'] = serializeStringArray(body.tags);
  if (body.metadata) data['metadata'] = serializeRecord(body.metadata as Record<string, unknown>);
  if (body.status) data['status'] = body.status.toUpperCase();
  if (body.roleId !== undefined) data['roleId'] = body.roleId ?? null;

  const node = await db.node.update({
    where: { id: nodeId },
    data,
  }).catch((err: unknown) => {
    if ((err as { code?: unknown }).code === 'P2025') throw new HttpError(404, 'NOT_FOUND', 'Node not found');
    throw err;
  });
  const { token: _token, ...safeNode } = node;

  await logAuditEvent({
    action: 'node.update',
    actorId: user.userId,
    targetType: 'node',
    targetId: nodeId,
    details: { name: body.name, tags: body.tags, status: body.status },
  });

  return c.json({ success: true, data: safeNode });
});

// ── Repair node address (non-destructive) ──
nodesRouter.post('/:nodeId/repair-address', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const nodeId = c.req.param('nodeId')!;
  const body = await c.req
    .json<NodeAddressRepairRequest>()
    .catch(() => ({} as NodeAddressRepairRequest));

  const node = await db.node.findUnique({ where: { id: nodeId } });
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');

  const targetHostname = (body.hostname ?? node.hostname).trim();
  if (!targetHostname) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'hostname cannot be empty');
  }

  let source: 'manual' | 'dns' | 'existing' = 'existing';
  let resolvedIp: string | null = null;

  if (body.ipAddress !== undefined) {
    const manualIp = normalizeIpAddress(body.ipAddress);
    if (!isUsableNodeIp(manualIp)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'ipAddress must be a valid non-loopback IP');
    }
    resolvedIp = manualIp;
    source = 'manual';
  }

  if (!resolvedIp && (body.resolveDns ?? true)) {
    resolvedIp = await tryResolveHostnameToIp(targetHostname);
    if (resolvedIp) {
      source = 'dns';
    }
  }

  if (!resolvedIp && isUsableNodeIp(node.ipAddress)) {
    resolvedIp = normalizeIpAddress(node.ipAddress);
    source = 'existing';
  }

  if (!resolvedIp) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Unable to determine a routable IP. Provide ipAddress or ensure hostname resolves via DNS.',
    );
  }

  const ipChanged = resolvedIp !== node.ipAddress;
  const hostnameChanged = targetHostname !== node.hostname;

  if (!ipChanged && !hostnameChanged) {
    const { token: _token, ...safeNode } = node;
    return c.json({
      success: true,
      data: {
        changed: false,
        source,
        previousIpAddress: node.ipAddress,
        node: safeNode,
      },
    });
  }

  const updated = await db.node.update({
    where: { id: nodeId },
    data: {
      hostname: targetHostname,
      ipAddress: resolvedIp,
    },
  });

  await logAuditEvent({
    action: 'node.repair_address',
    actorId: user.userId,
    targetType: 'node',
    targetId: nodeId,
    details: {
      hostname: targetHostname,
      previousIpAddress: node.ipAddress,
      newIpAddress: resolvedIp,
      source,
    },
  });

  const { token: _token, ...safeNode } = updated;
  return c.json({
    success: true,
    data: {
      changed: true,
      source,
      previousIpAddress: node.ipAddress,
      node: safeNode,
    },
  });
});

// ── Delete (hard-delete) node ──
nodesRouter.delete('/:nodeId', requireRole('ADMIN'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const nodeId = c.req.param('nodeId')!;

  const existing = await db.node.findUnique({ where: { id: nodeId } });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Node not found');

  // Delete related records in dependency order
  await deleteNodeCascade(nodeId);

  await logAuditEvent({
    action: 'node.decommission',
    actorId: user.userId,
    targetType: 'node',
    targetId: nodeId,
    details: { name: existing.name, hostname: existing.hostname, hardDelete: true },
  });

  return c.json({ success: true, data: { deleted: true } });
});

/** Convert BigInt fields in a health snapshot to numbers for JSON serialization. */
function serializeSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    result[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return result;
}

function parseGpuDevices(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const GPU_PERIOD_MS: Record<string, number> = {
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

// ── GPU history (30-second storage; seven-day responses use five-minute buckets) ──
nodesRouter.get('/:nodeId/gpu', async (c) => {
  const db = getDb();
  const nodeId = c.req.param('nodeId')!;
  const period = c.req.query('period') ?? '24h';
  const periodMs = GPU_PERIOD_MS[period];
  if (!periodMs) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'period must be 6h, 24h, or 7d');
  }

  const snapshots = await db.gpuSnapshot.findMany({
    where: { nodeId, sampledAt: { gte: new Date(Date.now() - periodMs) } },
    orderBy: { sampledAt: 'asc' },
    take: 21_000,
  });
  const fullHistory = snapshots.map((snapshot) => ({
    sampledAt: snapshot.sampledAt,
    sampleIntervalSeconds: snapshot.sampleIntervalSeconds,
    status: snapshot.status,
    devices: parseGpuDevices(snapshot.devices),
    maxUtilizationPercent: snapshot.maxUtilizationPercent,
    maxFanPercent: snapshot.maxFanPercent,
  }));
  const history = period === '7d'
    ? [...fullHistory.reduce((buckets, point) => {
        const bucket = Math.floor(new Date(point.sampledAt).getTime() / (5 * 60 * 1000));
        buckets.set(bucket, point);
        return buckets;
      }, new Map<number, (typeof fullHistory)[number]>()).values()]
    : fullHistory;

  return c.json({
    success: true,
    data: {
      period,
      latest: fullHistory.at(-1) ?? null,
      history,
    },
  });
});

// ── Get node health (latest snapshot) ──
nodesRouter.get('/:nodeId/health', async (c) => {
  const db = getDb();
  const nodeId = c.req.param('nodeId')!;

  const snapshot = await db.healthSnapshot.findFirst({
    where: { nodeId },
    orderBy: { timestamp: 'desc' },
  });

  if (!snapshot) throw new HttpError(404, 'NOT_FOUND', 'No health data available');
  return c.json({ success: true, data: serializeSnapshot(snapshot as unknown as Record<string, unknown>) });
});

// ── Get latest Wazuh posture for one node ──
nodesRouter.get('/:nodeId/wazuh', async (c) => {
  const db = getDb();
  const nodeId = c.req.param('nodeId')!;
  const snapshot = await db.healthSnapshot.findFirst({
    where: { nodeId },
    orderBy: { timestamp: 'desc' },
    select: { nodeId: true, timestamp: true, wazuh: true },
  });

  if (!snapshot) throw new HttpError(404, 'NOT_FOUND', 'No health data available');
  return c.json({
    success: true,
    data: {
      nodeId: snapshot.nodeId,
      observedAt: snapshot.timestamp,
      wazuh: parseWazuhPosture(snapshot.wazuh),
    },
  });
});

// ── Health history ──
nodesRouter.get('/:nodeId/health/history', async (c) => {
  const db = getDb();
  const nodeId = c.req.param('nodeId')!;
  const limit = Math.min(Number(c.req.query('limit') ?? '100'), 500);

  const snapshots = await db.healthSnapshot.findMany({
    where: { nodeId },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });

  return c.json({ success: true, data: snapshots.map((s) => serializeSnapshot(s as unknown as Record<string, unknown>)) });
});

// ── Health time-series for charting ──
const PERIOD_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

type MetricName = 'cpu' | 'memory' | 'swap' | 'disk';

function extractMetric(snapshot: Record<string, unknown>, metric: MetricName): number {
  switch (metric) {
    case 'cpu': return Number(snapshot.cpuUsagePercent ?? 0);
    case 'memory': return Number(snapshot.memoryPercent ?? 0);
    case 'swap': {
      const total = Number(snapshot.swapTotalBytes ?? 0);
      const used = Number(snapshot.swapUsedBytes ?? 0);
      return total > 0 ? (used / total) * 100 : 0;
    }
    case 'disk': {
      try {
        const disks = typeof snapshot.disks === 'string' ? JSON.parse(snapshot.disks) : snapshot.disks;
        if (Array.isArray(disks) && disks.length > 0) {
          return disks[0].usePercent ?? 0;
        }
      } catch { /* ignore */ }
      return 0;
    }
  }
}

nodesRouter.get('/:nodeId/health/timeseries', async (c) => {
  const db = getDb();
  const nodeId = c.req.param('nodeId')!;
  const metric = (c.req.query('metric') ?? 'cpu') as MetricName;
  const period = c.req.query('period') ?? '1h';

  if (!['cpu', 'memory', 'swap', 'disk'].includes(metric)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'metric must be cpu, memory, swap, or disk');
  }

  const periodMs = PERIOD_MS[period];
  if (!periodMs) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'period must be 1h, 6h, 24h, 7d, or 30d');
  }

  const since = new Date(Date.now() - periodMs);

  // Load only the timestamp and the columns the requested metric reads.
  const snapshots = await db.healthSnapshot.findMany({
    where: { nodeId, timestamp: { gte: since } },
    orderBy: { timestamp: 'asc' },
    select: {
      timestamp: true,
      cpuUsagePercent: metric === 'cpu',
      memoryPercent: metric === 'memory',
      swapTotalBytes: metric === 'swap',
      swapUsedBytes: metric === 'swap',
      disks: metric === 'disk',
    },
  });

  if (snapshots.length === 0) {
    return c.json({
      success: true,
      data: { timestamps: [], values: [], min: 0, max: 0, avg: 0 },
    });
  }

  // For periods > 24h, downsample to 5-minute averages
  const shouldDownsample = periodMs > 24 * 60 * 60 * 1000;
  const windowMs = shouldDownsample ? 5 * 60 * 1000 : 0;

  if (shouldDownsample) {
    const buckets = new Map<number, { sum: number; count: number }>();

    for (const snap of snapshots) {
      const ts = snap.timestamp.getTime();
      const bucketKey = Math.floor(ts / windowMs) * windowMs;
      const value = extractMetric(snap as unknown as Record<string, unknown>, metric);
      const existing = buckets.get(bucketKey);
      if (existing) {
        existing.sum += value;
        existing.count++;
      } else {
        buckets.set(bucketKey, { sum: value, count: 1 });
      }
    }

    const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
    const timestamps = sortedKeys.map((k) => new Date(k).toISOString());
    const values = sortedKeys.map((k) => {
      const b = buckets.get(k)!;
      return Math.round((b.sum / b.count) * 100) / 100;
    });

    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

    return c.json({ success: true, data: { timestamps, values, min, max, avg } });
  }

  // Raw data for short periods
  const timestamps = snapshots.map((s) => s.timestamp.toISOString());
  const values = snapshots.map((s) =>
    Math.round(extractMetric(s as unknown as Record<string, unknown>, metric) * 100) / 100,
  );

  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

  return c.json({ success: true, data: { timestamps, values, min, max, avg } });
});

// The legacy migration path embedded credentials in an unverified remote shell,
// restarted only part of the agent environment, and deleted inventory before a
// verified heartbeat/command proof. Reviewed key-only deployment scripts are the
// sole migration path until the agent API provides a transactional equivalent.
nodesRouter.post('/:nodeId/migrate', requireRole('ADMIN'), (c) => c.json({
  success: false,
  error: {
    code: 'NODE_MIGRATION_RETIRED',
    message: 'In-band node migration is retired; use the reviewed key-only agent deployment runbook.',
  },
}, 410));

// ── Provision user on a specific node ──
nodesRouter.post('/:nodeId/provision-user', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const nodeId = c.req.param('nodeId')!;
  const body = await c.req.json<{ username: string; password: string; group?: string }>();

  const node = await db.node.findUnique({ where: { id: nodeId } });
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');

  const client = new NodeApiClient({
    baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
    resourceNodeId: node.id,
    nodeToken: getNodeManagerSecret(),
  });

  const result = await client.provisionUser({
    username: body.username,
    password: body.password,
    group: body.group,
  });

  await logAuditEvent({
    action: 'node.provision_user',
    actorId: user.userId,
    ipAddress: c.req.header('x-forwarded-for') ?? 'unknown',
    targetType: 'node',
    targetId: nodeId,
    details: { username: body.username, nodeId },
  });

  return c.json(result);
});

// ── Change user password on a specific node ──
nodesRouter.post('/:nodeId/change-password', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const nodeId = c.req.param('nodeId')!;
  const body = await c.req.json<{ username: string; password: string }>();

  const node = await db.node.findUnique({ where: { id: nodeId } });
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');

  const client = new NodeApiClient({
    baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
    resourceNodeId: node.id,
    nodeToken: getNodeManagerSecret(),
  });

  const result = await client.changeUserPassword({
    username: body.username,
    password: body.password,
  });

  await logAuditEvent({
    action: 'node.change_password',
    actorId: user.userId,
    ipAddress: c.req.header('x-forwarded-for') ?? 'unknown',
    targetType: 'node',
    targetId: nodeId,
    details: { username: body.username, nodeId },
  });

  return c.json(result);
});
