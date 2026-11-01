import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AGENT_VERSION } from './version.js';
import { CONTROL_API_URL, ENABLE_NODE_MANAGEMENT, NODE_MANAGER_SECRET, RESULT_SIGNING_SECRET, MAGNUS_EXECUTION_SUPERVISOR_ENABLED } from './env.js';
import { COMMAND_COMPLETION_REGISTRY, COMMAND_COMPLETION_REGISTRY_SHA256 } from './security/command-completion-registry.js';
import { nodeAuthMiddleware } from './middleware.js';
import { tracingMiddleware } from './collectors/otel-middleware.js';
import { getHeartbeatStatus } from './agent.js';
import { controlApiFetch } from './tls.js';

import type { HealthCheck } from './types/index.js';

const execFileAsync = promisify(execFile);

function commandReconciliationEnabled(): boolean {
  const secret = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  return ENABLE_NODE_MANAGEMENT && secret.length >= 32
    && secret !== RESULT_SIGNING_SECRET && secret !== NODE_MANAGER_SECRET;
}

function secretFingerprint(value: string): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

async function commandCheck(name: string, command: string, args: string[] = []): Promise<HealthCheck> {
  const started = performance.now();
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 2500 });
    return {
      name,
      status: 'pass',
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      message: stdout.trim().split('\n')[0] || 'ok',
    };
  } catch (err) {
    return {
      name,
      status: 'fail',
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The system agent runs as root while Hermes belongs to the configured user. */
export function hermesCliCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const owners = [env['HERMES_USER'], env['HERMES_OWNER']]
    .filter((owner): owner is string => typeof owner === 'string' && /^[a-z_][a-z0-9_-]*$/.test(owner));
  return [...new Set([...owners.map(owner => `/home/${owner}/.hermes/hermes-agent/venv/bin/hermes`), 'hermes'])];
}

async function hermesCliCheck(): Promise<HealthCheck> {
  let last: HealthCheck | null = null;
  for (const command of hermesCliCandidates()) {
    const result = await commandCheck('hermes-cli', command, ['--version']);
    if (result.status === 'pass') return result;
    last = result;
  }
  return last ?? { name: 'hermes-cli', status: 'fail', latencyMs: 0, message: 'Hermes CLI is unavailable' };
}

/**
 * Create the Hono app with routes conditionally mounted based on feature flags.
 *
 * Route modules are loaded lazily via dynamic imports so that modules for
 * disabled features are never evaluated (avoids unnecessary side-effects and
 * reduces startup time when a feature flag is off).
 *
 * - ENABLE_NODE_MANAGEMENT=true → mounts fleet routes under /api/v1 (x-node-token auth)
 */
export async function createApp(): Promise<Hono> {
  const app = new Hono();

  app.use('*', logger());
  app.use('*', tracingMiddleware);

  // ── Ping (unauthenticated for connectivity checks) ──
  app.get('/api/v1/ping', (c) =>
    c.json({
      success: true,
      data: {
        ok: true,
        version: AGENT_VERSION,
        features: {
          nodeManagement: ENABLE_NODE_MANAGEMENT,
          commandReceipts: ENABLE_NODE_MANAGEMENT ? 1 : 0,
          commandFencing: ENABLE_NODE_MANAGEMENT ? 1 : 0,
          managedMutations: ENABLE_NODE_MANAGEMENT ? 1 : 0,
          commandReconciliation: commandReconciliationEnabled() ? 1 : 0,
          commandCompletionRegistry: { version: COMMAND_COMPLETION_REGISTRY.version,
            sha256: COMMAND_COMPLETION_REGISTRY_SHA256, enabled: MAGNUS_EXECUTION_SUPERVISOR_ENABLED ? 1 : 0 },
        },
      },
    }),
  );

  // ── Detailed health check (authenticated, standardized format) ──
  // `/api/v1/ping` is the intentionally minimal public readiness endpoint.
  app.get('/api/v1/health/check', nodeAuthMiddleware, async (c) => {
    const checks: HealthCheck[] = [];

    // Filesystem check — verify /tmp is writable
    const fsStart = performance.now();
    let fsOk = false;
    try {
      const { writeFileSync, unlinkSync } = await import('node:fs');
      const probe = `/tmp/.magnus-health-${Date.now()}`;
      writeFileSync(probe, 'ok');
      unlinkSync(probe);
      fsOk = true;
    } catch {}
    const fsLatency = performance.now() - fsStart;
    checks.push({
      name: 'filesystem',
      status: fsOk ? 'pass' : 'fail',
      latencyMs: Math.round(fsLatency * 100) / 100,
      message: fsOk ? 'writable' : 'read-only or inaccessible',
    });

    checks.push({
      name: 'node-version',
      status: Number(process.versions.node.split('.')[0]) >= 22 ? 'pass' : 'fail',
      message: process.version,
    });

    checks.push(await commandCheck('systemd', 'systemctl', ['--version']));
    checks.push(await hermesCliCheck());

    const controlStart = performance.now();
    let controlOk = false;
    let controlMessage = '';
    try {
      // Same verified TLS trust (including CONTROL_API_CA_PATH) as heartbeats.
      const res = await controlApiFetch(`${CONTROL_API_URL.replace(/\/+$/, '')}/`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
      controlOk = res.ok;
      controlMessage = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      controlMessage = err instanceof Error ? err.message : String(err);
    }
    checks.push({
      name: 'control-api',
      status: controlOk ? 'pass' : 'fail',
      latencyMs: Math.round((performance.now() - controlStart) * 100) / 100,
      message: controlMessage,
    });

    const allPass = checks.every((ch) => ch.status === 'pass');
    const status = allPass ? 'healthy' : 'degraded';

    return c.json({
      success: true,
      data: {
        service: 'magnus-agent',
        status,
        version: AGENT_VERSION,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        features: {
          nodeManagement: ENABLE_NODE_MANAGEMENT,
          commandReceipts: ENABLE_NODE_MANAGEMENT ? 1 : 0,
          commandFencing: ENABLE_NODE_MANAGEMENT ? 1 : 0,
          managedMutations: ENABLE_NODE_MANAGEMENT ? 1 : 0,
          commandReconciliation: commandReconciliationEnabled() ? 1 : 0,
        },
        heartbeat: getHeartbeatStatus(),
        fingerprints: {
          nodeManagerSecret: secretFingerprint(NODE_MANAGER_SECRET),
        },
        checks,
      },
    });
  });

  // ── Node-management routes (fleet agent) ──
  if (ENABLE_NODE_MANAGEMENT) {
    const [
      { healthRoutes },
      { commandRoutes },
      { managedMutationGuard, registerManagedHttp },
      { cronRoutes },
      { fileRoutes },
      { skillRoutes },
      { updateRoutes },
      { driftRoutes },
      { networkInfoRoutes },
      { profilingRoutes },
      { otelRoutes },
      { workspaceRoutes },
      { hermesRoutes },
      { codexRoutes },
      { ardentRoutes },
      { agentUpgradeRoutes },
    ] = await Promise.all([
      import('./collectors/health-routes.js'),
      import('./executors/command-executor.js'),
      import('./executors/managed-http.js'),
      import('./executors/cron-manager.js'),
      import('./executors/file-sync-executor.js'),
      import('./executors/skill-manager.js'),
      import('./updater/self-updater.js'),
      import('./collectors/drift-routes.js'),
      import('./collectors/network-info.js'),
      import('./collectors/profiling-routes.js'),
      import('./collectors/otel-routes.js'),
      import('./executors/workspace-manager.js'),
      import('./executors/hermes-manager.js'),
      import('./executors/codex-manager.js'),
      import('./executors/ardent-manager.js'),
      import('./upgrade/routes.js'),
    ]);
    const v1 = new Hono();
    v1.use('*', nodeAuthMiddleware);
    // Root-only features answer 403 AGENT_NOT_PRIVILEGED when MAGNUS_AGENT_PRIVILEGED=false.
    const { requirePrivileged } = await import('./privileged.js');
    for (const [path, feature] of [['/cron', 'cron'], ['/cron/*', 'cron'], ['/users', 'users'], ['/users/*', 'users'],
      ['/health/system-updates/*', 'system-updates'], ['/ardent/action', 'ardent-management']] as const)
      v1.use(path, requirePrivileged(feature));
    v1.use('*', managedMutationGuard);
    const { storageEvidenceRoutes } = await import('./collectors/storage-evidence.js');
    v1.route('/storage-evidence', storageEvidenceRoutes);
    v1.route('/health', healthRoutes);
    v1.route('/commands', commandRoutes);
    const { enrollmentDrainRoutes } = await import('./executors/enrollment-drain.js');
    v1.route('/commands', enrollmentDrainRoutes);
    v1.route('/cron', cronRoutes);
    v1.route('/files', fileRoutes);
    v1.route('/skills', skillRoutes);
    v1.route('/update', updateRoutes);
    v1.route('/drift', driftRoutes);
    v1.route('/network-info', networkInfoRoutes);
    v1.route('/profiling', profilingRoutes);
    v1.route('/traces', otelRoutes);
    v1.route('/workspace', workspaceRoutes);
    v1.route('/hermes', hermesRoutes);
    v1.route('/codex', codexRoutes);
    v1.route('/ardent', ardentRoutes);
    v1.route('/agent-upgrade', agentUpgradeRoutes);

    // User management (provision, password, listing)
    const { userRoutes } = await import('./routes/user-manager.js');
    v1.route('/users', userRoutes);

    app.route('/api/v1', v1);
    app.use('/api/v1/commands/managed-http', nodeAuthMiddleware);
    registerManagedHttp(app);
  }
  return app;
}
