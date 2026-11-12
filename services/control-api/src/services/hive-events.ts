/**
 * The HiveEvent v1 feed (`GET /api/v1/hive/events`): Magnus notifications as suite events, read by
 * the HiveXUI inbox. Every event derives from one stored notification, so the feed adds no table.
 *
 * Order is oldest first by (occurredAt, id); the cursor encodes that position. The window is the
 * last 14 days. Ardent notifications stay ADMIN-only, as on the Ardent routes. Each event is
 * validated strictly before it is served; one that fails is dropped and logged without content.
 */
import { decodeCursor, encodeCursor, feedPage, validateHiveEvent, type HiveEvent, type HiveEventSeverity } from '@hivemagnus/hive-common/events';
import { isAgentRef, isIdentifier } from '@hivemagnus/hive-common/contracts';
import { redactText } from '@hivemagnus/hive-common/log';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';

export const HIVE_EVENTS_PRODUCT = 'magnus';
/** How far back the feed reaches. */
export const HIVE_EVENTS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Where HiveXUI serves the Magnus pages. Links are HiveXUI paths, not the standalone dashboard's. */
export const HIVEXUI_FLEET_PREFIX = '/fleet';

export interface HiveEventAccess {
  /** Whether the caller may read Ardent notifications (ADMIN only, as on the Ardent routes). */
  ardent: boolean;
}

/** The notification columns the feed reads. */
export interface NotificationRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  nodeId: string | null;
  nodeName: string | null;
  metadata: string;
  createdAt: Date;
}

interface Position { t: string; id: string }

const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Control characters other than tab and newline never belong in display text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Read a cursor from a previous page. Anything else is a 400. */
export function parseCursor(cursor: string): Position {
  let value: Record<string, string | number>;
  try {
    value = decodeCursor(cursor);
  } catch {
    throw new HttpError(400, 'INVALID_CURSOR', 'after must be a cursor from a previous page');
  }
  const { t, id } = value;
  if (typeof t !== 'string' || typeof id !== 'string' || !ROW_ID.test(id)
    || Number.isNaN(Date.parse(t)) || new Date(t).toISOString() !== t) {
    throw new HttpError(400, 'INVALID_CURSOR', 'after must be a cursor from a previous page');
  }
  return { t, id };
}

export function cursorOf(row: Pick<NotificationRow, 'id' | 'createdAt'>): string {
  return encodeCursor({ t: row.createdAt.toISOString(), id: row.id });
}

/** Magnus writes info, warning and critical; anything else is mapped by its meaning. */
export function hiveSeverity(severity: string): HiveEventSeverity {
  const value = severity.toLowerCase();
  if (value === 'critical' || value === 'error' || value === 'high') return 'critical';
  if (value === 'warning' || value === 'warn' || value === 'medium') return 'warning';
  return 'info';
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const plain = (value: string, max: number) => redactText(value.replace(CONTROL_CHARACTERS, ' ')).trim().slice(0, max);

/**
 * The event summary. Free text that can carry a command line, probe output or an upstream error
 * is replaced by a fixed sentence; the details stay on the Magnus page the link opens.
 */
function summaryOf(row: NotificationRow, metadata: Record<string, unknown>): string {
  const node = row.nodeName ?? 'a node';
  if (row.type === 'command.failed') return `A command failed on ${node}. Open the node in Magnus for its result.`;
  if (row.type.startsWith('application.')) {
    const service = typeof metadata['serviceId'] === 'string' ? metadata['serviceId'] : 'An application';
    return row.type === 'application.recovered'
      ? `${service} passed its readiness checks again.`
      : `${service} failed its readiness checks. Open Magnus for the failing checks.`;
  }
  if (row.type.startsWith('ardent.')) return row.message.split(' Last error:')[0] ?? '';
  return row.message;
}

function linkOf(row: NotificationRow, profile: string | undefined): string {
  if (row.type.startsWith('ardent.') && row.nodeId && profile) {
    return `${HIVEXUI_FLEET_PREFIX}/ardent/profiles/${encodeURIComponent(`${row.nodeId}~${profile}`)}`;
  }
  if (row.nodeId) return `${HIVEXUI_FLEET_PREFIX}/nodes/${encodeURIComponent(row.nodeId)}`;
  return `${HIVEXUI_FLEET_PREFIX}/notifications`;
}

/** Build the HiveEvent for one notification. The result is not validated yet. */
export function notificationToHiveEvent(row: NotificationRow): Record<string, unknown> {
  const metadata = parseMetadata(row.metadata);
  const profile = typeof metadata['profile'] === 'string' ? metadata['profile'] : undefined;
  const actor = [metadata['actorId'], metadata['agentId']].find(isIdentifier);
  const subject: { actorId?: string; agentRef?: string; nodeId?: string } = {};
  if (actor) subject.actorId = actor;
  if (row.nodeId && profile && isAgentRef(`${row.nodeId}~${profile}`)) subject.agentRef = `${row.nodeId}~${profile}`;
  if (row.nodeId && isIdentifier(row.nodeId)) subject.nodeId = row.nodeId;
  return {
    id: `${HIVE_EVENTS_PRODUCT}:notification:${row.id}`,
    product: HIVE_EVENTS_PRODUCT,
    type: row.type,
    severity: hiveSeverity(row.severity),
    title: plain(row.title, 200),
    summary: plain(summaryOf(row, metadata), 2000),
    occurredAt: row.createdAt.toISOString(),
    ...(Object.keys(subject).length ? { subject } : {}),
    link: { product: HIVE_EVENTS_PRODUCT, path: linkOf(row, profile) },
    sourceRef: row.id,
  };
}

/** One feed page: events strictly after the cursor, in feed order. */
export async function listHiveEvents(params: {
  after: string | undefined;
  limit: number;
  access: HiveEventAccess;
  now?: Date;
}): Promise<{ data: HiveEvent[]; nextCursor: string | null }> {
  const position = params.after ? parseCursor(params.after) : null;
  const since = new Date((params.now ?? new Date()).getTime() - HIVE_EVENTS_RETENTION_MS);
  const rows = await getDb().notification.findMany({
    where: {
      createdAt: { gte: since },
      ...(position ? { OR: [
        { createdAt: { gt: new Date(position.t) } },
        { createdAt: new Date(position.t), id: { gt: position.id } },
      ] } : {}),
      ...(params.access.ardent ? {} : { NOT: { type: { startsWith: 'ardent.' } } }),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: params.limit + 1,
    select: { id: true, type: true, severity: true, title: true, message: true, nodeId: true, nodeName: true, metadata: true, createdAt: true },
  });
  // The cursor follows the rows read, so an event dropped below never stalls the feed.
  const page = feedPage(rows, params.limit, cursorOf);
  const data: HiveEvent[] = [];
  for (const row of page.data) {
    const result = validateHiveEvent(notificationToHiveEvent(row), { strict: true });
    if (result.ok) data.push(result.value);
    else console.warn(`[hive-events] dropped notification ${row.id}: ${result.issues.map(issue => issue.split(':')[0]).join(', ')}`);
  }
  return { data, nextCursor: page.nextCursor };
}
