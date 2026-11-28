/**
 * History retention for the tables that otherwise only grow.
 *
 * Off unless MAGNUS_HISTORY_RETENTION_DAYS is set. Once a day it deletes, older than that many days:
 * finished commands (with their results) that no unsettled resource lease or managed cron
 * occurrence still names, finished webhook deliveries, resolved alert violations, finished cron
 * executions, completed managed cron occurrences, resolved anomaly events (which frees the health
 * snapshots they kept from health retention) and AI conversations nobody touched since (unless one
 * of their messages still waits for a tool approval). It also deletes finished file pushes (with
 * the file content they carried), finished rollouts (with their targets), finished remediation
 * executions whose command is no longer in flight, finished deploy and Hermes operation jobs, and
 * superseded drift scans, Ardent agent operations and Hermes registry receipts. For those last
 * three the newest row per node (drift), per profile and kind plus the newest success per profile
 * (Ardent: credential adoption reads it) and per registry item (receipts) always stays.
 * Unresolved or in-flight rows are never deleted, whatever their age.
 */
import { getDb } from '../db/index.js';
import { errorText } from '../utils/redact.js';
import { logAuditEvent } from './audit-service.js';

const CHECK_INTERVAL_MS = 3_600_000;
let timer: ReturnType<typeof setInterval> | null = null;
let lastPrunedDate: string | null = null;

/** Days of history to keep, or null when retention is off (the default). */
export function historyRetentionDays(): number | null {
  const raw = process.env['MAGNUS_HISTORY_RETENTION_DAYS']?.trim();
  if (!raw) return null;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 7 ? days : null;
}

export type HistoryPruneCounts = Record<'commands' | 'webhookDeliveries' | 'alertViolations' | 'cronExecutions'
  | 'cronOccurrences' | 'anomalies' | 'aiConversations' | 'filePatches' | 'rollouts' | 'remediations' | 'deployJobs'
  | 'hermesOperationJobs' | 'driftScans' | 'ardentOperations' | 'hermesRegistryReceipts', number>;

export async function pruneHistory(days: number, now = new Date()): Promise<HistoryPruneCounts> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  // Occurrences first, so the commands they named become prunable in the same pass.
  const cronOccurrences = (await db.managedCronOccurrence.deleteMany({ where: { state: 'completed', createdAt: { lt: cutoff } } })).count;
  const commands = await db.$executeRaw`
    DELETE FROM "remote_commands" AS command
    WHERE command."status" IN ('COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED')
      AND command."createdAt" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "command_resource_leases" AS lease
        WHERE lease."commandId" = command."id" AND lease."state" <> 'released')
      AND NOT EXISTS (SELECT 1 FROM "managed_cron_occurrences" AS occurrence
        WHERE occurrence."commandId" = command."id")
      AND NOT EXISTS (SELECT 1 FROM "rollout_targets" AS target
        JOIN "execution_runs" AS run ON run."id" = target."rolloutId"
        WHERE target."commandId" = command."id" AND run."status" IN ('created', 'running', 'paused'))
      AND NOT EXISTS (SELECT 1 FROM "EmbermendOperation" AS operation
        WHERE operation."commandId" = command."id")
  `;
  const webhookDeliveries = (await db.webhookDelivery.deleteMany({ where: { status: { in: ['success', 'failed'] }, createdAt: { lt: cutoff } } })).count;
  const alertViolations = (await db.alertViolation.deleteMany({ where: { status: 'resolved', resolvedAt: { lt: cutoff } } })).count;
  const cronExecutions = (await db.cronJobExecution.deleteMany({ where: { completedAt: { lt: cutoff } } })).count;
  const anomalies = (await db.anomalyEvent.deleteMany({ where: { resolved: true, resolvedAt: { lt: cutoff } } })).count;
  // A conversation still waiting for a tool approval is kept: deleting it would silently drop a
  // decision someone was asked to make.
  const aiConversations = (await db.aiConversation.deleteMany({
    where: { updatedAt: { lt: cutoff }, messages: { none: { pendingApproval: { not: null } } } },
  })).count;
  // Finished pushes only: a pending one is still being delivered. They carry the pushed file content.
  const filePatches = (await db.filePatchTask.deleteMany({ where: { status: { in: ['completed', 'failed'] }, createdAt: { lt: cutoff } } })).count;
  // A remediation still waiting for its rollout to be admitted reads that rollout, so its run stays.
  const rollouts = await db.$executeRaw`
    DELETE FROM "execution_runs" AS run
    WHERE run."status" IN ('completed', 'failed', 'cancelled')
      AND COALESCE(run."completedAt", run."createdAt") < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "remediation_executions" AS remediation
        WHERE 'remediation_' || remediation."id" = run."id"
          AND remediation."status" NOT IN ('completed', 'failed', 'skipped'))
  `;
  const remediations = await db.$executeRaw`
    DELETE FROM "remediation_executions" AS remediation
    WHERE remediation."status" IN ('completed', 'failed', 'skipped')
      AND COALESCE(remediation."completedAt", remediation."triggeredAt") < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "remote_commands" AS command
        WHERE command."correlationId" = 'remediation_' || remediation."id"
          AND command."status" IN ('PENDING', 'QUEUED', 'RUNNING'))
  `;
  const deployJobs = (await db.deployJob.deleteMany({
    where: { status: { in: ['completed', 'partial_failure'] }, OR: [{ completedAt: { lt: cutoff } }, { completedAt: null, startedAt: { lt: cutoff } }] },
  })).count;
  const hermesOperationJobs = (await db.hermesOperationJob.deleteMany({
    where: { status: { in: ['completed', 'failed', 'cancelled'] }, OR: [{ completedAt: { lt: cutoff } }, { completedAt: null, startedAt: { lt: cutoff } }] },
  })).count;
  // The newest scan of each node is what GET /drift/:nodeId/latest answers.
  const driftScans = await db.$executeRaw`
    DELETE FROM "drift_scans" AS scan
    WHERE scan."scannedAt" < ${cutoff}
      AND EXISTS (SELECT 1 FROM "drift_scans" AS newer
        WHERE newer."nodeId" = scan."nodeId"
          AND (newer."scannedAt", newer."id") > (scan."scannedAt", scan."id"))
  `;
  const ardentOperations = await db.$executeRaw`
    WITH ranked AS (
      SELECT "id",
        ROW_NUMBER() OVER (PARTITION BY "nodeId", "profile", "kind" ORDER BY "createdAt" DESC, "id" DESC) AS "kindRank",
        CASE WHEN "status" = 'succeeded'
          THEN ROW_NUMBER() OVER (PARTITION BY "nodeId", "profile", ("status" = 'succeeded') ORDER BY "completedAt" DESC NULLS LAST, "id" DESC)
        END AS "successRank"
      FROM "ardent_agent_operations"
    )
    DELETE FROM "ardent_agent_operations" AS operation
    USING ranked
    WHERE operation."id" = ranked."id"
      AND operation."status" IN ('succeeded', 'failed')
      AND COALESCE(operation."completedAt", operation."updatedAt") < ${cutoff}
      AND ranked."kindRank" > 1
      AND COALESCE(ranked."successRank", 2) > 1
  `;
  const hermesRegistryReceipts = await db.$executeRaw`
    DELETE FROM "hermes_registry_receipts" AS receipt
    WHERE receipt."createdAt" < ${cutoff}
      AND EXISTS (SELECT 1 FROM "hermes_registry_receipts" AS newer
        WHERE newer."installationId" = receipt."installationId" AND newer."profileId" = receipt."profileId"
          AND newer."kind" = receipt."kind" AND newer."slug" = receipt."slug"
          AND (newer."createdAt", newer."id") > (receipt."createdAt", receipt."id"))
  `;
  return { commands, webhookDeliveries, alertViolations, cronExecutions, cronOccurrences, anomalies, aiConversations,
    filePatches, rollouts, remediations, deployJobs, hermesOperationJobs, driftScans, ardentOperations, hermesRegistryReceipts };
}

async function tick(): Promise<void> {
  const days = historyRetentionDays();
  if (days === null) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastPrunedDate === today) return;
  try {
    const counts = await pruneHistory(days);
    lastPrunedDate = today;
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      console.log(`[history-retention] pruned rows older than ${days} days: ${JSON.stringify(counts)}`);
      await logAuditEvent({ action: 'history.retention', actorId: 'system', actorType: 'system', targetType: 'database', targetId: 'history',
        details: { retentionDays: days, ...counts } }).catch((error: unknown) => console.error(`[history-retention] audit failed: ${errorText(error)}`));
    }
  } catch (error) {
    console.error(`[history-retention] prune failed: ${errorText(error)}`);
  }
}

export function startHistoryRetention(): boolean {
  if (timer) return true;
  const days = historyRetentionDays();
  if (days === null) return false;
  console.log(`[history-retention] keeping ${days} days of command, webhook, alert, cron, anomaly, AI conversation, rollout, remediation, file push and operation history`);
  void tick();
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref?.();
  return true;
}

export function stopHistoryRetention(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
