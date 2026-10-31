import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:https';
import { resolveListenerSecurity } from './config/listener-security.js';

// Load the env file before any other imports read process.env. The CLI passes
// `--env-file` through MAGNUS_ENV_FILE; otherwise the package-level .env is used
// when present. Variables already set in the environment always win.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = process.env['MAGNUS_ENV_FILE'] ? resolve(process.env['MAGNUS_ENV_FILE']) : resolve(__dirname, '../.env');
if (existsSync(envFile)) config({ path: envFile, quiet: true });

// Validate required secrets before starting anything
const { validateSecrets } = await import('./utils/env.js');
validateSecrets();

const { securityFusionLocal, securityFusionMode, startSecurityExporter, stopSecurityExporter } = await import('./services/security-export.js');
const { featureFlags } = await import('./config/features.js');
const { serve } = await import('@hono/node-server');
const { app } = await import('./server.js');
const { parseRouteAliases, withRouteAliases } = await import('./config/route-aliases.js');
const handler = withRouteAliases(app.fetch, parseRouteAliases(process.env['MAGNUS_ROUTE_ALIASES_JSON']));
const { startRolloutReconciler, stopRolloutReconciler } = await import('./services/rollout-service.js');
const { startApplicationProbes, stopApplicationProbes } = await import('./services/application-probes.js');
const { startNodeIssueMonitor } = await import('./services/node-issue-monitor.js');
const { stopNodeIssueMonitor } = await import('./services/node-issue-monitor.js');
const { startLogRetention } = await import('./services/log-retention.js');
const { stopLogRetention } = await import('./services/log-retention.js');
const { startHealthRetention } = await import('./services/health-retention.js');
const { stopHealthRetention } = await import('./services/health-retention.js');
const { startNotificationRetention, stopNotificationRetention } = await import('./services/notification-retention.js');
const { startSecurityFusionRetention, stopSecurityFusionRetention } = await import('./services/security-fusion-service.js');
const { reconcileSecurityFusionEvidence } = await import('./services/security-fusion-evidence-integrity.js');
const {
  startSecurityFusionOutboxDispatcher,
  stopSecurityFusionOutboxDispatcher,
} = await import('./services/security-fusion-outbox.js');
const { startCommandWorker, closeCommandQueue } = await import('./queue/workers.js');
const { startWebhookWorker, closeWebhookQueue } = await import('./services/webhook-service.js');
const { setupTerminalWebSocket } = await import('./routes/terminal.js');
const { disconnectRedis } = await import('./queue/redis.js');
const { eventBus } = await import('./services/event-bus.js');
const { disconnectDb } = await import('./db/index.js');
const { startCodexFleetMonitor, stopCodexFleetMonitor } = await import('./services/codex-service.js');
const { startExtensionSourceMonitor, stopExtensionSourceMonitor } = await import('./services/hermes-plugin-source.js');
const { importPackageSkills } = await import('./services/hermes-catalog-import.js');

const port = Number(process.env['CONTROL_API_PORT'] ?? 4000);

const features = featureFlags();
console.log(`[startup] security-fusion=${securityFusionMode()} hermes-registry=${features.hermesRegistry ? 'on' : 'off'} `
  + `plugin-api=${features.pluginApi ? 'on' : 'off'} iam=${features.iam ? 'on' : 'off'}`);

if (securityFusionLocal()) {
  const evidenceReconciliation = await reconcileSecurityFusionEvidence();
  console.log(
    `[security-fusion] evidence reconciliation checked=${evidenceReconciliation.checked} `
    + `updated=${evidenceReconciliation.updated} quarantined=${evidenceReconciliation.quarantined} `
    + `mismatched_cases=${evidenceReconciliation.mismatchedCases}`,
  );
}

/** Background services shared by the TLS and development listeners. */
function startBackgroundServices(): void {
  startNodeIssueMonitor();
  startApplicationProbes();
  startLogRetention();
  startHealthRetention();
  startNotificationRetention();
  if (securityFusionLocal()) {
    startSecurityFusionRetention();
    startSecurityFusionOutboxDispatcher();
  }
  startSecurityExporter();
  startCommandWorker();
  startRolloutReconciler();
  startWebhookWorker();
  startCodexFleetMonitor();
  if (features.hermesRegistry) {
    startExtensionSourceMonitor();
    void importPackageSkills().then(result => console.log(`[hermes-registry] catalog import: ${JSON.stringify(result)}`))
      .catch(error => console.error('[hermes-registry] catalog import failed', error));
  }
}

// Relative TLS paths resolve against the working directory; prefer absolute paths.
const repoRoot = process.cwd();
const certPath = process.env['TLS_CERT_PATH']
  ? resolve(repoRoot, process.env['TLS_CERT_PATH'])
  : undefined;
const keyPath = process.env['TLS_KEY_PATH']
  ? resolve(repoRoot, process.env['TLS_KEY_PATH'])
  : undefined;

const listener = resolveListenerSecurity({
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  allowInsecureHttp: (process.env['ALLOW_INSECURE_HTTP'] ?? 'false').toLowerCase() === 'true',
  bindHost: process.env['CONTROL_API_BIND_HOST'],
  certPath,
  keyPath,
  pathExists: existsSync,
});

const server = listener.useTls
  ? serve(
    {
      fetch: handler,
      port,
      hostname: listener.hostname,
      createServer,
      serverOptions: {
        key: readFileSync(keyPath!),
        cert: readFileSync(certPath!),
      },
    },
    (info) => {
      console.log(`🚀 Magnus server listening on https://${listener.hostname}:${info.port}`);
      startBackgroundServices();
    },
  )
  : serve({ fetch: handler, port, hostname: listener.hostname }, (info) => {
    console.log(`🚀 Magnus server listening on http://${listener.hostname}:${info.port} (development opt-in)`);
    startBackgroundServices();
  });
const terminalWss = setupTerminalWebSocket(server);

// ── Graceful shutdown ──
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ${signal} received — shutting down Magnus server...`);
  const timeoutMs = Number(process.env['SHUTDOWN_TIMEOUT_MS'] ?? 15_000);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error(`shutdown exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  let exitCode = 0;
  try {
    await Promise.race([(async () => {
      stopRolloutReconciler();
      stopNodeIssueMonitor();
      stopApplicationProbes();
      stopLogRetention();
      stopHealthRetention();
      stopNotificationRetention();
      stopSecurityFusionRetention();
      stopSecurityExporter();
      stopSecurityFusionOutboxDispatcher();
      stopCodexFleetMonitor();
      stopExtensionSourceMonitor();
      for (const client of terminalWss.clients) client.terminate();
      const httpClosed = new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      (server as typeof server & { closeAllConnections?: () => void }).closeAllConnections?.();
      const webSocketsClosed = new Promise<void>((resolvePromise) => terminalWss.close(() => resolvePromise()));
      await Promise.all([httpClosed, webSocketsClosed]);
      await closeCommandQueue();
      await closeWebhookQueue();
      await eventBus.close();
      await disconnectRedis();
      await disconnectDb();
    })(), deadline]);
    console.log('  ✓ HTTP, WebSockets, monitors, queues, Redis, and database closed');
  } catch (err) {
    console.error('  ✗ Graceful shutdown failed:', err);
    exitCode = 1;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  console.log('✅ Magnus server shutdown complete');
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
