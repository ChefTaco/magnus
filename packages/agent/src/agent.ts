import ky from 'ky';
import { logger } from './utils/logger.js';
import { AGENT_VERSION } from './version.js';
import { collectSystemHealth } from './collectors/health-collector.js';
import { CONTROL_API_URL, HOST_FQDN } from './env.js';
import { controlApiAuthHeaders, noteControlApiResponse } from './node-auth.js';
import { onHeartbeatAcknowledged } from './node-enrollment.js';
import { boundNodeIdentity } from './security/node-identity.js';
import { controlApiFetch } from './tls.js';
import { startSpan, formatTraceparent } from './collectors/otel-collector.js';
import { collectHermesState, onHermesVersionProbeSettled } from './executors/hermes-manager.js';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { parseHeartbeatAcknowledgement } from './heartbeat-ack.js';
import { heartbeatDrift } from './upgrade/preflight.js';
import { confirmTrial, controlApiUnreachable, recordTrialAlive, selfUpgradeStatus, trialOf } from './upgrade/self-upgrade.js';
import { commandLedger } from './executors/command-executor.js';
import { positiveIntegerEnv } from './utils/env-number.js';
const HEARTBEAT_INTERVAL_MS = 30_000; // 30s
const HEARTBEAT_BACKOFF_MAX_MS = 5 * 60_000; // 5 min max backoff
/** On an upgrade trial: retry fast, without backoff, so a short control API outage does not end the trial. */
export const TRIAL_RETRY_MS = 5_000;
const HERMES_DISCOVERY_INTERVAL_MS = positiveIntegerEnv('HERMES_DISCOVERY_INTERVAL_MS', 3 * 60 * 60 * 1000);

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

let stopVersionProbeListener: (() => void) | null = null;

const HEALTH_COLLECTION_DEADLINE_MS = 60_000;
const HERMES_HEARTBEAT_WAIT_MS = 15_000;
let healthInFlight: ReturnType<typeof collectSystemHealth> | null = null;

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

/** Self-upgrade status for the heartbeat, with the sticky local enrollment marker. */
async function heartbeatSelfUpgrade(): Promise<ReturnType<typeof selfUpgradeStatus>> {
  const marker = await commandLedger.enrollmentMarker();
  if (marker.error) logger.warn(`Local enrollment marker could not be read: ${marker.error}`);
  return { ...selfUpgradeStatus(AGENT_VERSION), ...heartbeatDrift(commandLedger),
    managedEnrollment: marker.marker ? { nodeId: marker.marker.nodeId, nodeFqdn: marker.marker.nodeFqdn } : null, managedEnrollmentState: marker.state };
}

/** Stop the heartbeat loop. */
export function stopHeartbeatLoop(): void {
  heartbeatRunning = false;
  stopVersionProbeListener?.();
  stopVersionProbeListener = null;
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
  // A slow Hermes version probe settles in the background after discovery has
  // already reported the binary without a version: refresh the snapshot once it
  // has, after any refresh still in flight.
  stopVersionProbeListener ??= onHermesVersionProbeSettled(() => {
    if (heartbeatRunning) void (hermesRefreshInFlight ?? Promise.resolve()).then(() => refreshHermesSnapshot(true));
  });

  const send = async (): Promise<void> => {
    if (!heartbeatRunning) return;

    const span = startSpan('heartbeat.send', { kind: 'client' });
    let posting = false;

    try {
      const health = await collectHealthWithDeadline();
      // A cached Hermes snapshot is sent while a stale one refreshes in the
      // background; without one, wait briefly so the first heartbeat can carry it.
      const refresh = refreshHermesSnapshot(!hermesSnapshot);
      if (!hermesSnapshot) await Promise.race([refresh, delay(HERMES_HEARTBEAT_WAIT_MS, undefined, { ref: false })]);
      const hermes = hermesSnapshot;

      const selfUpgrade = await heartbeatSelfUpgrade();
      posting = true;
      const identity = boundNodeIdentity();
      const heartbeatUrl = `${CONTROL_API_URL}/api/v1/heartbeat`;
      // Serialized here so the signature covers the exact bytes sent.
      const payload = JSON.stringify({
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
          nodeVersion: process.version,
          selfUpgrade,
          // Which server keys this agent pins: the server stops sending it the shared secret once it signs with one of them.
          // `evidence: 1`: this agent signs its evidence with the node key (the server then refuses HMAC-only evidence for it).
          ...(identity ? { nodeAuth: { serverKeyIds: identity.binding.serverKeys.map(key => key.keyId),
            ...(identity.binding.serverEvidence ? { evidence: 1 } : {}) } } : {}),
      });
      await ky.post(heartbeatUrl, {
        body: payload,
        headers: {
          'content-type': 'application/json',
          ...controlApiAuthHeaders('POST', heartbeatUrl, payload),
          'traceparent': formatTraceparent(span.traceId, span.spanId),
        },
        timeout: 10_000,
        retry: 0,
        fetch: controlApiFetch,
        hooks: { afterResponse: [({ response }) => { noteControlApiResponse(response); }] },
      }).json<unknown>().then((raw) => {
        const resp = parseHeartbeatAcknowledgement(raw);
        onHeartbeatAcknowledged(resp.data.nodeAuth);
        // The first accepted heartbeat from a version on trial confirms the upgrade.
        if (resp.data?.accepted && confirmTrial(AGENT_VERSION)) logger.info(`Self-upgrade to ${AGENT_VERSION} confirmed`);
        if (resp.data?.updateAvailable && resp.data.expectedVersion) {
          logger.info(`Agent update available: ${AGENT_VERSION} → ${resp.data.expectedVersion} (upgrade from the console's Nodes page or with \`magnus-server agents upgrade\`)`);
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
      // On trial: tell the launcher this version is alive, and retry at a fixed short interval.
      const onTrial = trialOf(AGENT_VERSION) !== null;
      if (onTrial && posting && controlApiUnreachable(err)) recordTrialAlive(AGENT_VERSION, message);
      // Back off retry interval: 30s → 60s → 120s … capped at 5min
      const backoffMs = onTrial ? TRIAL_RETRY_MS : Math.min(
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
