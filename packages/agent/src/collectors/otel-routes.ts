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
  const requested = Number.parseInt(c.req.query('limit') ?? '100', 10);
  // A missing, non-numeric or negative limit must not turn into `slice(0, NaN)` or a negative end index.
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 500) : 100;
  const spans = getRecentSpans(limit);
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
