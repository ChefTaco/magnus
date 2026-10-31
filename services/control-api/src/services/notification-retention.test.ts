import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteMany = vi.fn().mockResolvedValue({ count: 42 });
vi.mock('../db/index.js', () => ({
  getDb: () => ({ notification: { deleteMany } }),
}));

const { getNotificationRetentionPolicy, pruneOldNotifications } = await import('./notification-retention.js');

describe('notification retention', () => {
  beforeEach(() => {
    delete process.env['NOTIFICATION_READ_RETENTION_DAYS'];
    delete process.env['NOTIFICATION_MAX_RETENTION_DAYS'];
    vi.clearAllMocks();
  });

  it('uses bounded defaults for read and unread notifications', () => {
    expect(getNotificationRetentionPolicy()).toEqual({ readDays: 30, maximumDays: 90 });
  });

  it('prunes read notifications sooner while bounding every notification', async () => {
    await pruneOldNotifications();
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { isRead: true, createdAt: { lt: expect.any(Date) } },
          { createdAt: { lt: expect.any(Date) } },
        ],
      },
    });
  });
});
