import { resourceLeasesRouter } from './routes/resource-leases.js';
import { sharedResourceLeasesRouter } from './routes/shared-resource-leases.js';
import { securityBackupRouter } from './routes/security-backup.js';
import { securityIntegrationRouter } from './routes/security-integration.js';
import { securityConsoleUrl, securityFusionMode } from './services/security-export.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppVariables } from './types/index.js';

import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { securityHeaders } from './middleware/security-headers.js';
import { correlationId } from './middleware/correlation-id.js';
import { tracing } from './middleware/tracing.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { bodyLimitMiddleware } from './middleware/body-limit.js';
import { nodesRouter } from './routes/nodes.js';
import { commandsRouter } from './routes/commands.js';
import { cronRouter } from './routes/cron.js';
import { filesRouter } from './routes/files.js';
import { skillsRouter } from './routes/skills.js';
import { logsRouter } from './routes/logs.js';
import { healthRouter } from './routes/health.js';
import { auditRouter } from './routes/audit.js';
import { heartbeatRouter } from './routes/heartbeat.js';
import { deployRouter } from './routes/deploy.js';
import { discoveryRouter } from './routes/discovery.js';
import { quickCommandRouter } from './routes/quick-command.js';
import { statsRouter } from './routes/stats.js';
import { libraryRouter } from './routes/library.js';
import { rolesRouter } from './routes/roles.js';
import { notificationsRouter } from './routes/notifications.js';
import { selfUpdateRouter } from './routes/self-update.js';
import { systemUpdatesRouter } from './routes/system-updates.js';
import { agentUpgradesRouter } from './routes/agent-upgrades.js';
import { scanRouter } from './routes/scan.js';
import { terminalTicketRouter } from './routes/terminal-ticket.js';
import { usersRouter, authRouter } from './routes/users.js';
import { docsRouter } from './routes/docs.js';
import { webhooksRouter } from './routes/webhooks.js';
import { alertsRouter } from './routes/alerts.js';
import { driftRouter } from './routes/drift.js';
import { rolloutRouter } from './routes/rollout.js';
import { anomaliesRouter } from './routes/anomalies.js';
import { assistantRouter } from './routes/assistant.js';
import { eventsStreamRouter } from './routes/events-stream.js';
import { teamApprovalRouter } from './routes/team-approvals.js';
import { remediationRouter } from './routes/remediation.js';
import { metricsRouter } from './routes/metrics.js';
import { credentialsRouter } from './routes/credentials.js';
import { topologyRouter } from './routes/topology.js';
import { dependenciesRouter } from './routes/dependencies.js';
import { aiScheduleRouter } from './routes/ai-schedule.js';
import { profilingRouter } from './routes/profiling.js';
import { predictionsRouter } from './routes/predictions.js';
import { hermesRouter } from './routes/hermes.js';
import { hermesRegistryRouter } from './routes/hermes-registry.js';
import { orchestraRouter } from './routes/orchestra.js';
import { codexRouter } from './routes/codex.js';
import { ardentRouter } from './routes/ardent.js';
import { fleetChecksRouter } from './routes/fleet-checks.js';
import { opsRouter } from './routes/ops.js';
import { mcpRouter } from './routes/mcp.js';
import { securityFusionRouter } from './routes/security-fusion.js';
import { resolveCorsConfiguration } from './config/cors.js';

export const app = new Hono<AppVariables>();

// ── Global middleware ──
app.use('*', logger());
app.use('*', correlationId);
app.use('*', tracing);
app.use('*', securityHeaders);

// Parse CORS origins from env. Production defaults to dashboard origins instead
// of wildcard unless CORS_ORIGIN='*' is explicit.
const corsConfiguration = resolveCorsConfiguration(process.env);

app.use(
  '*',
  cors({
    origin: corsConfiguration.origin,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-idempotency-key', 'x-node-token', 'x-api-secret'],
    exposeHeaders: ['x-request-id'],
    credentials: corsConfiguration.credentials,
  }),
);
app.onError(errorHandler);

// ── Request logging (after CORS, before routes) ──
app.use('/api/v1/*', requestLogger);
// This public route must be bounded before any generic middleware can buffer it.
app.use(
  '/api/v1/security-fusion/ingest/events',
  bodyLimitMiddleware(Math.min(
    Math.max(Number(process.env['SECURITY_FUSION_INGEST_MAX_BYTES']) || 262_144, 1),
    262_144,
  )),
);
app.use('/api/v1/security-fusion/ingest/source-status', bodyLimitMiddleware(32_768));
app.route('/api/v1/security-integration/backups', securityBackupRouter);
app.use('/api/v1/*', async (c, next) => {
  const limit = c.req.path === '/api/v1/hermes-registry/capture' || c.req.path === '/api/v1/hermes-registry/revisions'
    ? 4_500_000 : Number(process.env['API_BODY_LIMIT_BYTES'] ?? 1_048_576);
  await bodyLimitMiddleware(limit)(c, next);
});

// ── API routes (v1) ──
const v1 = new Hono<AppVariables>();

// ── Rate limiting on sensitive endpoints (permissive — Beta) ──
v1.use('/auth/*', rateLimitMiddleware({ windowMs: 60_000, max: 20, keyPrefix: 'rl:auth', failClosed: true }));
v1.use('/deploy/*', rateLimitMiddleware({ windowMs: 60_000, max: 10, keyPrefix: 'rl:deploy', failClosed: true }));
v1.use('/agents/upgrade', rateLimitMiddleware({ windowMs: 60_000, max: 10, keyPrefix: 'rl:agent-upgrade', failClosed: true }));
v1.use('/self-update/*', rateLimitMiddleware({ windowMs: 60_000, max: 10, keyPrefix: 'rl:selfupdate', failClosed: true }));
v1.use('/commands/*', rateLimitMiddleware({ windowMs: 60_000, max: 60, keyPrefix: 'rl:commands' }));
v1.use('/quick-command/*', rateLimitMiddleware({ windowMs: 60_000, max: 30, keyPrefix: 'rl:quickcmd' }));
v1.use('/users/*', rateLimitMiddleware({ windowMs: 60_000, max: 30, keyPrefix: 'rl:users' }));
v1.use('/roles/*', rateLimitMiddleware({ windowMs: 60_000, max: 30, keyPrefix: 'rl:roles' }));
v1.use('/webhooks/*', rateLimitMiddleware({ windowMs: 60_000, max: 30, keyPrefix: 'rl:webhooks' }));
v1.use('/terminal/*', rateLimitMiddleware({ windowMs: 60_000, max: 20, keyPrefix: 'rl:terminal', failClosed: true }));
v1.use('/hermes/*', rateLimitMiddleware({ windowMs: 60_000, max: 20, keyPrefix: 'rl:hermes' }));
v1.use('/hermes-registry/*', rateLimitMiddleware({ windowMs: 60_000, max: 120, keyPrefix: 'rl:hermes-registry', failClosed: true }));
v1.use('/orchestra/*', rateLimitMiddleware({ windowMs: 60_000, max: 30, keyPrefix: 'rl:orchestra' }));
v1.use('/codex/*', rateLimitMiddleware({ windowMs: 60_000, max: 60, keyPrefix: 'rl:codex' }));
v1.use('/ardent/*', rateLimitMiddleware({ windowMs: 60_000, max: 60, keyPrefix: 'rl:ardent' }));
v1.use('/security-fusion/*', rateLimitMiddleware({ windowMs: 60_000, max: 120, keyPrefix: 'rl:security-fusion', failClosed: true }));

v1.route('/nodes', nodesRouter);
v1.route('/commands', commandsRouter);
v1.route('/resource-leases', resourceLeasesRouter);
v1.route('/shared-resource-leases', sharedResourceLeasesRouter);
v1.route('/cron', cronRouter);
v1.route('/files', filesRouter);
v1.route('/skills', skillsRouter);
v1.route('/logs', logsRouter);
v1.route('/health', healthRouter);
v1.route('/audit', auditRouter);
v1.route('/heartbeat', heartbeatRouter);
v1.route('/deploy', deployRouter);
v1.route('/discovery', discoveryRouter);
v1.route('/quick-command', quickCommandRouter);
v1.route('/stats', statsRouter);
v1.route('/library', libraryRouter);
v1.route('/roles', rolesRouter);
v1.route('/notifications', notificationsRouter);
v1.route('/self-update', selfUpdateRouter);
v1.route('/system/updates', systemUpdatesRouter);
v1.route('/agents/upgrade', agentUpgradesRouter);
v1.route('/scan', scanRouter);
v1.route('/terminal', terminalTicketRouter);
v1.route('/users', usersRouter);
v1.route('/auth', authRouter);
v1.route('/webhooks', webhooksRouter);
v1.route('/alerts', alertsRouter);
v1.route('/drift', driftRouter);
v1.route('/rollouts', rolloutRouter);
v1.route('/anomalies', anomaliesRouter);
v1.route('/predictions', predictionsRouter);
v1.route('/fleet-checks', fleetChecksRouter);
v1.route('/hermes', hermesRouter);
v1.route('/hermes-registry', hermesRegistryRouter);
v1.route('/orchestra', hermesRouter);
v1.route('/orchestra', orchestraRouter);
v1.route('/codex', codexRouter);
v1.route('/ardent', ardentRouter);
v1.route('/remediation', remediationRouter);
v1.route('/team-approvals', teamApprovalRouter);
v1.route('/credentials', credentialsRouter);
v1.route('/topology', topologyRouter);
v1.route('/dependencies', dependenciesRouter);
v1.route('/ai-schedules', aiScheduleRouter);
v1.route('/profiling', profilingRouter);
v1.route('/assistant', assistantRouter);
v1.route('/events/stream', eventsStreamRouter);
v1.route('/ops', opsRouter);
v1.route('/mcp', mcpRouter);
v1.route('/security-integration', securityIntegrationRouter);
v1.use('/security-fusion/*', async (c, next) => {
  const mode = securityFusionMode();
  if (mode === 'remote') {
    const url = securityConsoleUrl();
    return c.json({ success: false, error: { code: 'SECURITY_FUSION_MOVED',
      message: 'Security Fusion is served by the external security console', ...(url ? { url } : {}) } }, 410);
  }
  if (mode === 'off') {
    return c.json({ success: false, error: { code: 'SECURITY_FUSION_DISABLED',
      message: 'Security Fusion is disabled; set SECURITY_FUSION_MODE=local or remote to enable it' } }, 404);
  }
  await next();
});
v1.route('/security-fusion', securityFusionRouter);

app.route('/api/v1', v1);

// ── API documentation (Swagger UI + OpenAPI spec) ──
app.route('/api/docs', docsRouter);

// ── Prometheus metrics (METRICS_TOKEN bearer required; 503 until configured) ──
app.route('/metrics', metricsRouter);

// ── Root health-check ──
app.get('/', (c) => c.json({ service: 'magnus-control-api', status: 'ok' }));
