import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { queryAuditEvents } from '../services/audit-service.js';
import { getCodexFleetPosture } from '../services/codex-service.js';

export const statsRouter = new Hono<AppVariables>();

statsRouter.use('*', authMiddleware);

/**
 * GET /stats/overview
 * Aggregated fleet statistics for the dashboard overview page.
 */
statsRouter.get('/overview', async (c) => {
  const db = getDb();

  const [
    totalNodes,
    onlineNodeRecords,
    offlineNodes,
    degradedNodes,
    provisioningNodes,
    totalCommands,
    runningCommands,
    pendingCommands,
    totalCronJobs,
    activeCronJobs,
    recentCommands,
    auditResult,
  ] = await Promise.all([
    db.node.count(),
    db.node.findMany({ where: { status: 'ONLINE' }, select: { id: true } }),
    db.node.count({ where: { status: 'OFFLINE' } }),
    db.node.count({ where: { status: 'DEGRADED' } }),
    db.node.count({ where: { status: 'PROVISIONING' } }),
    db.remoteCommand.count(),
    db.remoteCommand.count({ where: { status: 'RUNNING' } }),
    db.remoteCommand.count({ where: { status: 'PENDING' } }),
    db.cronJob.count(),
    db.cronJob.count({ where: { status: 'ACTIVE' } }),
    db.remoteCommand.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        command: true,
        status: true,
        createdAt: true,
        node: { select: { name: true } },
      },
    }),
    queryAuditEvents({ pageSize: 5 }),
  ]);

  const recentAudit = auditResult.events.map((e) => ({
    id: e.id,
    action: e.action,
    timestamp: e.timestamp,
    targetType: e.targetType,
    targetId: e.targetId,
  }));

  const onlineNodes = onlineNodeRecords.length;

  // One statement with an indexed latest-row lookup per online node keeps API
  // query count constant without scanning the full retained snapshot history.
  const latestHealth = await db.$queryRaw<Array<{ cpuUsagePercent: number; memoryPercent: number }>>`
    SELECT hs."cpuUsagePercent", hs."memoryPercent"
    FROM "nodes" n
    INNER JOIN "health_snapshots" hs ON hs."id" = (
      SELECT latest."id"
      FROM "health_snapshots" latest
      WHERE latest."nodeId" = n."id"
      ORDER BY latest."timestamp" DESC
      LIMIT 1
    )
    WHERE n."status" = 'ONLINE'
  `;

  const avgCpu =
    latestHealth.length > 0
      ? latestHealth.reduce((sum, h) => sum + h.cpuUsagePercent, 0) / latestHealth.length
      : null;
  const avgMemory =
    latestHealth.length > 0
      ? latestHealth.reduce((sum, h) => sum + h.memoryPercent, 0) / latestHealth.length
      : null;

  return c.json({
    success: true,
    data: {
      nodes: {
        total: totalNodes,
        online: onlineNodes,
        offline: offlineNodes,
        degraded: degradedNodes,
        provisioning: provisioningNodes,
      },
      commands: {
        total: totalCommands,
        running: runningCommands,
        pending: pendingCommands,
      },
      cron: {
        total: totalCronJobs,
        active: activeCronJobs,
      },
      health: {
        avgCpuPercent: avgCpu !== null ? Math.round(avgCpu * 10) / 10 : null,
        avgMemoryPercent: avgMemory !== null ? Math.round(avgMemory * 10) / 10 : null,
        reportingNodes: latestHealth.length,
      },
      codex: getCodexFleetPosture(),
      recentCommands,
      recentAudit,
    },
  });
});
