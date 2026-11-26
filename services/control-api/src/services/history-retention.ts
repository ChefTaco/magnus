/**
 * History retention for the tables that otherwise only grow.
 *
 * Off unless MAGNUS_HISTORY_RETENTION_DAYS is set. Once a day it deletes, older than that many days:
 * finished commands (with their results) that no unsettled resource lease or managed cron
 * occurrence still names, finished webhook deliveries, resolved alert violations, finished cron
 * executions, completed managed cron occurrences, resolved anomaly events (which frees the health
 * snapshots they kept from health retention) and AI conversations nobody touched since (unless one
 * of their messages still waits for a tool approval).
 * Unresolved or in-flight rows are never deleted, whatever their age.
 */
import { getDb } from '../db/index.js';
import { errorText } from '../utils/redact.js';

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
  | 'cronOccurrences' | 'anomalies' | 'aiConversations', number>;

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
  return { commands, webhookDeliveries, alertViolations, cronExecutions, cronOccurrences, anomalies, aiConversations };
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
    if (total > 0) console.log(`[history-retention] pruned rows older than ${days} days: ${JSON.stringify(counts)}`);
  } catch (error) {
    console.error(`[history-retention] prune failed: ${errorText(error)}`);
  }
}

export function startHistoryRetention(): boolean {
  if (timer) return true;
  const days = historyRetentionDays();
  if (days === null) return false;
  console.log(`[history-retention] keeping ${days} days of command, webhook, alert, cron, anomaly and AI conversation history`);
  void tick();
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref?.();
  return true;
}

export function stopHistoryRetention(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
