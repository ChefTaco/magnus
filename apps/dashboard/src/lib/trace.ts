/**
 * Distributed trace helpers.
 *
 * Generates a compact trace id, persists it per "session" in memory so that
 * rapid-fire requests in the same user interaction share a trace, and exposes
 * utilities to tag outgoing requests and inspect the current trace.
 */

const TRACE_ID_KEY = '__magnus_trace_id__';
const TRACE_TTL_MS = 10_000; // trace id persists for 10s of quiescence

interface TraceCtx {
  id: string;
  lastUsedAt: number;
}

type TraceGlobal = typeof globalThis & { [TRACE_ID_KEY]?: TraceCtx };

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

/** Get the current trace id, rotating if it has gone stale. */
export function currentTraceId(): string {
  const g = globalThis as TraceGlobal;
  const now = Date.now();
  const ctx = g[TRACE_ID_KEY];
  if (ctx && now - ctx.lastUsedAt < TRACE_TTL_MS) {
    ctx.lastUsedAt = now;
    return ctx.id;
  }
  const id = randomId();
  g[TRACE_ID_KEY] = { id, lastUsedAt: now };
  return id;
}

/** Force a new trace id on the next call. */
export function resetTrace(): void {
  const g = globalThis as TraceGlobal;
  delete g[TRACE_ID_KEY];
}

/** Set an explicit trace id (for continuing a backend-initiated trace). */
export function setTraceId(id: string): void {
  const g = globalThis as TraceGlobal;
  g[TRACE_ID_KEY] = { id, lastUsedAt: Date.now() };
}
