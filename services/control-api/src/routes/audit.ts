import { optional } from '../utils/optional.js';
import { pagination } from '../utils/query.js';
import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { listAuditDays, queryAuditEvents, verifyAuditIntegrity } from '../services/audit-service.js';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { csvRow } from '../utils/csv.js';

export const auditRouter = new Hono<AppVariables>();
auditRouter.use('*', authMiddleware);

/** The `date` query parameter: a day key, or nothing for today. Anything else is a 400. */
function auditDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', 'date must be YYYY-MM-DD');
  return value;
}

// ── List available day keys ──
auditRouter.get('/days', async (c) => {
  const days = await listAuditDays();
  return c.json({ success: true, data: days });
});

// ── Query audit events for a given day ──
auditRouter.get('/', async (c) => {
  const { page, pageSize } = pagination(c, { pageSize: 50, maxPageSize: 200 });
  const date = auditDate(c.req.query('date'));
  const action = c.req.query('action') ?? undefined;
  const actorId = c.req.query('actorId') ?? undefined;

  const result = await queryAuditEvents({ ...optional("date", date), ...optional("action", action), ...optional("actorId", actorId), page, pageSize });

  return c.json({
    success: true,
    data: result.events,
    meta: { verification: result.verification, total: result.total, page: result.page, pageSize: result.pageSize, hasMore: result.page * result.pageSize < result.total },
  });
});

// ── Export audit events as CSV or JSON ──
auditRouter.get('/export', async (c) => {
  const format = (c.req.query('format') ?? 'csv') as 'csv' | 'json';
  const from = c.req.query('from');
  const to = c.req.query('to');

  // Collect all matching events across date range
  const days = await listAuditDays();
  const fromDate = from ? new Date(from) : new Date(0);
  const toDate = to ? new Date(to) : new Date();
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'from and to must be dates');
  }

  const filteredDays = days.filter((d) => {
    const dayDate = new Date(d);
    return dayDate >= new Date(fromDate.toISOString().slice(0, 10)) &&
           dayDate <= new Date(toDate.toISOString().slice(0, 10));
  });

  const allEvents: Array<Record<string, unknown>> = [];
  for (const day of filteredDays) {
    const result = await queryAuditEvents({ date: day, pageSize: 200 });
    allEvents.push(...result.events as unknown as Array<Record<string, unknown>>);
    // Fetch remaining pages
    const totalPages = Math.ceil(result.total / 200);
    for (let p = 2; p <= totalPages; p++) {
      const page = await queryAuditEvents({ date: day, page: p, pageSize: 200 });
      allEvents.push(...page.events as unknown as Array<Record<string, unknown>>);
    }
  }

  // Filter by exact timestamps
  const filtered = allEvents.filter((e) => {
    const ts = new Date(e.timestamp as string);
    return ts >= fromDate && ts <= toDate;
  });

  const dateStr = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    c.header('Content-Type', 'application/json');
    c.header('Content-Disposition', `attachment; filename="audit-${dateStr}.json"`);
    return c.json({ success: true, data: filtered, meta: { total: filtered.length, exportedAt: new Date().toISOString() } });
  }

  // CSV format
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="audit-${dateStr}.csv"`);

  const csvHeader = 'timestamp,action,actorId,targetType,targetId,details\n';
  const csvRows = filtered.map((e) => csvRow([
    e.timestamp, e.action, e.actorId, e.targetType, e.targetId,
    typeof e.details === 'object' ? JSON.stringify(e.details) : '',
  ]));

  return c.text(csvHeader + csvRows.join('\n'));
});

// ── Export command history as CSV ──
auditRouter.get('/commands/export', async (c) => {
  const db = getDb();
  const from = c.req.query('from');
  const to = c.req.query('to');
  const nodeId = c.req.query('nodeId');

  const where: Record<string, unknown> = {};
  if (nodeId) where['nodeId'] = nodeId;
  if (from || to) {
    where['createdAt'] = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }

  const commands = await db.remoteCommand.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 10000,
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="commands-${dateStr}.csv"`);

  const csvHeader = 'id,nodeId,command,status,createdAt,completedAt,createdBy\n';
  const csvRows = commands.map((cmd) => csvRow([
    cmd.id, cmd.nodeId, cmd.command, cmd.status, cmd.createdAt.toISOString(), cmd.completedAt?.toISOString(), cmd.createdBy,
  ]));

  return c.text(csvHeader + csvRows.join('\n'));
});

// ── Export logs as CSV ──
auditRouter.get('/logs/export', async (c) => {
  const db = getDb();
  const from = c.req.query('from');
  const to = c.req.query('to');
  const nodeId = c.req.query('nodeId');

  const where: Record<string, unknown> = {};
  if (nodeId) where['nodeId'] = nodeId;
  if (from || to) {
    where['timestamp'] = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }

  const logs = await db.logEntry.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: 50000,
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="logs-${dateStr}.csv"`);

  const csvHeader = 'timestamp,nodeId,source,level,message\n';
  const csvRows = logs.map((log) => csvRow([log.timestamp.toISOString(), log.nodeId, log.source, log.level, log.message]));

  return c.text(csvHeader + csvRows.join('\n'));
});

// ── Verify audit log integrity (HMAC chain) ──
auditRouter.get('/verify', async (c) => {
  const date = auditDate(c.req.query('date'));
  const result = await verifyAuditIntegrity(date);
  return c.json({ success: true, data: result });
});
