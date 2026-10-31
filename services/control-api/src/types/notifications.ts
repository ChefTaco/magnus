// ─── Notifications ───

export type NotificationType =
  | 'node.offline'
  | 'node.degraded'
  | 'node.recovered'
  | 'command.failed'
  | 'deploy.failed'
  | 'upgrade.failed'
  | 'ai.heartbeat'
  | 'ai.anomaly'
  | 'prediction.cpu'
  | 'prediction.memory'
  | 'prediction.swap'
  | 'prediction.disk'
  | 'hermes.deploy.failed'
  | 'hermes.installation.degraded'
  | 'hermes.migration.failed';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface Notification {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  nodeId: string | null;
  nodeName: string | null;
  sourceRef: string | null;
  metadata: Record<string, unknown>;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListParams {
  page?: number;
  pageSize?: number;
  isRead?: boolean;
  severity?: NotificationSeverity;
  type?: NotificationType;
  nodeId?: string;
}

export interface NotificationUnreadCount {
  count: number;
}

export interface NotificationMarkReadRequest {
  ids: string[];
}
