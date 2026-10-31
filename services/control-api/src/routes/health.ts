import { monitorsHealthy } from '../services/monitor-pulse.js';
import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import { checkDockerGroupHealthOnControlNode } from '../services/docker-group-health.js';
import { CONTROL_API_VERSION } from '../config/version.js';
import { forecastDisk, forecastAtRisk } from '../services/forecast-service.js';
import { getDependencyHealth } from '../services/ops-service.js';
import { getRetentionPolicyReadiness } from '../services/health-retention.js';
import { authMiddleware } from '../middleware/auth.js';

import type { AppVariables, HealthCheck } from '../types/index.js';

export const healthRouter = new Hono<AppVariables>();

// Deliberately minimal public readiness. It performs no dependency calls and
// reveals no version, migration, topology, or fleet state.
healthRouter.get('/', (c) => c.json({
  success: true,
  data: { service: 'magnus-control-api', status: 'ok' },
}));

// Minimal off-host watchdog signal: no credentials, topology or evidence data.
healthRouter.get('/watchdog', c => {
  const healthy = monitorsHealthy();
  return c.json({ success: healthy, data: { service: 'magnus-control-api', status: healthy ? 'ok' : 'degraded' } }, healthy ? 200 : 503);
});

// Health details, dependency topology, and node forecasts are authenticated.
healthRouter.use('*', authMiddleware);

healthRouter.get('/details', async (c) => {
  const db = getDb();
  const dockerAccess = checkDockerGroupHealthOnControlNode();

  const checks: HealthCheck[] = [];

  // Database connectivity check with latency
  const dbStart = performance.now();
  let dbOk = false;
  try {
    await db.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const dbLatency = performance.now() - dbStart;
  checks.push({
    name: 'database',
    status: dbOk ? 'pass' : 'fail',
    latencyMs: Math.round(dbLatency * 100) / 100,
    message: dbOk ? 'connected' : 'unreachable',
  });

  // Docker group access check
  const dockerOk = dockerAccess.status !== 'warning';
  checks.push({
    name: 'docker',
    status: dockerOk ? 'pass' : 'fail',
    message: dockerOk ? 'accessible' : dockerAccess.message ?? 'docker group access issue',
  });

  const corsOrigin = process.env['CORS_ORIGIN'];
  checks.push({
    name: 'cors',
    status: process.env['NODE_ENV'] === 'production' && corsOrigin === '*' ? 'fail' : 'pass',
    message: corsOrigin === '*' ? 'wildcard CORS enabled' : 'deployment-aware CORS',
  });

  const retentionPolicy = getRetentionPolicyReadiness();
  checks.push({
    name: 'retention-policy',
    status: retentionPolicy.status,
    message: retentionPolicy.message,
  });

  const migrationStart = performance.now();
  try {
    const latestMigration = await db.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1
    `;
    checks.push({
      name: 'migration-safety',
      status: 'pass',
      latencyMs: Math.round((performance.now() - migrationStart) * 100) / 100,
      message: latestMigration[0]?.migration_name ?? 'no migration record',
    });
  } catch {
    checks.push({
      name: 'migration-safety',
      status: 'fail',
      latencyMs: Math.round((performance.now() - migrationStart) * 100) / 100,
      message: 'could not read Prisma migration table',
    });
  }

  const allPass = checks.every((ch) => ch.status === 'pass');
  const status = allPass ? 'healthy' : 'degraded';

  return c.json({
    success: true,
    data: {
      service: 'magnus-control-api',
      status,
      version: CONTROL_API_VERSION,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks,
    },
  });
});

healthRouter.get('/dependencies', async (c) => c.json({ success: true, data: await getDependencyHealth() }));

// ── Disk space forecasting ──

healthRouter.get('/forecast/at-risk', async (c) => {
  const days = Number(c.req.query('days') ?? '30');
  const daysThreshold = Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : 30;

  const atRisk = await forecastAtRisk(daysThreshold);
  return c.json({
    success: true,
    data: {
      daysThreshold,
      count: atRisk.length,
      nodes: atRisk,
    },
  });
});

healthRouter.get('/:nodeId/forecast', async (c) => {
  const nodeId = c.req.param('nodeId');
  const days = Number(c.req.query('days') ?? '30');
  const lookbackDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30;

  const db = getDb();
  const node = await db.node.findUnique({ where: { id: nodeId }, select: { id: true, hostname: true } });
  if (!node) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Node not found' } }, 404);
  }

  const forecasts = await forecastDisk(nodeId, lookbackDays);
  return c.json({
    success: true,
    data: {
      nodeId,
      hostname: node.hostname,
      lookbackDays,
      forecasts,
    },
  });
});
