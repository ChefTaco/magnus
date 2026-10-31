/**
 * ai-tools.ts — Tool system for the AI Fleet Operations Assistant.
 *
 * Provides read-only fleet data access and memory management tools
 * that the AI can invoke during conversations.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { getFleetAnomalySummary, listAnomalyEvents } from './anomaly-detector.js';
import { queryAuditEvents } from './audit-service.js';
import { logAuditEvent } from './audit-service.js';
import { listSkills, getSkill, getSkillFile, createSkill } from './skill-service.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { correlateAnomalies, getAnomalyTimeline } from './ai-correlation-service.js';
import { getHiveMemClient } from './hivemem-client.js';
import {
  aliasScratchpadEntry,
  compareScratchpadSnapshots,
  listScratchpadEntries,
  setScratchpadEntry,
  transformScratchpadData,
} from './ai-scratchpad-service.js';
import {
  getDependencyHealth,
  getFleetReadiness,
  getFleetTimeline,
  getPredictiveMaintenance,
  getIncidentSummary,
  classifyRemediationPlan,
  getHermesEffectiveState,
  getPackageSecurityPosture,
} from './ops-service.js';
import { getCodexFleetPosture } from './codex-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, '../..');

// ── Types ──

export interface AiToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AiToolResult {
  name: string;
  success: boolean;
  result: unknown;
  error?: string;
}

// ── Tool registry ──

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const toolRegistry = new Map<string, ToolHandler>();

function registerTool(name: string, handler: ToolHandler): void {
  toolRegistry.set(name, handler);
}

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
      typeof parsed.rebootRequired !== 'boolean' ||
      !Array.isArray(parsed.rebootRequiredPackages)
    ) return null;
    return parsed as SystemUpdatePosture;
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

// ── Fleet Health Tools ──

registerTool('getFleetStatus', async () => {
  const db = getDb();
  const nodes = await db.node.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      hostname: true,
      ipAddress: true,
      status: true,
      os: true,
      arch: true,
      lastHeartbeatAt: true,
    },
  });
  return { nodeCount: nodes.length, nodes, codex: getCodexFleetPosture() };
});

registerTool('getCodexFleetStatus', async () => ({
  evidence: ['/api/v1/ops/codex-fleet-status'],
  data: getCodexFleetPosture(),
}));

registerTool('getFleetReadiness', async () => ({
  evidence: ['/api/v1/ops/readiness'],
  data: await getFleetReadiness(),
}));

registerTool('getDependencyHealth', async () => ({
  evidence: ['/api/v1/ops/dependency-health'],
  data: await getDependencyHealth(),
}));

registerTool('getFleetTimeline', async (args) => ({
  evidence: ['/api/v1/ops/timeline', '/api/v1/audit', '/api/v1/logs'],
  data: await getFleetTimeline(Math.min(Number(args['limit'] ?? 80), 200)),
}));

registerTool('getKnownFailurePatterns', async () => ({
  evidence: ['Magnus operational memory and current ops checklists'],
  patterns: [
    {
      symptom: 'Agent health is green but node is absent or heartbeat returns 401',
      likelyCause: 'NODE_MANAGER_SECRET drift between host agent and live Control API',
      firstChecks: ['Compare non-secret fingerprints', 'restart magnus-agent', 'wait for accepted heartbeat'],
    },
    {
      symptom: 'Nodes or Hermes skill counts look stale',
      likelyCause: 'Agent discovery heartbeat drift or loose Hermes skill parsing',
      firstChecks: ['Run hermes skills list on host', 'compare skills.disabled', 'refresh agent heartbeat'],
    },
    {
      symptom: 'Transient node list or stats failure',
      likelyCause: 'PostgreSQL connection pressure or a slow retained-health query',
      firstChecks: ['Inspect database dependency latency', 'inspect dbReadRetries metric', 'check heartbeat write volume'],
    },
  ],
  predictiveMaintenance: await getPredictiveMaintenance(),
}));

registerTool('summarizeIncident', async (args) => ({
  evidence: ['/api/v1/ops/incident-summary', '/api/v1/logs', '/api/v1/anomalies', '/api/v1/commands', '/api/v1/notifications'],
  data: await getIncidentSummary(
    args['nodeId'] ? String(args['nodeId']) : undefined,
    Math.min(Number(args['hours'] ?? 24), 168),
  ),
}));

registerTool('classifyRemediationPlan', async (args) => ({
  evidence: ['/api/v1/ops/remediation-plan/classify'],
  data: classifyRemediationPlan(String(args['description'] ?? '')),
}));

registerTool('getHermesEffectiveState', async () => ({
  evidence: ['/api/v1/ops/hermes-effective-state', 'on-host hermes skills list for final proof'],
  data: await getHermesEffectiveState(),
}));

registerTool('getPackageSecurityPosture', async () => ({
  evidence: ['/api/v1/ops/package-security-posture'],
  data: await getPackageSecurityPosture(),
}));

registerTool('getNodeHealth', async (args) => {
  const db = getDb();
  const nodeId = String(args['nodeId'] ?? '');
  if (!nodeId) return { error: 'nodeId is required' };

  const snapshot = await db.healthSnapshot.findFirst({
    where: { nodeId },
    orderBy: { timestamp: 'desc' },
    include: { node: { select: { name: true, hostname: true, status: true } } },
  });

  if (!snapshot) return { error: 'No health data for this node' };

  return {
    node: snapshot.node,
    timestamp: snapshot.timestamp.toISOString(),
    cpu: {
      usagePercent: snapshot.cpuUsagePercent,
      cores: snapshot.cpuCores,
      loadAverage: snapshot.cpuLoadAverage,
    },
    memory: {
      usedBytes: Number(snapshot.memoryUsedBytes),
      totalBytes: Number(snapshot.memoryTotalBytes),
      percent: snapshot.memoryPercent,
      swapUsed: Number(snapshot.swapUsedBytes),
      swapTotal: Number(snapshot.swapTotalBytes),
    },
    disks: JSON.parse(snapshot.disks),
    network: JSON.parse(snapshot.network),
    services: JSON.parse(snapshot.services),
    wazuh: parseWazuhPosture(snapshot.wazuh),
    systemUpdates: parseSystemUpdatePosture(snapshot.systemUpdates),
    cockpitAvailable: snapshot.cockpitAvailable,
  };
});

registerTool('getWazuhFleetStatus', async () => {
  const db = getDb();
  const nodes = await db.node.findMany({
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
      lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
      observedAt: snapshot?.timestamp.toISOString() ?? null,
      wazuh: snapshot ? parseWazuhPosture(snapshot.wazuh) : null,
    };
  });

  return {
    total: inventory.length,
    reporting: inventory.filter((node) => node.wazuh !== null).length,
    installed: inventory.filter((node) => node.wazuh?.installed).length,
    active: inventory.filter((node) => node.wazuh?.serviceStatus === 'active').length,
    failed: inventory.filter((node) => node.wazuh?.serviceStatus === 'failed').length,
    nodes: inventory,
  };
});

registerTool('getSystemUpdateFleetStatus', async () => {
  const db = getDb();
  const nodes = await db.node.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, hostname: true, status: true, lastHeartbeatAt: true,
      healthSnapshots: {
        orderBy: { timestamp: 'desc' }, take: 1,
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
      lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
      observedAt: snapshot?.timestamp.toISOString() ?? null,
      systemUpdates: snapshot ? parseSystemUpdatePosture(snapshot.systemUpdates) : null,
    };
  });
  return {
    total: inventory.length,
    reporting: inventory.filter((node) => node.systemUpdates !== null).length,
    enabled: inventory.filter((node) => node.systemUpdates?.automaticUpdates === 'enabled').length,
    actionNeeded: inventory.filter((node) => ['disabled', 'partial'].includes(node.systemUpdates?.automaticUpdates ?? '')).length,
    rebootRequired: inventory.filter((node) => node.systemUpdates?.rebootRequired).length,
    nodes: inventory,
  };
});

registerTool('getHealthHistory', async (args) => {
  const db = getDb();
  const nodeId = String(args['nodeId'] ?? '');
  const hours = Number(args['hours'] ?? 24);
  if (!nodeId) return { error: 'nodeId is required' };

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const snapshots = await db.healthSnapshot.findMany({
    where: { nodeId, timestamp: { gte: since } },
    orderBy: { timestamp: 'asc' },
    select: {
      timestamp: true,
      cpuUsagePercent: true,
      memoryPercent: true,
      disks: true,
    },
  });

  return {
    nodeId,
    hours,
    count: snapshots.length,
    snapshots: snapshots.map((s) => ({
      timestamp: s.timestamp.toISOString(),
      cpu: s.cpuUsagePercent,
      memory: s.memoryPercent,
      maxDisk: Math.max(0, ...(JSON.parse(s.disks) as Array<{ usagePercent?: number }>).map((d) => d.usagePercent ?? 0)),
    })),
  };
});

// ── Anomaly Tools ──

registerTool('getActiveAnomalies', async () => {
  return getFleetAnomalySummary();
});

registerTool('getNodeAnomalies', async (args) => {
  const nodeId = String(args['nodeId'] ?? '');
  if (!nodeId) return { error: 'nodeId is required' };

  const result = await listAnomalyEvents({ nodeId, resolved: false, pageSize: 20 });
  return result;
});

// ── Alert Tools ──

registerTool('getActiveAlerts', async () => {
  const db = getDb();
  const violations = await db.alertViolation.findMany({
    where: { status: 'active' },
    include: {
      rule: { select: { name: true, metric: true, operator: true, threshold: true } },
      node: { select: { name: true, hostname: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return {
    count: violations.length,
    violations: violations.map((v) => ({
      id: v.id,
      node: v.node.name,
      rule: v.rule.name,
      metric: v.metric,
      value: v.value,
      threshold: v.threshold,
      severity: v.severity,
      createdAt: v.createdAt.toISOString(),
    })),
  };
});

// ── Command Tools ──

registerTool('getRecentCommands', async (args) => {
  const db = getDb();
  const hours = Number(args['hours'] ?? 1);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const commands = await db.remoteCommand.findMany({
    where: { createdAt: { gte: since } },
    include: {
      node: { select: { name: true } },
      result: { select: { exitCode: true, durationMs: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  return {
    count: commands.length,
    commands: commands.map((c) => ({
      id: c.id,
      node: c.node.name,
      command: c.command,
      status: c.status,
      exitCode: c.result?.exitCode,
      duration: c.result?.durationMs,
      createdAt: c.createdAt.toISOString(),
    })),
  };
});

// ── Log Tools ──

registerTool('getNodeLogs', async (args) => {
  const db = getDb();
  const nodeId = String(args['nodeId'] ?? '');
  const lines = Math.min(Number(args['lines'] ?? 50), 200);
  if (!nodeId) return { error: 'nodeId is required' };

  const logs = await db.logEntry.findMany({
    where: { nodeId },
    orderBy: { timestamp: 'desc' },
    take: lines,
    select: {
      source: true,
      level: true,
      message: true,
      timestamp: true,
    },
  });

  return { count: logs.length, logs };
});

// ── File Tools ──

function isPathSafe(targetPath: string): boolean {
  const resolved = resolve(WORKSPACE_ROOT, targetPath);
  const rel = relative(WORKSPACE_ROOT, resolved);
  // Must stay within workspace and not traverse up
  if (rel.startsWith('..') || resolve(resolved) !== resolved) return false;
  // Block access to sensitive files
  const blocked = ['.env', 'node_modules', '.git', 'prisma/magnus.db'];
  return !blocked.some((b) => rel.includes(b));
}

registerTool('readFile', async (args) => {
  const filePath = String(args['path'] ?? '');
  if (!filePath) return { error: 'path is required' };

  const resolved = resolve(WORKSPACE_ROOT, filePath);
  if (!isPathSafe(filePath)) {
    return { error: 'Access denied: path is outside workspace or blocked' };
  }

  try {
    const stats = await stat(resolved);
    if (stats.size > 1024 * 1024) return { error: 'File too large (>1MB)' };
    if (!stats.isFile()) return { error: 'Not a regular file' };

    const content = await readFile(resolved, 'utf-8');
    return { path: filePath, size: stats.size, content };
  } catch (err) {
    return { error: `Cannot read file: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
});

registerTool('writeFile', async (args) => {
  const filePath = String(args['path'] ?? '');
  const content = String(args['content'] ?? '');
  if (!filePath) return { error: 'path is required' };

  const resolved = resolve(WORKSPACE_ROOT, filePath);
  if (!isPathSafe(filePath)) {
    return { error: 'Access denied: path is outside workspace or blocked' };
  }

  // Only allow writing to specific directories
  const allowedPrefixes = ['audit-logs/', 'src/ai/', 'skills/'];
  const rel = relative(WORKSPACE_ROOT, resolved);
  const normalizedRel = normalize(rel);
  if (!allowedPrefixes.some((p) => normalizedRel.startsWith(p))) {
    return { error: `Write access restricted. Allowed directories: ${allowedPrefixes.join(', ')}` };
  }

  try {
    await writeFile(resolved, content, 'utf-8');
    return { path: filePath, written: true, size: content.length };
  } catch (err) {
    return { error: `Cannot write file: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
});

registerTool('listDirectory', async (args) => {
  const dirPath = String(args['path'] ?? '.');
  const resolved = resolve(WORKSPACE_ROOT, dirPath);
  if (!isPathSafe(dirPath)) {
    return { error: 'Access denied: path is outside workspace or blocked' };
  }

  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith('.'))
        .slice(0, 100)
        .map(async (e) => {
          const fullPath = resolve(resolved, e.name);
          try {
            const s = await stat(fullPath);
            return {
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              size: s.size,
              modified: s.mtime.toISOString(),
            };
          } catch {
            return { name: e.name, type: e.isDirectory() ? 'directory' : 'file' };
          }
        }),
    );
    return { path: dirPath, count: items.length, entries: items };
  } catch (err) {
    return { error: `Cannot list directory: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
});

// ── Memory Tools (backed by HiveMem) ──

registerTool('storeMemory', async (args) => {
  const key = String(args['key'] ?? '');
  const content = String(args['content'] ?? '');
  const category = String(args['category'] ?? 'general');

  if (!key || !content) return { error: 'key and content are required' };

  const hivemem = getHiveMemClient();
  if (!hivemem.configured) return { error: 'HiveMem not configured' };

  try {
    const record = await hivemem.storeMemory({
      content: `[${category}] ${key}: ${content}`,
      type: 'semantic',
      scope: 'shared',
      source: 'magnus-api',
      tags: [category, key],
    });
    return { stored: true, id: record.id, key };
  } catch (err) {
    return { error: `Failed to store memory: ${err instanceof Error ? err.message : 'unknown'}` };
  }
});

registerTool('recallMemories', async (args) => {
  const category = args['category'] ? String(args['category']) : undefined;
  const limit = Math.min(Number(args['limit'] ?? 20), 50);

  const hivemem = getHiveMemClient();
  if (!hivemem.configured) return { count: 0, memories: [] };

  try {
    const query = category ? `category:${category}` : 'fleet node pattern preference';
    const results = await hivemem.searchMemories(query, limit);
    return {
      count: results.length,
      memories: results.map((r) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        type: r.type,
        tags: r.tags,
        createdAt: r.created_at,
      })),
    };
  } catch (err) {
    return { error: `Failed to recall memories: ${err instanceof Error ? err.message : 'unknown'}` };
  }
});

registerTool('forgetMemory', async (args) => {
  const id = String(args['key'] ?? args['id'] ?? '');
  if (!id) return { error: 'key or id is required' };

  const hivemem = getHiveMemClient();
  if (!hivemem.configured) return { error: 'HiveMem not configured' };

  try {
    await hivemem.deleteMemory(id);
    return { forgotten: true, id };
  } catch {
    return { error: 'Memory not found' };
  }
});

// ── Execution Tools ──

registerTool('execCommand', async (args) => {
  const db = getDb();
  const nodeId = String(args['nodeId'] ?? '');
  const command = String(args['command'] ?? '');
  const argsArr = Array.isArray(args['args']) ? (args['args'] as string[]).map(String) : [];
  const workingDirectory = args['workingDirectory'] ? String(args['workingDirectory']) : undefined;
  const timeoutSeconds = Math.min(Number(args['timeoutSeconds'] ?? 60), 120);

  if (!nodeId) return { error: 'nodeId is required' };
  if (!command) return { error: 'command is required' };

  // Block dangerous commands
  const blocked = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'shutdown', 'reboot', 'init 0', 'init 6', 'halt', 'poweroff'];
  const fullCmd = [command, ...argsArr].join(' ').toLowerCase();
  if (blocked.some((b) => fullCmd.includes(b))) {
    return { error: 'Command blocked: potentially destructive operation' };
  }

  const node = await db.node.findUnique({ where: { id: nodeId } });
  if (!node) return { error: 'Node not found' };
  if (node.status !== 'ONLINE') return { error: `Node is ${node.status}, must be ONLINE` };

  const commandId = `cmd-${nanoid()}`;
  try {
    const client = new NodeApiClient({
      baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
      resourceNodeId: nodeId, resourceActorId: 'system:ai-assistant',
      nodeToken: getNodeManagerSecret(),
      timeout: (timeoutSeconds + 5) * 1_000,
    });

    const rawResponse = await client.executeCommand({
      commandId,
      command,
      args: argsArr,
      workingDirectory,
      timeoutSeconds,
    });

    const result = rawResponse.data;

    await logAuditEvent({
      action: 'command.ai_exec',
      actorId: 'ai-assistant',
      actorType: 'system',
      targetType: 'node',
      targetId: nodeId,
      details: { command, args: argsArr, exitCode: result.exitCode, durationMs: result.durationMs },
    });

    return {
      node: node.name,
      command,
      args: argsArr,
      exitCode: result.exitCode,
      stdout: result.stdout?.slice(0, 8192) ?? '',
      stderr: result.stderr?.slice(0, 4096) ?? '',
      durationMs: result.durationMs,
    };
  } catch (err) {
    return { error: `Execution failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
});

// ── Search Tools ──

registerTool('searchNodes', async (args) => {
  const db = getDb();
  const query = String(args['query'] ?? '');
  const status = args['status'] ? String(args['status']).toUpperCase() : undefined;

  if (!query && !status) return { error: 'query or status is required' };

  const where: Record<string, unknown> = {};
  if (status) where['status'] = status;
  if (query) {
    where['OR'] = [
      { name: { contains: query } },
      { hostname: { contains: query } },
      { ipAddress: { contains: query } },
      { os: { contains: query } },
    ];
  }

  const nodes = await db.node.findMany({
    where,
    orderBy: { name: 'asc' },
    take: 50,
    select: {
      id: true,
      name: true,
      hostname: true,
      ipAddress: true,
      status: true,
      os: true,
      arch: true,
      lastHeartbeatAt: true,
    },
  });

  return { count: nodes.length, query: query || undefined, status: status || undefined, nodes };
});

// ── Cron Tools ──

registerTool('getCronJobs', async (args) => {
  const db = getDb();
  const nodeId = args['nodeId'] ? String(args['nodeId']) : undefined;

  const where: Record<string, unknown> = {};
  if (nodeId) where['nodeId'] = nodeId;

  const jobs = await db.cronJob.findMany({
    where,
    orderBy: { name: 'asc' },
    take: 100,
    include: {
      node: { select: { name: true } },
    },
  });

  return {
    count: jobs.length,
    jobs: jobs.map((j) => ({
      id: j.id,
      node: j.node.name,
      nodeId: j.nodeId,
      name: j.name,
      schedule: j.schedule,
      command: j.command,
      status: j.status,
      lastRunAt: j.lastRunAt?.toISOString() ?? null,
      lastRunExitCode: j.lastRunExitCode,
      createdAt: j.createdAt.toISOString(),
    })),
  };
});

// ── Skill Tools ──

registerTool('getSkills', async () => {
  const skills = await listSkills();
  return {
    count: skills.length,
    skills: skills.map((s) => ({
      name: s.name,
      version: s.version,
      description: s.description,
      author: s.author,
      tags: s.tags,
      entryPoint: s.entryPoint,
      files: s.files,
    })),
  };
});

// ── Statistics Tools ──

registerTool('getDashboardStats', async () => {
  const db = getDb();

  const [
    totalNodes,
    onlineNodes,
    offlineNodes,
    degradedNodes,
    totalCommands,
    runningCommands,
    pendingCommands,
    totalCronJobs,
    activeCronJobs,
  ] = await Promise.all([
    db.node.count(),
    db.node.count({ where: { status: 'ONLINE' } }),
    db.node.count({ where: { status: 'OFFLINE' } }),
    db.node.count({ where: { status: 'DEGRADED' } }),
    db.remoteCommand.count(),
    db.remoteCommand.count({ where: { status: 'RUNNING' } }),
    db.remoteCommand.count({ where: { status: 'PENDING' } }),
    db.cronJob.count(),
    db.cronJob.count({ where: { status: 'ACTIVE' } }),
  ]);

  // Avg CPU/memory from latest health per online node
  const latestHealth = await db.healthSnapshot.findMany({
    where: { node: { status: 'ONLINE' } },
    orderBy: { timestamp: 'desc' },
    distinct: ['nodeId'],
    select: { cpuUsagePercent: true, memoryPercent: true },
  });

  const avgCpu = latestHealth.length > 0
    ? Math.round((latestHealth.reduce((s, h) => s + h.cpuUsagePercent, 0) / latestHealth.length) * 10) / 10
    : null;
  const avgMemory = latestHealth.length > 0
    ? Math.round((latestHealth.reduce((s, h) => s + h.memoryPercent, 0) / latestHealth.length) * 10) / 10
    : null;

  return {
    nodes: { total: totalNodes, online: onlineNodes, offline: offlineNodes, degraded: degradedNodes },
    commands: { total: totalCommands, running: runningCommands, pending: pendingCommands },
    cron: { total: totalCronJobs, active: activeCronJobs },
    health: { avgCpuPercent: avgCpu, avgMemoryPercent: avgMemory, reportingNodes: latestHealth.length },
  };
});

// ── Audit Tools ──

registerTool('getAuditLog', async (args) => {
  const date = args['date'] ? String(args['date']) : undefined;
  const action = args['action'] ? String(args['action']) : undefined;
  const limit = Math.min(Number(args['limit'] ?? 25), 100);

  const result = await queryAuditEvents({ date, action, pageSize: limit });
  return {
    date: date ?? new Date().toISOString().slice(0, 10),
    total: result.total,
    count: result.events.length,
    events: result.events.map((e) => ({
      id: e.id,
      action: e.action,
      actorId: e.actorId,
      actorType: e.actorType,
      targetType: e.targetType,
      targetId: e.targetId,
      timestamp: e.timestamp,
    })),
  };
});

// ── Node Details Tools ──

registerTool('getNodeDetails', async (args) => {
  const db = getDb();
  const nodeId = String(args['nodeId'] ?? '');
  const includeSoftwareVersions = args['includeSoftwareVersions'] === true;

  if (!nodeId) return { error: 'nodeId is required' };

  const node = await db.node.findUnique({
    where: { id: nodeId },
    include: {
      agent: true,
      healthSnapshots: {
        orderBy: { timestamp: 'desc' },
        take: 1,
      },
    },
  });

  if (!node) return { error: 'Node not found' };

  const latestHealth = node.healthSnapshots[0] ?? null;

  const result: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    hostname: node.hostname,
    ipAddress: node.ipAddress,
    port: node.port,
    status: node.status,
    os: node.os,
    arch: node.arch,
    tags: node.tags ? JSON.parse(node.tags as string) : [],
    metadata: node.metadata ? JSON.parse(node.metadata as string) : {},
    lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
    agent: node.agent ? {
      id: node.agent.id,
      version: node.agent.version,
      status: node.agent.status,
      pid: node.agent.pid,
      startedAt: node.agent.startedAt?.toISOString() ?? null,
      capabilities: node.agent.capabilities ? JSON.parse(node.agent.capabilities as string) : [],
    } : null,
    health: latestHealth ? {
      timestamp: latestHealth.timestamp.toISOString(),
      cpu: {
        usagePercent: latestHealth.cpuUsagePercent,
        cores: latestHealth.cpuCores,
        loadAverage: latestHealth.cpuLoadAverage,
      },
      memory: {
        usedBytes: Number(latestHealth.memoryUsedBytes),
        totalBytes: Number(latestHealth.memoryTotalBytes),
        percent: latestHealth.memoryPercent,
      },
      disks: JSON.parse(latestHealth.disks),
      network: JSON.parse(latestHealth.network),
      services: JSON.parse(latestHealth.services),
      wazuh: parseWazuhPosture(latestHealth.wazuh),
      systemUpdates: parseSystemUpdatePosture(latestHealth.systemUpdates),
    } : null,
  };

  // Optionally fetch live software versions via quick command
  if (includeSoftwareVersions && node.status === 'ONLINE') {
    try {
      const client = new NodeApiClient({
        baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
      resourceNodeId: nodeId, resourceActorId: 'system:ai-assistant',
        nodeToken: getNodeManagerSecret(),
        timeout: 30_000,
      });

      const versionCmd = [
        'echo "NODE_VERSION=$(node --version 2>/dev/null || echo N/A)"',
        'echo "NPM_VERSION=$(npm --version 2>/dev/null || echo N/A)"',
        'echo "PYTHON_VERSION=$(python3 --version 2>/dev/null || echo N/A)"',
        'echo "KERNEL=$(uname -r)"',
        'echo "REDIS_VERSION=$(redis-server --version 2>/dev/null | head -1 || echo N/A)"',
        'echo "DOCKER_VERSION=$(docker --version 2>/dev/null || echo N/A)"',
        'echo "UPTIME=$(uptime -p 2>/dev/null || uptime)"',
        'apt list --upgradable 2>/dev/null | tail -n +2 | head -20 || true',
      ].join(' && ');

      const rawResponse = await client.executeCommand({
        commandId: `cmd-${nanoid()}`,
        command: 'bash',
        args: ['-c', versionCmd],
        timeoutSeconds: 20,
      });

      result['softwareVersions'] = rawResponse.data.stdout ?? '';
      result['softwareVersionsExitCode'] = rawResponse.data.exitCode;
    } catch (err) {
      result['softwareVersions'] = null;
      result['softwareVersionsError'] = err instanceof Error ? err.message : 'Failed to fetch';
    }
  }

  return result;
});

// ── Skill Execution Tools ──

registerTool('runSkill', async (args) => {
  const nodeId = String(args['nodeId'] ?? '');
  const skillName = String(args['skillName'] ?? '');
  const action = String(args['action'] ?? 'run');

  if (!nodeId || !skillName) return { error: 'nodeId and skillName are required' };

  const db = getDb();
  const node = await db.node.findUnique({
    where: { id: nodeId },
    select: { ipAddress: true, port: true, status: true },
  });
  if (!node) return { error: 'Node not found' };
  if (node.status !== 'ONLINE') return { error: `Node is ${node.status}, cannot execute skill` };

  // Verify skill exists
  const skill = await getSkill(skillName);
  if (!skill) return { error: `Skill "${skillName}" not found` };

  // Execute via agent
  const client = new NodeApiClient({
    baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
      resourceNodeId: nodeId, resourceActorId: 'system:ai-assistant',
    nodeToken: getNodeManagerSecret(),
    timeout: 120_000,
  });

  const result = await client.executeCommand({
    commandId: `cmd-${nanoid()}`,
    command: 'bash',
    args: ['-c', `cd /opt/magnus/skills/${skillName} && bash ${action}.sh`],
    timeoutSeconds: 90,
  });

  await logAuditEvent({
    action: 'command.ai_exec',
    actorId: 'ai-assistant',
    actorType: 'system',
    targetType: 'skill',
    targetId: `${nodeId}/${skillName}`,
    details: { action, exitCode: result.data.exitCode },
  });

  return {
    skillName,
    action,
    nodeId,
    exitCode: result.data.exitCode,
    stdout: (result.data.stdout ?? '').slice(0, 4000),
    stderr: (result.data.stderr ?? '').slice(0, 2000),
  };
});

// ── Cross-Fleet Correlation Tools ──

registerTool('correlateAnomalies', async (args) => {
  const windowMinutes = Number(args['windowMinutes'] ?? 5);
  const includeResolved = args['includeResolved'] === true;

  const groups = await correlateAnomalies({ windowMinutes, includeResolved });

  return {
    totalGroups: groups.length,
    groups: groups.map(g => ({
      id: g.id,
      pattern: g.pattern,
      timeWindow: g.timeWindow,
      affectedNodes: g.affectedNodes,
      metrics: g.metrics,
      anomalyCount: g.anomalies.length,
      relatedCommandCount: g.relatedCommands.length,
      anomalies: g.anomalies.slice(0, 10),
      relatedCommands: g.relatedCommands.slice(0, 5),
    })),
  };
});

registerTool('getAnomalyTimeline', async (args) => {
  const hours = Number(args['hours'] ?? 24);
  const nodeId = args['nodeId'] ? String(args['nodeId']) : undefined;
  return getAnomalyTimeline({ hours, nodeId });
});

// ── Skill Authoring Tools ──

registerTool('createSkillDraft', async (args) => {
  const name = String(args['name'] ?? '');
  const description = String(args['description'] ?? '');
  const tags = (args['tags'] as string[] | undefined) ?? [];
  const scriptContent = String(args['scriptContent'] ?? '#!/usr/bin/env bash\nset -euo pipefail\necho "TODO: implement"');

  if (!name) return { error: 'name is required' };
  if (!/^[a-z0-9-]+$/.test(name)) return { error: 'name must be lowercase alphanumeric with hyphens' };

  // Check if skill already exists
  const existing = await getSkill(name);
  if (existing) return { error: `Skill "${name}" already exists` };

  await createSkill({
    name,
    description: description || `AI-generated skill: ${name}`,
    version: '0.1.0',
    tags,
  });

  // Write skill files
  const skillDir = resolve(WORKSPACE_ROOT, 'skills', name);
  await writeFile(resolve(skillDir, 'run.sh'), scriptContent, 'utf-8');
  await writeFile(resolve(skillDir, 'README.md'), `# ${name}\n\n${description}\n\nGenerated by AI Assistant.\n`, 'utf-8');

  await logAuditEvent({
    action: 'skill.create',
    actorId: 'ai-assistant',
    actorType: 'system',
    targetType: 'skill',
    targetId: name,
    details: { description, tags },
  });

  return { created: true, name, description, tags };
});

registerTool('generateRunbook', async (args) => {
  const name = String(args['name'] ?? '');
  const description = String(args['description'] ?? '');
  const scenario = String(args['scenario'] ?? '');
  const tags = (args['tags'] as string[] | undefined) ?? ['runbook'];

  if (!name) return { error: 'name is required' };
  if (!scenario) return { error: 'scenario is required' };
  if (!/^[a-z0-9-]+$/.test(name)) return { error: 'name must be lowercase alphanumeric with hyphens' };

  const existing = await getSkill(name);
  if (existing) return { error: `Skill "${name}" already exists` };

  // Generate a structured runbook script with pre-checks, steps, rollback
  const scriptContent = `#!/usr/bin/env bash
set -euo pipefail

# Runbook: ${name}
# Description: ${description}
# Scenario: ${scenario}
# Generated by AI Assistant
# Tags: ${tags.join(', ')}

RUNBOOK_NAME="${name}"
LOG_FILE="/tmp/\${RUNBOOK_NAME}-\$(date +%Y%m%d-%H%M%S).log"

log() { echo "[\$(date '+%Y-%m-%d %H:%M:%S')] [$1] \$2" | tee -a "\$LOG_FILE"; }
info() { log "INFO" "\$1"; }
warn() { log "WARN" "\$1"; }
error() { log "ERROR" "\$1"; }
step() { log "STEP" "── \$1 ──"; }

cleanup() {
  if [ \$? -ne 0 ]; then
    error "Runbook failed. See log: \$LOG_FILE"
    error "Consider running rollback procedures manually."
  fi
}
trap cleanup EXIT

info "Starting runbook: ${name}"
info "Description: ${description}"

# ── Pre-checks ──
step "Pre-checks"
# TODO: Add pre-condition checks based on scenario
info "Pre-checks passed"

# ── Action Steps ──
step "Execute main actions"
# TODO: Implement the operational steps for:
# ${scenario.replace(/\n/g, '\n# ')}
info "Actions completed"

# ── Validation ──
step "Post-action validation"
# TODO: Verify the action was successful
info "Validation passed"

# ── Rollback (manual trigger) ──
# To rollback, uncomment the section below:
# step "Rollback"
# TODO: Add rollback procedures
# info "Rollback completed"

info "Runbook completed successfully. Log saved to: \$LOG_FILE"
`;

  await createSkill({
    name,
    description: description || `AI-generated runbook: ${name}`,
    version: '0.1.0',
    tags: [...new Set([...tags, 'runbook'])],
  });

  const skillDir = resolve(WORKSPACE_ROOT, 'skills', name);
  await writeFile(resolve(skillDir, 'run.sh'), scriptContent, 'utf-8');

  const readmeContent = `# ${name}

${description}

## Scenario

${scenario}

## Usage

\`\`\`bash
bash run.sh
\`\`\`

## Steps

1. **Pre-checks** — Validates prerequisites
2. **Action Steps** — Executes the operational procedure
3. **Validation** — Verifies success
4. **Rollback** — (Manual) Reverts changes if needed

## Tags

${tags.map((t) => `- ${t}`).join('\n')}

---

*Generated by AI Assistant*
`;

  await writeFile(resolve(skillDir, 'README.md'), readmeContent, 'utf-8');

  await logAuditEvent({
    action: 'runbook.generate',
    actorId: 'ai-assistant',
    actorType: 'system',
    targetType: 'skill',
    targetId: name,
    details: { description, scenario, tags },
  });

  return { created: true, name, description, tags, type: 'runbook' };
});

registerTool('listSkillActions', async (args) => {
  const skillName = args['skillName'] ? String(args['skillName']) : undefined;

  const skills = await listSkills();
  const result = [];

  for (const skill of skills) {
    if (skillName && skill.name !== skillName) continue;

    // Read README if it exists
    let readme: string | null = null;
    try {
      readme = await getSkillFile(skill.name, 'README.md');
    } catch {
      // No README
    }

    result.push({
      name: skill.name,
      version: skill.version,
      description: skill.description,
      tags: skill.tags,
      files: skill.files,
      readme: readme ? readme.slice(0, 2000) : null,
    });
  }

  return { count: result.length, skills: result };
});

// ── Natural Language Command Builder ──

interface CommandTemplate {
  pattern: RegExp;
  command: string;
  args: (match: RegExpMatchArray, intent: string) => string[];
  description: string;
  requiresConfirmation: boolean;
}

const COMMAND_TEMPLATES: CommandTemplate[] = [
  // Service management
  {
    pattern: /(?:restart|start|stop|status|enable|disable)\s+(?:the\s+)?(\S+)\s*(?:service)?/i,
    command: 'systemctl',
    args: (match) => {
      const action = match[0]!.match(/^(restart|start|stop|status|enable|disable)/i)?.[1]?.toLowerCase() ?? 'status';
      const service = match[1]!;
      return [action, service];
    },
    description: 'Manage systemd services',
    requiresConfirmation: true,
  },
  // Package operations
  {
    pattern: /(?:install|update|upgrade|remove|uninstall)\s+(?:package\s+)?(\S+)/i,
    command: 'apt-get',
    args: (match) => {
      const raw = match[0]!.match(/^(install|update|upgrade|remove|uninstall)/i)?.[1]?.toLowerCase() ?? 'install';
      const action = raw === 'uninstall' ? 'remove' : raw;
      const pkg = match[1]!;
      return ['-y', action, pkg];
    },
    description: 'Package management (apt)',
    requiresConfirmation: true,
  },
  // Log viewing — journalctl
  {
    pattern: /(?:show|view|get|tail|check)\s+(?:the\s+)?(?:logs?|journal)\s+(?:for|of|from)\s+(\S+)/i,
    command: 'journalctl',
    args: (match) => ['-u', match[1]!, '-n', '50', '--no-pager'],
    description: 'View systemd journal logs',
    requiresConfirmation: false,
  },
  // Log viewing — tail
  {
    pattern: /tail\s+(?:-[nf]\s+\d+\s+)?(\S+)/i,
    command: 'tail',
    args: (match) => ['-n', '100', match[1]!],
    description: 'Tail a log file',
    requiresConfirmation: false,
  },
  // Disk usage
  {
    pattern: /(?:disk\s+(?:usage|space)|df|free\s+space|disk\s+free)/i,
    command: 'df',
    args: () => ['-h'],
    description: 'Show disk usage',
    requiresConfirmation: false,
  },
  // Directory size
  {
    pattern: /(?:directory\s+size|folder\s+size|du)\s+(?:of\s+)?(\S+)/i,
    command: 'du',
    args: (match) => ['-sh', match[1]!],
    description: 'Show directory size',
    requiresConfirmation: false,
  },
  // Network — connections
  {
    pattern: /(?:network\s+connections|listening\s+ports|open\s+ports|ss|netstat)/i,
    command: 'ss',
    args: () => ['-tlnp'],
    description: 'Show listening ports and connections',
    requiresConfirmation: false,
  },
  // Network — ping
  {
    pattern: /ping\s+(\S+)/i,
    command: 'ping',
    args: (match) => ['-c', '4', match[1]!],
    description: 'Ping a host',
    requiresConfirmation: false,
  },
  // Network — traceroute
  {
    pattern: /traceroute\s+(\S+)/i,
    command: 'traceroute',
    args: (match) => ['-m', '15', match[1]!],
    description: 'Trace route to host',
    requiresConfirmation: false,
  },
  // Process inspection
  {
    pattern: /(?:top\s+processes|running\s+processes|process\s+list|high\s+cpu|memory\s+hogs)/i,
    command: 'ps',
    args: () => ['aux', '--sort=-pcpu'],
    description: 'List processes sorted by CPU',
    requiresConfirmation: false,
  },
  // Uptime
  {
    pattern: /uptime/i,
    command: 'uptime',
    args: () => [],
    description: 'Show system uptime',
    requiresConfirmation: false,
  },
  // Memory info
  {
    pattern: /(?:memory\s+usage|free\s+memory|ram\s+usage|free)/i,
    command: 'free',
    args: () => ['-h'],
    description: 'Show memory usage',
    requiresConfirmation: false,
  },
];

registerTool('executeNaturalCommand', async (args) => {
  const db = getDb();
  const intent = String(args['intent'] ?? '');
  const nodeName = args['nodeName'] ? String(args['nodeName']) : undefined;

  if (!intent) return { error: 'intent is required — describe what you want to do' };

  // Resolve node by name if provided
  let nodeId: string | undefined;
  let resolvedNodeName: string | undefined;

  if (nodeName) {
    const node = await db.node.findFirst({
      where: {
        OR: [
          { name: { contains: nodeName } },
          { hostname: { contains: nodeName } },
        ],
      },
      select: { id: true, name: true, status: true },
    });

    if (!node) return { error: `No node found matching "${nodeName}"` };
    if (node.status !== 'ONLINE') return { error: `Node "${node.name}" is ${node.status}, must be ONLINE` };
    nodeId = node.id;
    resolvedNodeName = node.name;
  } else {
    // If no node specified, try to extract from intent text
    const nodes = await db.node.findMany({
      where: { status: 'ONLINE' },
      select: { id: true, name: true, hostname: true },
    });

    for (const n of nodes) {
      if (intent.toLowerCase().includes(n.name.toLowerCase()) || intent.toLowerCase().includes(n.hostname.toLowerCase())) {
        nodeId = n.id;
        resolvedNodeName = n.name;
        break;
      }
    }

    if (!nodeId) {
      return { error: 'Could not determine target node. Please specify which node to run on.' };
    }
  }

  // Match against command templates
  let matched: { command: string; args: string[]; description: string; requiresConfirmation: boolean } | null = null;

  for (const tpl of COMMAND_TEMPLATES) {
    const m = intent.match(tpl.pattern);
    if (m) {
      matched = {
        command: tpl.command,
        args: tpl.args(m, intent),
        description: tpl.description,
        requiresConfirmation: tpl.requiresConfirmation,
      };
      break;
    }
  }

  if (!matched) {
    return {
      error: 'Could not translate intent to a known command. Supported operations: service management (start/stop/restart), package ops (install/update/remove), log viewing, disk usage, network diagnostics, process listing.',
    };
  }

  const fullCommand = [matched.command, ...matched.args].join(' ');

  return {
    type: 'commandPreview',
    command: matched.command,
    args: matched.args,
    fullCommand,
    description: matched.description,
    nodeId,
    nodeName: resolvedNodeName,
    requiresConfirmation: matched.requiresConfirmation,
    intent,
  };
});

// ── REPL Scratchpad Tools ──

function getScratchpadConversationId(args: Record<string, unknown>): string {
  const conversationId = String(args['_conversationId'] ?? '');
  if (!conversationId) {
    throw new Error('Scratchpad tools require an active conversation');
  }
  return conversationId;
}

registerTool('listScratchpadVariables', async (args) => {
  const conversationId = getScratchpadConversationId(args);
  const entries = listScratchpadEntries(conversationId);
  return {
    count: entries.length,
    entries: entries.map((entry) => ({
      name: entry.name,
      source: entry.source,
      summary: entry.summary,
      updatedAt: entry.updatedAt,
    })),
  };
});

registerTool('saveResult', async (args) => {
  const conversationId = getScratchpadConversationId(args);
  const name = String(args['name'] ?? 'saved_result');
  const sourceName = String(args['sourceName'] ?? 'last_result');

  if (args['value'] !== undefined) {
    const entry = setScratchpadEntry(conversationId, name, args['value'], 'scratchpad.manual');
    return {
      saved: true,
      name: entry.name,
      source: entry.source,
      summary: entry.summary,
    };
  }

  const entry = aliasScratchpadEntry(conversationId, sourceName, name, 'scratchpad.alias');
  return {
    saved: true,
    name: entry.name,
    sourceName,
    summary: entry.summary,
  };
});

registerTool('transformData', async (args) => {
  const conversationId = getScratchpadConversationId(args);
  const sourceName = String(args['sourceName'] ?? 'last_result');
  const operation = String(args['operation'] ?? 'count') as
    | 'pluck'
    | 'sortBy'
    | 'filterEquals'
    | 'filterGreaterThan'
    | 'filterIncludes'
    | 'count'
    | 'sum'
    | 'average';

  const entry = transformScratchpadData({
    conversationId,
    sourceName,
    operation,
    outputName: args['outputName'] ? String(args['outputName']) : undefined,
    field: args['field'] ? String(args['field']) : undefined,
    value: args['value'],
    order: args['order'] === 'desc' ? 'desc' : 'asc',
  });

  return {
    transformed: true,
    name: entry.name,
    sourceName,
    summary: entry.summary,
    value: entry.value,
  };
});

registerTool('compareSnapshots', async (args) => {
  const conversationId = getScratchpadConversationId(args);
  const leftName = String(args['leftName'] ?? 'last_result');
  const rightName = String(args['rightName'] ?? '');
  if (!rightName) return { error: 'rightName is required' };

  const entry = compareScratchpadSnapshots(conversationId, leftName, rightName);
  return {
    compared: true,
    name: entry.name,
    summary: entry.summary,
    result: entry.value,
  };
});

// ── Predictive failure detection ──

registerTool('getFleetPredictions', async () => {
  const { getFleetPredictions } = await import('./prediction-service.js');
  return getFleetPredictions();
});

registerTool('getNodePredictions', async (args) => {
  const nodeId = args['nodeId'] as string;
  if (!nodeId) return { error: 'nodeId is required' };
  const { getNodePredictions } = await import('./prediction-service.js');
  return getNodePredictions(nodeId);
});

// ── Tool executor ──

export async function executeAiTool(call: AiToolCall): Promise<AiToolResult> {
  const handler = toolRegistry.get(call.name);
  if (!handler) {
    return { name: call.name, success: false, result: null, error: `Unknown tool: ${call.name}` };
  }

  try {
    const result = await handler(call.arguments);
    return { name: call.name, success: true, result };
  } catch (err) {
    return {
      name: call.name,
      success: false,
      result: null,
      error: err instanceof Error ? err.message : 'Tool execution failed',
    };
  }
}

/** List all available tools (for documentation/introspection). */
export function listAvailableTools(): string[] {
  return Array.from(toolRegistry.keys());
}
