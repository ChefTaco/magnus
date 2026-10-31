/** Starts the agent listener and background loops. Imported by the CLI `start` command. */
import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server as HttpsServer } from 'node:https';

import { logger } from './utils/logger.js';
import { resolveListenerSecurity } from './listener-security.js';

// TLS is verified per connection. Private Control API CAs are provided through
// CONTROL_API_CA_PATH; arbitrary downloads use the operating system trust store.
// (It only affects the legacy node:https module, not the undici-based fetch in Node 22.)

// Determine install directory: AGENT_INSTALL_DIR env (set by systemd), else cwd
const installDir = process.env['AGENT_INSTALL_DIR'] ?? process.cwd();

// Load root .env before any other imports read process.env
// dotenv default: does NOT override existing env vars (e.g. from systemd EnvironmentFile)
config({ path: resolve(installDir, '.env'), quiet: true });

// Validate required secrets before starting anything
const { validateSecrets, ENABLE_NODE_MANAGEMENT, ENABLE_AGENT_DISCOVERY } = await import('./env.js');
validateSecrets();
export {};

const { serve } = await import('@hono/node-server');
const { createApp } = await import('./server.js');
const app = await createApp();

const port = Number(process.env['NODE_MANAGER_PORT'] ?? 4100);

// ── Log enabled features ──
const features: string[] = [];
if (ENABLE_NODE_MANAGEMENT) features.push('node-management');
if (ENABLE_AGENT_DISCOVERY) features.push('authenticated-discovery');
logger.info(`Enabled features: ${features.join(', ')}`);

// ── TLS setup ──
const certPath = process.env['TLS_CERT_PATH']
  ? resolve(installDir, process.env['TLS_CERT_PATH'])
  : undefined;
const keyPath = process.env['TLS_KEY_PATH']
  ? resolve(installDir, process.env['TLS_KEY_PATH'])
  : undefined;

const listener = resolveListenerSecurity({
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  allowInsecureHttp: (process.env['ALLOW_INSECURE_HTTP'] ?? 'false').toLowerCase() === 'true',
  bindHost: process.env['NODE_MANAGER_BIND_HOST'],
  certPath,
  keyPath,
  pathExists: existsSync,
});

let tlsServer: HttpsServer | null = null;
if (listener.useTls) {
  tlsServer = serve(
    {
      fetch: app.fetch,
      port,
      hostname: listener.hostname,
      createServer,
      serverOptions: {
        key: readFileSync(keyPath!),
        cert: readFileSync(certPath!),
      },
    },
    (info) => {
      logger.info(`Magnus Agent listening on https://${listener.hostname}:${info.port}`);
    },
  ) as HttpsServer;
} else {
  serve({ fetch: app.fetch, port, hostname: listener.hostname }, (info) => {
    logger.info(`Magnus Agent listening on http://${listener.hostname}:${info.port} (development opt-in)`);
  });
}

// ── Node-management features ──
if (ENABLE_NODE_MANAGEMENT) {
  const { startHeartbeatLoop } = await import('./agent.js');
  const { startLogCollector, ENABLE_LOG_FORWARDING } = await import('./collectors/log-collector.js');
  const { startOtlpExporter } = await import('./collectors/otel-collector.js');
  startHeartbeatLoop();
  const { agentPrivileged } = await import('./privileged.js');
  if (agentPrivileged()) {
    const { startCredentialRenewal } = await import('./credential-renewal.js');
    startCredentialRenewal((cert, key) => tlsServer?.setSecureContext({ cert, key }));
  } else {
    logger.info('Unprivileged mode (MAGNUS_AGENT_PRIVILEGED=false): cron, users, system updates, Ardent management and credential renewal are disabled');
  }
  if (ENABLE_AGENT_DISCOVERY) {
    const { startDiscoveryListener } = await import('./discovery.js');
    startDiscoveryListener();
  }
  startOtlpExporter();
  if (ENABLE_LOG_FORWARDING) {
    const { HOST_FQDN } = await import('./env.js');
    startLogCollector(HOST_FQDN);
  }
}

// ── Graceful shutdown ──
async function shutdown() {
  logger.info('Shutting down agent...');

  // Drain running commands (30s timeout)
  const { drainRunningCommands } = await import('./executors/command-executor.js');
  await drainRunningCommands(30_000);

  if (ENABLE_NODE_MANAGEMENT) {
    const { stopCredentialRenewal } = await import('./credential-renewal.js');
    stopCredentialRenewal();
    const { stopHeartbeatLoop } = await import('./agent.js');
    const { stopLogCollector } = await import('./collectors/log-collector.js');
    const { stopOtlpExporter } = await import('./collectors/otel-collector.js');
    stopHeartbeatLoop();
    if (ENABLE_AGENT_DISCOVERY) {
      const { stopDiscoveryListener } = await import('./discovery.js');
      stopDiscoveryListener();
    }
    await stopLogCollector();
    await stopOtlpExporter();
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
