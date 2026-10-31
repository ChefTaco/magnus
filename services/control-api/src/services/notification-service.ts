import { matchingMaintenance } from './maintenance-service.js';
import { getDb, type Prisma } from '../db/index.js';
import { createWebhookDeliveries } from './webhook-service.js';
import type { NotificationType, NotificationSeverity } from '../types/index.js';

// ─── Notification Service — create, list, read, dedupe ───

/** Cooldown window to prevent duplicate notifications for the same event. */
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

interface CreateNotificationInput {
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  nodeId?: string | null;
  nodeName?: string | null;
  sourceRef?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Create a notification with built-in dedupe.
 * If an identical (type + nodeId + sourceRef) notification was created within the cooldown window,
 * we skip creation to avoid alert spam from transient flapping.
 */
export async function createNotification(input: CreateNotificationInput): Promise<string | null> {
  const db = getDb();

  const maintenance = await matchingMaintenance(input.nodeId, typeof input.metadata?.['serviceId'] === 'string' ? input.metadata['serviceId'] : null);
  return db.$transaction(tx => createNotificationInTransaction(tx, input, maintenance?.id ?? null));
}

/** The notification and its pending webhook rows are one durable outbox write. */
export async function createNotificationInTransaction(
  tx: Prisma.TransactionClient, input: CreateNotificationInput, maintenanceId: string | null,
): Promise<string | null> {
  const identity = JSON.stringify([input.type, input.nodeId ?? null, input.sourceRef ?? null]);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification:${identity}`}, 0))`;
  const existing = await tx.notification.findFirst({ where: {
      type: input.type, nodeId: input.nodeId ?? null, sourceRef: input.sourceRef ?? null,
      createdAt: { gte: new Date(Date.now() - COOLDOWN_MS) },
  }, select: { id: true } });
  if (existing) return null;
  const notification = await tx.notification.create({ data: {
      type: input.type, severity: input.severity, title: input.title, message: input.message,
      nodeId: input.nodeId ?? null, nodeName: input.nodeName ?? null, sourceRef: input.sourceRef ?? null,
      metadata: JSON.stringify(input.metadata ?? {}), suppressedBy: maintenanceId,
  } });
  if (!maintenanceId) await createWebhookDeliveries(tx, input.type, {
      notificationId: notification.id, ...input, metadata: input.metadata ?? {},
      createdAt: notification.createdAt.toISOString(),
  });
  return notification.id;
}

interface ListNotificationsParams {
  page?: number;
  pageSize?: number;
  isRead?: boolean;
  severity?: string;
  type?: string;
  nodeId?: string;
}

export async function listNotifications(params: ListNotificationsParams): Promise<{
  notifications: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
}> {
  const db = getDb();
  const page = params.page ?? 1;
  const pageSize = Math.min(params.pageSize ?? 50, 100);
  const skip = (page - 1) * pageSize;

  const where: Record<string, unknown> = {};
  if (params.isRead !== undefined) where['isRead'] = params.isRead;
  if (params.severity) where['severity'] = params.severity;
  if (params.type) where['type'] = params.type;
  if (params.nodeId) where['nodeId'] = params.nodeId;

  const [notifications, total] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    db.notification.count({ where }),
  ]);

  return {
    notifications: notifications.map((n) => ({
      ...n,
      metadata: JSON.parse(n.metadata as string),
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt?.toISOString() ?? null,
    })),
    total,
    page,
    pageSize,
  };
}

export async function getUnreadCount(): Promise<number> {
  const db = getDb();
  return db.notification.count({ where: { isRead: false } });
}

export async function markRead(ids: string[]): Promise<number> {
  const db = getDb();
  const result = await db.notification.updateMany({
    where: { id: { in: ids }, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return result.count;
}

export async function markAllRead(): Promise<number> {
  const db = getDb();
  const result = await db.notification.updateMany({
    where: { isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return result.count;
}
