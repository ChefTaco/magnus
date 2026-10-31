import { api } from './api-client';

// ─── Dashboard Error Reporter — ships client-side errors to log pipeline ───

/** Well-known sentinel node ID for Dashboard logs. */
const DASHBOARD_NODE_ID = '__dashboard__';

/** Max errors to ship per minute (prevent flood loops). */
const MAX_ERRORS_PER_MINUTE = 20;

/** Batch interval — flush queued errors every 10 seconds. */
const FLUSH_INTERVAL_MS = 10_000;

let errorCount = 0;
let lastResetTime = Date.now();
const errorQueue: Array<{
  nodeId: string;
  source: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}> = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

function resetRateLimit(): void {
  const now = Date.now();
  if (now - lastResetTime >= 60_000) {
    errorCount = 0;
    lastResetTime = now;
  }
}

function queueError(message: string, metadata: Record<string, unknown>): void {
  resetRateLimit();
  if (errorCount >= MAX_ERRORS_PER_MINUTE) return; // rate-limited
  errorCount++;

  errorQueue.push({
    nodeId: DASHBOARD_NODE_ID,
    source: 'dashboard',
    level: 'error',
    message,
    metadata,
    timestamp: new Date().toISOString(),
  });
}

async function flushErrors(): Promise<void> {
  if (errorQueue.length === 0) return;

  const batch = errorQueue.splice(0, errorQueue.length);
  try {
    await api.logs.ingest(batch);
  } catch {
    // If ingest fails, don't re-queue — avoids infinite loop if the API is down
  }
}

/**
 * Initialize the error reporter. Call once from a client-side useEffect.
 * Attaches global error handlers and starts the flush timer.
 */
export function initErrorReporter(): () => void {
  if (initialized || typeof window === 'undefined') return () => {};
  initialized = true;

  const handleError = (event: ErrorEvent): void => {
    queueError(`Uncaught error: ${event.message}`, {
      url: window.location.pathname,
      filename: event.filename ?? 'unknown',
      lineno: event.lineno ?? 0,
      colno: event.colno ?? 0,
    });
  };

  const handleRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    queueError(`Unhandled rejection: ${message}`, {
      url: window.location.pathname,
    });
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);

  flushTimer = setInterval(() => void flushErrors(), FLUSH_INTERVAL_MS);

  // Cleanup function
  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    // Flush remaining on teardown
    void flushErrors();
    initialized = false;
  };
}
