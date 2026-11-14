import { optional } from './utils/optional.js';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:https';
import { resolveListenerSecurity } from './config/listener-security.js';
import { rehearsalEnabled, startLiveBackgroundServices } from './config/rehearsal.js';

// Load the env file before any other imports read process.env. The CLI passes
// `--env-file` through MAGNUS_ENV_FILE; otherwise the package-level .env is used
// when present. Variables already set in the environment always win.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = process.env['MAGNUS_ENV_FILE'] ? resolve(process.env['MAGNUS_ENV_FILE']) : resolve(__dirname, '../.env');
if (existsSync(envFile)) config({ path: envFile, quiet: true });
rehearsalEnabled(); // Invalid safety flags fail before opening any listener.

// Validate required secrets before starting anything
const { validateSecrets } = await import('./utils/env.js');
validateSecrets();

const { securityFusionMode, startSecurityExporter, stopSecurityExporter } = await import('./services/security-export.js');
const { featureFlags } = await import('./config/features.js');
const { serve } = await import('@hono/node-server');
const { app } = await import('./server.js');
const { startEmbermendDispatcher, stopEmbermendDispatcher } = await import('./routes/embermend.js');
const { parseRouteAliases, withRouteAliases } = await import('./config/route-aliases.js');
const handler = withRouteAliases(app.fetch, parseRouteAliases(process.env['MAGNUS_ROUTE_ALIASES_JSON']));
const { startRolloutReconciler, stopRolloutReconciler } = await import('./services/rollout-service.js');
const { startApplicationProbes, stopApplicationProbes } = await import('./services/application-probes.js');
const { startNodeIssueMonitor } = await import('./services/node-issue-monitor.js');
const { stopNodeIssueMonitor } = await import('./services/node-issue-monitor.js');
const { startUpgradeReadinessMonitor, stopUpgradeReadinessMonitor } = await import('./services/agent-upgrade-readiness.js');
const { startLogRetention } = await import('./services/log-retention.js');
const { stopLogRetention } = await import('./services/log-retention.js');
const { startHealthRetention } = await import('./services/health-retention.js');
const { stopHealthRetention } = await import('./services/health-retention.js');
const { startNotificationRetention, stopNotificationRetention } = await import('./services/notification-retention.js');

const { startCommandWorker, closeCommandQueue } = await import('./queue/workers.js');
const { startUpdateCheck, stopUpdateCheck } = await import('./services/update-check-service.js');
const { startWebhookWorker, closeWebhookQueue } = await import('./services/webhook-service.js');
const { setupTerminalWebSocket } = await import('./routes/terminal.js');
const { disconnectRedis } = await import('./queue/redis.js');
const { eventBus } = await import('./services/event-bus.js');
const { disconnectDb } = await import('./db/index.js');
const { startCodexFleetMonitor, stopCodexFleetMonitor } = await import('./services/codex-service.js');
const { startArdentHiveMemRenewal, stopArdentHiveMemRenewal } = await import('./services/ardent-hivemem-renewal.js');
const { startExtensionSourceMonitor, stopExtensionSourceMonitor } = await import('./services/hermes-plugin-source.js');
const { importPackageSkills } = await import('./services/hermes-catalog-import.js');

const port = Number(process.env['CONTROL_API_PORT'] ?? 4000);

const features = featureFlags();
console.log(`[startup] security-fusion=${securityFusionMode()} hermes-registry=${features.hermesRegistry ? 'on' : 'off'} `
  + `plugin-api=${features.pluginApi ? 'on' : 'off'} iam=${features.iam ? 'on' : 'off'}`);


const { writeRuntimeFile } = await import('./utils/runtime-file.js');
const { CONTROL_API_VERSION } = await import('./config/version.js');

/**
 * Per-node credentials: create the server signing key and record the start of the legacy-upgrade
 * window at the first start, not at the first agent request. A failure is reported and does not
 * stop the server: in compat mode agents keep working on the shared node secret.
 */
async function announceNodeAuth(): Promise<void> {
  try {
    const { serverKeyRotationState } = await import('./services/node-server-key.js');
    const { legacyUpgradeWindow } = await import('./services/node-credential-service.js');
    const { nodeAuthModeSetting } = await import('./services/node-auth-config.js');
    const window = await legacyUpgradeWindow();
    const setting = nodeAuthModeSetting();
    const rotation = serverKeyRotationState();
    console.log(`[startup] node-auth mode=${setting.mode}${setting.explicit ? '' : ' (default)'} server-key=${rotation.active.keyFingerprint}`
      + `${rotation.next ? ` next=${rotation.next.keyFingerprint}` : ''}${rotation.previous ? ` previous=${rotation.previous.keyFingerprint} until ${rotation.previous.retireAfter}` : ''} `
      + `legacy-upgrade=${window.open ? `open until ${window.until}` : 'closed'}`);
  } catch (error) {
    console.error(`[startup] node-auth is not ready: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Background services shared by the TLS and development listeners. */
function startBackgroundServices(listenPort: number): void {
  const started = startLiveBackgroundServices(() => {
  writeRuntimeFile({ version: CONTROL_API_VERSION, port: listenPort, host: listener.hostname });
  void announceNodeAuth();
  startNodeIssueMonitor();
  startUpgradeReadinessMonitor();
  startApplicationProbes();
  startLogRetention();
  startHealthRetention();
  startNotificationRetention();

  startSecurityExporter();
  startCommandWorker();
  startEmbermendDispatcher();
  startRolloutReconciler();
  startWebhookWorker();
  startCodexFleetMonitor();
  startArdentHiveMemRenewal();
  startUpdateCheck();
  if (features.hermesRegistry) {
    startExtensionSourceMonitor();
    void importPackageSkills().then(result => console.log(`[hermes-registry] catalog import: ${JSON.stringify(result)}`))
      .catch(error => console.error('[hermes-registry] catalog import failed', error));
  }
  });
  if (!started) console.log('[startup] isolated rehearsal: background consumers and queue activation disabled');
}

/**
 * Per-node credentials, before listening: with NODE_AUTH_MODE unset (enforce, the default since
 * 3.0.0) the server refuses to start while enforce would lock out part of its fleet; an explicit
 * compat or warn starts with a deprecation warning (services/node-auth-startup-guard.ts).
 */
{
  const { allowServerKeyCreation } = await import('./services/node-server-key.js');
  // Only the server creates its key; command-line processes use the file it made.
  allowServerKeyCreation();
  const { nodeAuthStartupGuard } = await import('./services/node-auth-startup-guard.js');
  let guard: Awaited<ReturnType<typeof nodeAuthStartupGuard>>;
  try { guard = await nodeAuthStartupGuard(); }
  catch (error) {
    console.error(`[startup] Refusing to start: NODE_AUTH_MODE is not set (enforce by default), and the inventory could not be read to check `
      + `that enforce mode locks out no node: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (!guard.ok) {
    console.error(`[startup] ${guard.message}`);
    process.exit(1);
  }
  for (const warning of guard.warnings) console.warn(`[startup] DEPRECATED: ${warning}`);
}

// Relative TLS paths resolve against the working directory; prefer absolute paths.
const repoRoot = process.cwd();
const certPath = process.env['TLS_CERT_PATH']
  ? resolve(repoRoot, process.env['TLS_CERT_PATH'])
  : undefined;
const keyPath = process.env['TLS_KEY_PATH']
  ? resolve(repoRoot, process.env['TLS_KEY_PATH'])
  : undefined;

const listener = resolveListenerSecurity({ nodeEnv: process.env['NODE_ENV'] ?? 'development', allowInsecureHttp: (process.env['ALLOW_INSECURE_HTTP'] ?? 'false').toLowerCase() === 'true', ...optional("bindHost", process.env['CONTROL_API_BIND_HOST']), ...optional("certPath", certPath), ...optional("keyPath", keyPath), pathExists: existsSync });

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
      startBackgroundServices(info.port);
    },
  )
  : serve({ fetch: handler, port, hostname: listener.hostname }, (info) => {
    console.log(`🚀 Magnus server listening on http://${listener.hostname}:${info.port} (development opt-in)`);
    startBackgroundServices(info.port);
  });
const terminalWss = rehearsalEnabled() ? undefined : setupTerminalWebSocket(server);

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
      stopEmbermendDispatcher();
      stopRolloutReconciler();
      stopNodeIssueMonitor();
      stopUpgradeReadinessMonitor();
      stopApplicationProbes();
      stopLogRetention();
      stopHealthRetention();
      stopNotificationRetention();
      stopSecurityExporter();
      stopCodexFleetMonitor();
      const renewalStopped = stopArdentHiveMemRenewal();
      stopUpdateCheck();
      stopExtensionSourceMonitor();
      for (const client of terminalWss?.clients ?? []) client.terminate();
      const httpClosed = new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      (server as typeof server & { closeAllConnections?: () => void }).closeAllConnections?.();
      const webSocketsClosed = terminalWss ? new Promise<void>((resolvePromise) => terminalWss.close(() => resolvePromise())) : Promise.resolve();
      await Promise.all([httpClosed, webSocketsClosed, renewalStopped]);
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
