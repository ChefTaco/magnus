import ky from 'ky';
import { logger } from './utils/logger.js';
import { AGENT_VERSION } from './version.js';
import { collectSystemHealth } from './collectors/health-collector.js';
import { NODE_MANAGER_SECRET as NODE_TOKEN, CONTROL_API_URL, HOST_FQDN } from './env.js';
import { controlApiFetch } from './tls.js';
import { startSpan, formatTraceparent } from './collectors/otel-collector.js';
import { collectHermesState } from './executors/hermes-manager.js';
import { existsSync } from 'node:fs';
const HEARTBEAT_INTERVAL_MS = 30_000; // 30s
const HEARTBEAT_BACKOFF_MAX_MS = 5 * 60_000; // 5 min max backoff
const HERMES_DISCOVERY_INTERVAL_MS = Number(process.env['HERMES_DISCOVERY_INTERVAL_MS'] ?? 3 * 60 * 60 * 1000);

let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatRunning = false;
let hermesSnapshot: Awaited<ReturnType<typeof collectHermesState>> | null = null;
let hermesSnapshotAt = 0;
let hermesRefreshInFlight: Promise<void> | null = null;
let lastHeartbeatAcceptedAt: string | null = null;
let lastHeartbeatError: string | null = null;
let consecutiveHeartbeatFailures = 0;

export function getHeartbeatStatus(): {
  running: boolean;
  lastAcceptedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
} {
  return {
    running: heartbeatRunning,
    lastAcceptedAt: lastHeartbeatAcceptedAt,
    lastError: lastHeartbeatError,
    consecutiveFailures: consecutiveHeartbeatFailures,
  };
}

async function refreshHermesSnapshot(force = false): Promise<void> {
  if (!force && hermesSnapshot && Date.now() - hermesSnapshotAt < HERMES_DISCOVERY_INTERVAL_MS) return;
  if (hermesRefreshInFlight) return hermesRefreshInFlight;
  hermesRefreshInFlight = collectHermesState({}, force)
    .then((state) => {
      hermesSnapshot = state;
      hermesSnapshotAt = Date.now();
    })
    .catch((err: unknown) => {
      hermesSnapshot = null;
      hermesSnapshotAt = Date.now();
      logger.warn('Hermes discovery failed', { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      hermesRefreshInFlight = null;
    });
  return hermesRefreshInFlight;
}

const HEALTH_COLLECTION_DEADLINE_MS = 60_000;
const HERMES_HEARTBEAT_WAIT_MS = 15_000;
let healthInFlight: ReturnType<typeof collectSystemHealth> | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * Collect health without letting one wedged probe stop the heartbeat loop.
 * A slow collection is shared by later heartbeats instead of stacking new ones.
 */
async function collectHealthWithDeadline(): ReturnType<typeof collectSystemHealth> {
  healthInFlight ??= collectSystemHealth().finally(() => { healthInFlight = null; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      healthInFlight,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Health collection exceeded its deadline')), HEALTH_COLLECTION_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop the heartbeat loop. */
export function stopHeartbeatLoop(): void {
  heartbeatRunning = false;
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  logger.info('Heartbeat loop stopped');
}

/** Periodically send heartbeats + health data to the control API. */
export function startHeartbeatLoop(): void {
  let consecutiveFailures = 0;
  heartbeatRunning = true;

  const send = async (): Promise<void> => {
    if (!heartbeatRunning) return;

    const span = startSpan('heartbeat.send', { kind: 'client' });

    try {
      const health = await collectHealthWithDeadline();
      // A cached Hermes snapshot is sent while a stale one refreshes in the
      // background; without one, wait briefly so the first heartbeat can carry it.
      const refresh = refreshHermesSnapshot(!hermesSnapshot);
      if (!hermesSnapshot) await Promise.race([refresh, delay(HERMES_HEARTBEAT_WAIT_MS)]);
      const hermes = hermesSnapshot;

      await ky.post(`${CONTROL_API_URL}/api/v1/heartbeat`, {
        json: {
          agentVersion: AGENT_VERSION,
          uptimeSeconds: process.uptime(),
          status: 'healthy',
          fqdn: HOST_FQDN,
          platform: process.platform,
          arch: process.arch,
          health,
          securityCapabilities: {
            isolation: existsSync('/etc/magnus/security-isolation.enabled')
              && existsSync('/etc/magnus/security-isolation.nft')
              && existsSync('/etc/magnus/security-control-url'),
            serviceRestart: existsSync('/etc/magnus/security-restart-services'),
          },
          ...(hermes ? { hermes } : {}),
        },
        headers: {
          'x-node-token': NODE_TOKEN,
          'traceparent': formatTraceparent(span.traceId, span.spanId),
        },
        timeout: 10_000,
        fetch: controlApiFetch,
      }).json<{ data?: { expectedVersion?: string; updateAvailable?: boolean } }>().then((resp) => {
        if (resp.data?.updateAvailable && resp.data.expectedVersion) {
          logger.info(`Agent update available: ${AGENT_VERSION} → ${resp.data.expectedVersion}`);
        }
      });

      if (consecutiveFailures > 0) {
      logger.info('Heartbeat reconnected to control API');
        consecutiveFailures = 0;
      }
      consecutiveHeartbeatFailures = consecutiveFailures;
      lastHeartbeatAcceptedAt = new Date().toISOString();
      lastHeartbeatError = null;
      span.end('ok');
    } catch (err: unknown) {
      consecutiveFailures++;
      consecutiveHeartbeatFailures = consecutiveFailures;
      const message = err instanceof Error ? err.message : String(err);
      lastHeartbeatError = message;
      span.setAttribute('error.message', message);
      span.end('error');
      // Only log on first failure, then exponentially back off log noise
      if (consecutiveFailures === 1 || Math.log2(consecutiveFailures) % 1 === 0) {
        logger.warn(`Heartbeat failed to send`, { attempt: consecutiveFailures, error: message });
      }
      // Back off retry interval: 30s → 60s → 120s … capped at 5min
      const backoffMs = Math.min(
        HEARTBEAT_INTERVAL_MS * Math.pow(2, consecutiveFailures - 1),
        HEARTBEAT_BACKOFF_MAX_MS,
      );
      heartbeatTimer = setTimeout(() => void send(), backoffMs);
      return;
    }

    heartbeatTimer = setTimeout(() => void send(), HEARTBEAT_INTERVAL_MS);
  };

  // Send immediately, then self-scheduling via setTimeout (supports backoff)
  void refreshHermesSnapshot(true);
  void send();
  logger.info(`Heartbeat loop started`, {
    intervalSeconds: HEARTBEAT_INTERVAL_MS / 1000,
    hermesDiscoveryIntervalSeconds: HERMES_DISCOVERY_INTERVAL_MS / 1000,
  });
}
