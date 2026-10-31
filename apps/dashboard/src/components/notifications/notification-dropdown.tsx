'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  Check,
  CheckCheck,
  AlertTriangle,
  AlertCircle,
  Info,
  Server,
  Terminal,
  Rocket,
  ArrowUpCircle,
  HeartPulse,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api-client';
import Link from 'next/link';

// ── Types ──

interface NotificationItem {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  nodeId: string | null;
  nodeName: string | null;
  isRead: boolean;
  createdAt: string;
}

// ── Icon / color helpers ──

function severityIcon(severity: string): React.ReactElement {
  switch (severity) {
    case 'critical':
      return <AlertCircle className="h-4 w-4 text-danger" />;
    case 'warning':
      return <AlertTriangle className="h-4 w-4 text-warning" />;
    default:
      return <Info className="h-4 w-4 text-primary" />;
  }
}

function typeIcon(type: string): React.ReactElement {
  switch (type) {
    case 'node.offline':
      return <Server className="h-3.5 w-3.5 text-danger" />;
    case 'node.degraded':
      return <Server className="h-3.5 w-3.5 text-warning" />;
    case 'node.recovered':
      return <HeartPulse className="h-3.5 w-3.5 text-success" />;
    case 'command.failed':
      return <Terminal className="h-3.5 w-3.5 text-warning" />;
    case 'deploy.failed':
      return <Rocket className="h-3.5 w-3.5 text-danger" />;
    case 'upgrade.failed':
      return <ArrowUpCircle className="h-3.5 w-3.5 text-danger" />;
    default:
      return <Bell className="h-3.5 w-3.5 text-text-muted" />;
  }
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Main component ──

export function NotificationDropdown(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Fetch unread count (polled every 15s) ──
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await api.notifications.unreadCount();
      if (res.success && res.data) {
        setUnreadCount((res.data as { count: number }).count);
      }
    } catch {
      // silently ignore polling errors
    }
  }, []);

  // ── Fetch notification list ──
  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.notifications.list({ pageSize: 20 });
      if (res.success && res.data) {
        const data = res.data as { notifications: NotificationItem[] };
        setNotifications(data.notifications);
      }
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Poll unread count ──
  useEffect(() => {
    void fetchUnreadCount();
    const interval = setInterval(() => void fetchUnreadCount(), 15_000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  // ── Load notifications when dropdown opens ──
  useEffect(() => {
    if (open) void fetchNotifications();
  }, [open, fetchNotifications]);

  // ── Close on click outside ──
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // ── Close on Escape ──
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // ── Mark single notification read ──
  const handleMarkRead = async (id: string): Promise<void> => {
    try {
      await api.notifications.markRead([id]);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // ignore
    }
  };

  // ── Mark all read ──
  const handleMarkAllRead = async (): Promise<void> => {
    try {
      await api.notifications.markAllRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
      // Re-fetch to ensure server state is in sync
      setTimeout(() => void fetchUnreadCount(), 500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button */}
      <button
        className="relative rounded p-2 text-text-muted transition-all hover:bg-surface-hover hover:text-text"
        title="Notifications"
        type="button"
        aria-expanded={open}
        aria-controls="notification-panel"
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div id="notification-panel" role="region" aria-label="Notifications" className="absolute right-0 top-full z-50 mt-2 w-96 overflow-hidden rounded border border-border bg-surface shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-text">Notifications</h3>
            {unreadCount > 0 && (
              <button
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10 transition-all"
                onClick={() => void handleMarkAllRead()}
                type="button"
              >
                <CheckCheck className="h-3 w-3" />
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-96 overflow-y-auto">
            {loading && notifications.length === 0 && (
              <div className="flex items-center justify-center py-8">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            )}

            {!loading && notifications.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 text-text-muted">
                <Bell className="mb-2 h-8 w-8 opacity-40" />
                <p className="text-xs">No notifications yet</p>
              </div>
            )}

            {notifications.map((n) => (
              <div
                key={n.id}
                className={cn(
                  'group flex items-start gap-3 border-b border-border/50 px-4 py-3 transition-all hover:bg-surface-hover',
                  !n.isRead && 'bg-primary/5',
                )}
              >
                <div className="mt-0.5 shrink-0">{severityIcon(n.severity)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {typeIcon(n.type)}
                    <span className={cn('text-xs font-bold', n.isRead ? 'text-text-muted' : 'text-text')}>
                      {n.title}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted line-clamp-2">{n.message}</p>
                  <span className="mt-1 block text-[10px] text-text-muted/60">{timeAgo(n.createdAt)}</span>
                </div>
                {!n.isRead && (
                  <button
                    className="mt-0.5 shrink-0 rounded p-1 text-text-muted opacity-0 transition-all hover:bg-surface-hover hover:text-primary group-hover:opacity-100"
                    title="Mark as read"
                    type="button"
                    onClick={() => void handleMarkRead(n.id)}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="border-t border-border px-4 py-2 flex justify-end">
            <Link
              href="/notifications"
              className="flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors"
              onClick={() => setOpen(false)}
            >
              <Settings className="h-3 w-3" />
              Preferences
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
