import { getDb } from '../db/index.js';
import { getValidatedEnv } from '../utils/env.js';

const CHECK_INTERVAL_MS = 3_600_000;
let timer: ReturnType<typeof setInterval> | null = null;
let lastPrunedDate: string | null = null;

export interface NotificationRetentionPolicy {
  readDays: number;
  maximumDays: number;
}

export function getNotificationRetentionPolicy(): NotificationRetentionPolicy {
  const env = getValidatedEnv();
  return {
    readDays: env.NOTIFICATION_READ_RETENTION_DAYS,
    maximumDays: env.NOTIFICATION_MAX_RETENTION_DAYS,
  };
}

export async function pruneOldNotifications(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (lastPrunedDate === today) return;

  const policy = getNotificationRetentionPolicy();
  const readCutoff = new Date(Date.now() - policy.readDays * 24 * 60 * 60 * 1000);
  const maximumCutoff = new Date(Date.now() - policy.maximumDays * 24 * 60 * 60 * 1000);

  try {
    const result = await getDb().notification.deleteMany({
      where: {
        OR: [
          { isRead: true, createdAt: { lt: readCutoff } },
          { createdAt: { lt: maximumCutoff } },
        ],
      },
    });
    lastPrunedDate = today;
    if (result.count > 0) {
      console.log(`🗑️  Notification retention: pruned ${result.count} old notifications`);
    }
  } catch (error: unknown) {
    console.error(`Notification retention error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function startNotificationRetention(): void {
  if (timer) return;
  const policy = getNotificationRetentionPolicy();
  console.log(`🗑️  Notification retention started (read ${policy.readDays}d, maximum ${policy.maximumDays}d)`);
  void pruneOldNotifications();
  timer = setInterval(() => void pruneOldNotifications(), CHECK_INTERVAL_MS);
}

export function stopNotificationRetention(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
