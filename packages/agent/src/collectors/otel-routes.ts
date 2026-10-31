/**
 * otel-routes.ts — Routes for accessing agent-generated traces.
 *
 * GET /traces           — Recent spans
 * GET /traces/stats     — Trace statistics
 * GET /traces/:traceId  — All spans for a specific trace
 */

import { Hono } from 'hono';
import { getRecentSpans, getTraceSpans, getTraceStats } from './otel-collector.js';

export const otelRoutes = new Hono();

// ── Recent spans ──
otelRoutes.get('/', (c) => {
  const limit = parseInt(c.req.query('limit') ?? '100', 10);
  const spans = getRecentSpans(Math.min(limit, 500));
  return c.json({ success: true, data: { spans, count: spans.length } });
});

// ── Trace statistics ──
otelRoutes.get('/stats', (c) => {
  const stats = getTraceStats();
  return c.json({ success: true, data: stats });
});

// ── Spans for a specific trace ──
otelRoutes.get('/:traceId', (c) => {
  const traceId = c.req.param('traceId')!;
  const spans = getTraceSpans(traceId);
  return c.json({ success: true, data: { traceId, spans, count: spans.length } });
});
