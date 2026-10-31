import { recordMonitorPulse } from './monitor-pulse.js';
import { getDb } from '../db/index.js';
import { createNotificationInTransaction } from './notification-service.js';
import { matchingMaintenance } from './maintenance-service.js';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';

// ─── Node Issue Monitor — periodic heartbeat-staleness checker ───

/** Nodes with no heartbeat for this many ms are considered offline. */
const OFFLINE_THRESHOLD_MS = 120_000; // 120 seconds

/** How often to run the check (ms). */
const CHECK_INTERVAL_MS = 30_000; // every 30 seconds

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Scan for nodes whose lastHeartbeatAt is older than the offline threshold.
 * Transitions them to OFFLINE and creates a notification.
 * Also detects recovery: nodes that came back ONLINE after being OFFLINE.
 */
async function checkStaleNodes(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS);

  // ── Detect nodes that should go OFFLINE ──
  const staleNodes = await db.node.findMany({
    where: {
      status: { in: ['ONLINE', 'DEGRADED'] },
      lastHeartbeatAt: { lt: cutoff },
      id: { notIn: SENTINEL_NODE_IDS },
    },
    select: { id: true, name: true, hostname: true, status: true, lastHeartbeatAt: true },
  });

  for (const node of staleNodes) {
    const previousStatus = node.status;

    const maintenance = await matchingMaintenance(node.id);
    await db.$transaction(async tx => {
      const changed = await tx.node.updateMany({
        where: { id: node.id, status: { in: ['ONLINE', 'DEGRADED'] }, lastHeartbeatAt: { lt: cutoff } },
        data: { status: 'OFFLINE' },
      });
      if (!changed.count) return;
      await createNotificationInTransaction(tx, {
      type: 'node.offline',
      severity: 'critical',
      title: `${node.name} went offline`,
      message: `Node ${node.name} (${node.hostname}) has not sent a heartbeat since ${node.lastHeartbeatAt?.toISOString() ?? 'never'}. Previous status: ${previousStatus}.`,
      nodeId: node.id,
      nodeName: node.name,
      metadata: {
        previousStatus,
        lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
      },
      }, maintenance?.id ?? null);
    });
  }
  recordMonitorPulse('nodes');
}

/** Start the periodic node-issue monitor. */
export function startNodeIssueMonitor(): void {
  if (timer) return; // Already running
  console.log('🔔 Node issue monitor started (check every 30s, offline threshold 120s)');
  // Run an initial check immediately, then on interval
  void checkStaleNodes().catch(() => console.error('[nodes] monitoring pending'));
  timer = setInterval(() => void checkStaleNodes().catch(() => console.error('[nodes] monitoring pending')), CHECK_INTERVAL_MS);
}

/** Stop the monitor (useful for tests / graceful shutdown). */
export function stopNodeIssueMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
