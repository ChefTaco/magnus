import { optional } from '../utils/optional.js';
import { intQuery, pagination } from '../utils/query.js';
/**
 * anomalies.ts — Routes for anomaly detection events.
 *
 * GET  /anomalies              — Fleet-wide anomaly feed
 * GET  /anomalies/:nodeId      — Anomalies for a specific node
 * GET  /anomalies/:nodeId/summary — Anomaly summary for a node
 * POST /anomalies/:id/resolve  — Mark an anomaly as resolved
 * POST /anomalies/resolve-node — Bulk-resolve anomalies for a node
 */

import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import {
  listAnomalyEvents,
  getNodeAnomalySummary,
  resolveAnomaly,
  resolveNodeAnomalies,
  getFleetAnomalySummary,
  purgeResolvedAnomalies,
} from '../services/anomaly-detector.js';
import {
  correlateAnomalies,
  getAnomalyCorrelationDetails,
  getAnomalyTimeline,
} from '../services/ai-correlation-service.js';

export const anomaliesRouter = new Hono<AppVariables>();

anomaliesRouter.use('*', authMiddleware);

// ── Fleet-wide anomaly feed ──
anomaliesRouter.get('/', async (c) => {
  const result = await listAnomalyEvents({ ...optional("nodeId", c.req.query('nodeId')), ...optional("metric", c.req.query('metric')), ...optional("severity", c.req.query('severity')), ...optional("resolved", c.req.query('resolved') === 'true' ? true : c.req.query('resolved') === 'false' ? false : undefined), ...pagination(c, { pageSize: 50, maxPageSize: 100 }) });
  return c.json({ success: true, data: result });
});

// ── Fleet-wide anomaly summary (for AI / dashboard overview) ──
anomaliesRouter.get('/summary', async (c) => {
  const summary = await getFleetAnomalySummary();
  return c.json({ success: true, data: summary });
});

// ── Cross-fleet anomaly groups ──
anomaliesRouter.get('/correlations', async (c) => {
  const windowMinutes = intQuery(c, 'windowMinutes', { fallback: 5, min: 1, max: 120 });
  const includeResolved = c.req.query('includeResolved') === 'true';
  const groups = await correlateAnomalies({ windowMinutes, includeResolved });
  return c.json({ success: true, data: groups });
});

// ── Time-ordered anomaly and health context ──
anomaliesRouter.get('/timeline', async (c) => {
  const hours = intQuery(c, 'hours', { fallback: 24, min: 1, max: 24 * 30 });
  const nodeId = c.req.query('nodeId') ?? undefined;
  return c.json({ success: true, data: await getAnomalyTimeline({ hours, ...optional("nodeId", nodeId) }) });
});

// ── Per-anomaly AI correlation details ──
anomaliesRouter.get('/event/:id/correlation', async (c) => {
  const details = await getAnomalyCorrelationDetails(c.req.param('id')!);
  if (!details) {
    throw new HttpError(404, 'NOT_FOUND', 'Anomaly event not found');
  }
  return c.json({ success: true, data: details });
});

// ── Node-specific anomaly summary ──
anomaliesRouter.get('/:nodeId/summary', async (c) => {
  const nodeId = c.req.param('nodeId')!;
  const summary = await getNodeAnomalySummary(nodeId);
  return c.json({ success: true, data: summary });
});

// ── Node anomaly list ──
anomaliesRouter.get('/:nodeId', async (c) => {
  const nodeId = c.req.param('nodeId')!;
  const result = await listAnomalyEvents({ nodeId, ...optional("metric", c.req.query('metric')), ...optional("severity", c.req.query('severity')), ...optional("resolved", c.req.query('resolved') === 'true' ? true : c.req.query('resolved') === 'false' ? false : undefined), ...pagination(c, { pageSize: 50, maxPageSize: 100 }) });
  return c.json({ success: true, data: result });
});

// ── Resolve a single anomaly ──
anomaliesRouter.post('/:id/resolve', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  try {
    await resolveAnomaly(id);
    return c.json({ success: true });
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'Anomaly event not found');
  }
});

// ── Bulk-resolve anomalies for a node ──
anomaliesRouter.post('/resolve-node', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await c.req.json<{ nodeId: string; metric?: string }>();
  if (!body.nodeId) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'nodeId is required');
  }
  const count = await resolveNodeAnomalies(body.nodeId, body.metric);
  return c.json({ success: true, data: { resolved: count } });
});

// ── Purge old resolved anomalies ──
anomaliesRouter.post('/purge', requireRole('ADMIN'), async (c) => {
  const body = await c.req.json().catch(() => ({})) as { retentionDays?: number };
  const retentionDays = body.retentionDays ?? 30;
  const count = await purgeResolvedAnomalies(retentionDays);
  return c.json({ success: true, data: { deleted: count, retentionDays } });
});
