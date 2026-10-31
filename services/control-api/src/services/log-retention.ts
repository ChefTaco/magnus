import { getDb } from '../db/index.js';
import { logAuditEvent } from './audit-service.js';

// ─── Log Retention — nightly pruning of old log entries ───

/** How often to check if pruning is needed (ms). */
const CHECK_INTERVAL_MS = 3_600_000; // every hour

let timer: ReturnType<typeof setInterval> | null = null;
let lastPrunedDate: string | null = null;

/** Get the configured retention period in days. */
function getRetentionDays(): number {
  return Number(process.env['LOG_RETENTION_DAYS'] ?? 30);
}

/** Return today's date as YYYY-MM-DD string. */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Delete log entries older than the retention window.
 * Runs at most once per calendar day.
 */
async function pruneOldLogs(): Promise<void> {
  const today = todayStr();
  if (lastPrunedDate === today) return; // already pruned today

  const retentionDays = getRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  try {
    const db = getDb();
    const result = await db.logEntry.deleteMany({
      where: { timestamp: { lt: cutoff } },
    });

    lastPrunedDate = today;
    const deletedCount = result.count;

    if (deletedCount > 0) {
      console.log(`🗑️  Log retention: pruned ${deletedCount} entries older than ${retentionDays} days`);
    }

    await logAuditEvent({
      action: 'log.retention',
      actorId: 'system@magnus.local',
      actorType: 'system',
      targetType: 'logEntry',
      targetId: 'all',
      details: { deletedCount, retentionDays, cutoff: cutoff.toISOString() },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Log retention error: ${message}`);
  }
}

/** Start the periodic log retention service. */
export function startLogRetention(): void {
  if (timer) return; // already running
  const days = getRetentionDays();
  console.log(`🗑️  Log retention started (check hourly, prune entries older than ${days} days)`);
  void pruneOldLogs(); // run immediately on startup
  timer = setInterval(() => void pruneOldLogs(), CHECK_INTERVAL_MS);
}

/** Stop the log retention service (useful for tests / graceful shutdown). */
export function stopLogRetention(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
