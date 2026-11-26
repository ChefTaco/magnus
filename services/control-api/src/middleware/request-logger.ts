import type { Context, Next } from 'hono';
import { routePath } from 'hono/route';
import { getDb } from '../db/index.js';
import type { AppVariables, LogLevel } from '../types/index.js';
import { emitLog } from '../services/log-emitter.js';
import { incMetric, observeLatency } from '../routes/metrics.js';
import { redactUnknown } from '../utils/redact.js';
import { isNodeAuthenticated } from './node-auth.js';

// ─── Request Logger — logs Control API HTTP requests to logEntry table ───

import { CONTROL_API_NODE_ID } from '../utils/sentinel-nodes.js';
export { CONTROL_API_NODE_ID };

/** Paths to skip logging (noisy or recursive endpoints). */
const SKIP_PATHS = new Set([
  '/api/v1/health',
  '/api/v1/heartbeat',
  '/api/v1/logs/stream',
]);

/** Map HTTP status code ranges to log levels. */
function statusToLevel(status: number): LogLevel {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/**
 * Hono middleware that logs each HTTP request to the logEntry table
 * after the response is sent. Also emits to the SSE log bus.
 *
 * Security: Only logs method, path, status, duration, and user email.
 * Never logs request or response bodies.
 */
export async function requestLogger(c: Context<AppVariables>, next: Next): Promise<void> {
  const path = new URL(c.req.url).pathname;

  // Skip noisy endpoints
  if (SKIP_PATHS.has(path)) {
    await next();
    return;
  }

  const start = Date.now();
  await next();
  const durationMs = Date.now() - start;

  const method = c.req.method;
  const status = c.res.status;
  const level = statusToLevel(status);

  // ── Prometheus counters ──
  incMetric('httpRequestsTotal');
  if (status >= 400) incMetric('httpErrorsTotal');
  // Key latency by the matched route pattern, never the raw path, so random
  // (including unauthenticated 404) paths cannot grow the metric cardinality.
  observeLatency(durationMs, routePath(c) || 'unmatched', status);

  // Extract user email from auth context (set by authMiddleware)
  let userEmail = 'anonymous';
  const user = c.var.user;
  if (user?.email) userEmail = user.email;

  const now = new Date();
  // A refused request from nobody in particular (no user, no node) is counted, not stored one row
  // each: anyone who can reach the listener could otherwise flood the table and the live log.
  // One summary row per minute says how many there were.
  if (status >= 400 && status < 500 && !user && !isNodeAuthenticated(c)) {
    incMetric('httpUnauthenticatedRejectionsTotal');
    const summary = noteUnauthenticatedRejection(now.getTime());
    if (summary) writeEntry('info', summary.message, summary.metadata, now);
    return;
  }

  const message = `${method} ${path} ${status} ${durationMs}ms`;
  const traceId = c.get('traceId') as string | undefined;
  const metadata = redactUnknown({ method, path, status, durationMs, userEmail, traceId }) as Record<string, unknown>;
  writeEntry(level, message, metadata, now);
}

const SUMMARY_WINDOW_MS = 60_000;
let rejectedInWindow = 0;
let windowStartedAt = 0;

/**
 * Count one unauthenticated rejection. Returns the summary to write when a window closes: the
 * first rejection after a quiet period opens a window, and the first one after it ends reports it.
 */
export function noteUnauthenticatedRejection(now: number): { message: string; metadata: Record<string, unknown> } | null {
  if (windowStartedAt === 0) windowStartedAt = now;
  rejectedInWindow += 1;
  if (now - windowStartedAt < SUMMARY_WINDOW_MS) return null;
  const count = rejectedInWindow;
  const since = new Date(windowStartedAt).toISOString();
  rejectedInWindow = 0;
  windowStartedAt = now;
  return {
    message: `${count} unauthenticated request(s) refused with 4xx since ${since}`,
    metadata: { unauthenticatedRejections: count, since },
  };
}

/** For tests. */
export function resetRequestLoggerState(): void {
  rejectedInWindow = 0;
  windowStartedAt = 0;
}

function writeEntry(level: LogLevel, message: string, metadata: Record<string, unknown>, now: Date): void {
  // Write to DB (fire-and-forget — don't block the response)
  const db = getDb();
  void db.logEntry.create({
    data: {
      nodeId: CONTROL_API_NODE_ID,
      source: 'control-api',
      level,
      message,
      metadata: JSON.stringify(metadata),
      timestamp: now,
    },
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Request logger write error: ${msg}`);
  });

  // Emit to SSE subscribers
  emitLog({
    id: '',
    nodeId: CONTROL_API_NODE_ID,
    source: 'control-api',
    level,
    message,
    metadata,
    timestamp: now,
  });
}
