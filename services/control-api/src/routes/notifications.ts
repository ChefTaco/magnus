import { Hono } from 'hono';
import { z } from 'zod';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
} from '../services/notification-service.js';
import { parseBody } from '../utils/validate.js';
import { notificationReadSchema } from '../schemas/logs.js';
import { getDb } from '../db/client.js';

export const notificationsRouter = new Hono<AppVariables>();

// All routes require authentication
notificationsRouter.use('*', authMiddleware);

/**
 * GET /notifications
 * List notifications (paginated, filterable).
 */
notificationsRouter.get('/', async (c) => {
  const params = {
    page: Number(c.req.query('page') ?? 1),
    pageSize: Number(c.req.query('pageSize') ?? 50),
    isRead: c.req.query('isRead') !== undefined ? c.req.query('isRead') === 'true' : undefined,
    severity: c.req.query('severity') ?? undefined,
    type: c.req.query('type') ?? undefined,
    nodeId: c.req.query('nodeId') ?? undefined,
  };

  const result = await listNotifications(params);
  return c.json({ success: true, data: result });
});

/**
 * GET /notifications/unread-count
 * Return number of unread notifications.
 */
notificationsRouter.get('/unread-count', async (c) => {
  const count = await getUnreadCount();
  return c.json({ success: true, data: { count } });
});

/**
 * POST /notifications/read
 * Mark specific notifications as read.
 * Body: { ids: string[] }
 */
notificationsRouter.post('/read', async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, notificationReadSchema);

  const count = await markRead(body.ids);

  await logAuditEvent({
    action: 'notification.read',
    actorId: user.userId,
    targetType: 'notification',
    targetId: body.ids.join(','),
    details: { count },
  });

  return c.json({ success: true, data: { marked: count } });
});

/**
 * POST /notifications/read-all
 * Mark all notifications as read.
 */
notificationsRouter.post('/read-all', async (c) => {
  const user = getUser(c);
  const count = await markAllRead();

  await logAuditEvent({
    action: 'notification.read_all',
    actorId: user.userId,
    targetType: 'notification',
    targetId: '*',
    details: { count },
  });

  return c.json({ success: true, data: { marked: count } });
});

// ── Notification Preferences ──

const prefSchema = z.object({
  channel: z.enum(['in_app', 'email', 'webhook']).default('in_app'),
  category: z.string().min(1),
  enabled: z.boolean(),
  minSeverity: z.enum(['info', 'warning', 'critical']).default('info'),
});

const bulkPrefSchema = z.object({
  preferences: z.array(prefSchema).min(1).max(100),
});

/**
 * GET /notifications/preferences
 * Get the current user's notification preferences.
 */
notificationsRouter.get('/preferences', async (c) => {
  const user = getUser(c);
  const db = getDb();
  const prefs = await db.notificationPreference.findMany({
    where: { userId: user.userId },
    orderBy: { category: 'asc' },
  });
  return c.json({ success: true, data: prefs });
});

/**
 * PUT /notifications/preferences
 * Bulk upsert notification preferences.
 */
notificationsRouter.put('/preferences', async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, bulkPrefSchema);
  const db = getDb();

  const results = await db.$transaction(
    body.preferences.map((pref) =>
      db.notificationPreference.upsert({
        where: {
          userId_channel_category: {
            userId: user.userId,
            channel: pref.channel,
            category: pref.category,
          },
        },
        update: {
          enabled: pref.enabled,
          minSeverity: pref.minSeverity,
        },
        create: {
          userId: user.userId,
          channel: pref.channel,
          category: pref.category,
          enabled: pref.enabled,
          minSeverity: pref.minSeverity,
        },
      }),
    ),
  );

  await logAuditEvent({
    action: 'notification.preferences_update',
    actorId: user.userId,
    targetType: 'notification_preference',
    targetId: user.userId,
    details: { count: results.length },
  });

  return c.json({ success: true, data: results });
});
