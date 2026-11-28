/**
 * Audit log retention. Off unless MAGNUS_AUDIT_RETENTION_DAYS is set (at least 90): audit records
 * are kept forever by default, because compliance rules decide how long they must exist, not
 * Magnus. Once a day it deletes the daily audit files (AUDIT_LOG_DIR, one HMAC chain per UTC day)
 * older than that many days and records the deletion as an `audit.retention` event in today's file.
 */
import { logAuditEvent, pruneAuditDays } from './audit-service.js';
import { errorText } from '../utils/redact.js';

const CHECK_INTERVAL_MS = 3_600_000;
export const MIN_AUDIT_RETENTION_DAYS = 90;
let timer: ReturnType<typeof setInterval> | null = null;
let lastPrunedDate: string | null = null;

/** Days of audit log to keep, or null when audit retention is off (the default). */
export function auditRetentionDays(): number | null {
  const raw = process.env['MAGNUS_AUDIT_RETENTION_DAYS']?.trim();
  if (!raw) return null;
  const days = Number(raw);
  return Number.isInteger(days) && days >= MIN_AUDIT_RETENTION_DAYS ? days : null;
}

/** First UTC day that is kept: `days` whole days before today. */
export function auditCutoffDay(days: number, now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * 86_400_000).toISOString().slice(0, 10);
}

export async function pruneAuditLogs(days: number, now = new Date()): Promise<string[]> {
  const keepFrom = auditCutoffDay(days, now);
  const removed = await pruneAuditDays(keepFrom, now);
  if (removed.length) {
    await logAuditEvent({
      action: 'audit.retention', actorId: 'system', actorType: 'system', targetType: 'audit_log', targetId: 'audit-logs',
      details: { retentionDays: days, keptFrom: keepFrom, removedDays: removed.length, oldestRemoved: removed[0], newestRemoved: removed.at(-1) },
    });
  }
  return removed;
}

async function tick(): Promise<void> {
  const days = auditRetentionDays();
  if (days === null) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastPrunedDate === today) return;
  try {
    const removed = await pruneAuditLogs(days);
    lastPrunedDate = today;
    if (removed.length) console.log(`[audit-retention] removed ${removed.length} audit day(s) older than ${days} days (${removed[0]} to ${removed.at(-1)})`);
  } catch (error) {
    console.error(`[audit-retention] prune failed: ${errorText(error)}`);
  }
}

export function startAuditRetention(): boolean {
  if (timer) return true;
  const days = auditRetentionDays();
  if (days === null) return false;
  console.log(`[audit-retention] keeping ${days} days of audit log`);
  void tick();
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref?.();
  return true;
}

export function stopAuditRetention(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
