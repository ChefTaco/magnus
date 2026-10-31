/**
 * otel-collector.ts — Lightweight OpenTelemetry-compatible tracing for the agent.
 *
 * Generates W3C Trace Context compatible spans for agent operations:
 * - Command execution (shell, cron, file sync)
 * - Heartbeat reporting
 * - Collector operations (health, drift, profiling)
 * - Route handler requests
 *
 * Spans are stored in a ring buffer and optionally exported to an OTLP
 * endpoint (Jaeger/Tempo) when OTEL_EXPORTER_OTLP_ENDPOINT is configured.
 *
 * Zero external dependencies — uses only Node.js crypto for trace/span IDs.
 */

import { randomBytes } from 'node:crypto';

// ── Configuration ──

const SERVICE_NAME = process.env['OTEL_SERVICE_NAME'] ?? 'magnus-agent';
const OTLP_ENDPOINT = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '';
const OTLP_HEADERS = parseOtlpHeaders(process.env['OTEL_EXPORTER_OTLP_HEADERS'] ?? '');
const MAX_SPANS = Math.max(1, Math.floor(Number(process.env['OTEL_MAX_BUFFER_SPANS'] ?? '1000')) || 1000);
const FLUSH_INTERVAL_MS = Number(process.env['OTEL_FLUSH_INTERVAL_MS'] ?? '30000');
const ENABLED = process.env['OTEL_ENABLED'] !== 'false';

function parseOtlpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const pair of raw.split(',')) {
    const [key, ...vals] = pair.split('=');
    if (key && vals.length > 0) {
      headers[key.trim()] = vals.join('=').trim();
    }
  }
  return headers;
}

// ── Types ──

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  serviceName: string;
  kind: 'internal' | 'server' | 'client';
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

interface SpanEvent {
  name: string;
  timestampMs: number;
  attributes?: Record<string, string | number | boolean>;
}

interface ActiveSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  kind: 'internal' | 'server' | 'client';
  startTimeMs: number;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

// ── Trace ID / Span ID Generation (W3C compatible) ──

function generateTraceId(): string {
  return randomBytes(16).toString('hex'); // 32 hex chars
}

function generateSpanId(): string {
  return randomBytes(8).toString('hex'); // 16 hex chars
}

// ── Ring Buffer ──

const spanBuffer: Span[] = [];
let bufferIndex = 0;

function addSpan(span: Span): void {
  if (spanBuffer.length < MAX_SPANS) {
    spanBuffer.push(span);
  } else {
    spanBuffer[bufferIndex % MAX_SPANS] = span;
  }
  bufferIndex++;
}

// ── Public API ──

/**
 * Start a new span. Returns a handle to end the span later.
 */
export function startSpan(
  operationName: string,
  options?: {
    kind?: 'internal' | 'server' | 'client';
    parentTraceId?: string;
    parentSpanId?: string;
    attributes?: Record<string, string | number | boolean>;
  },
): SpanHandle {
  if (!ENABLED) return noopHandle;

  const traceId = options?.parentTraceId ?? generateTraceId();
  const spanId = generateSpanId();

  const active: ActiveSpan = {
    traceId,
    spanId,
    parentSpanId: options?.parentSpanId,
    operationName,
    kind: options?.kind ?? 'internal',
    startTimeMs: Date.now(),
    attributes: { 'service.name': SERVICE_NAME, ...options?.attributes },
    events: [],
  };

  return {
    traceId,
    spanId,
    addEvent(name: string, attrs?: Record<string, string | number | boolean>) {
      active.events.push({ name, timestampMs: Date.now(), attributes: attrs });
    },
    setAttribute(key: string, value: string | number | boolean) {
      active.attributes[key] = value;
    },
    end(status?: 'ok' | 'error') {
      const endTimeMs = Date.now();
      const span: Span = {
        traceId: active.traceId,
        spanId: active.spanId,
        parentSpanId: active.parentSpanId,
        operationName: active.operationName,
        serviceName: SERVICE_NAME,
        kind: active.kind,
        startTimeMs: active.startTimeMs,
        endTimeMs,
        durationMs: endTimeMs - active.startTimeMs,
        status: status ?? 'ok',
        attributes: active.attributes,
        events: active.events,
      };
      addSpan(span);
    },
  };
}

export interface SpanHandle {
  traceId: string;
  spanId: string;
  addEvent(name: string, attrs?: Record<string, string | number | boolean>): void;
  setAttribute(key: string, value: string | number | boolean): void;
  end(status?: 'ok' | 'error'): void;
}

const noopHandle: SpanHandle = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  addEvent() {},
  setAttribute() {},
  end() {},
};

/**
 * Parse a W3C traceparent header: `00-<traceId>-<spanId>-<flags>`
 */
export function parseTraceparent(header: string | undefined): { traceId: string; spanId: string } | null {
  if (!header) return null;
  const parts = header.split('-');
  if (parts.length < 4 || parts[0] !== '00') return null;
  const traceId = parts[1]!;
  const spanId = parts[2]!;
  if (traceId.length !== 32 || spanId.length !== 16) return null;
  return { traceId, spanId };
}

/**
 * Generate a traceparent header for outgoing requests.
 */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Get recent spans from the buffer (newest first).
 */
export function getRecentSpans(limit: number = 100): Span[] {
  const sorted = [...spanBuffer].sort((a, b) => b.startTimeMs - a.startTimeMs);
  return sorted.slice(0, limit);
}

/**
 * Get spans for a specific trace.
 */
export function getTraceSpans(traceId: string): Span[] {
  return spanBuffer
    .filter((s) => s.traceId === traceId)
    .sort((a, b) => a.startTimeMs - b.startTimeMs);
}

/**
 * Get trace statistics.
 */
export function getTraceStats(): {
  totalSpans: number;
  bufferCapacity: number;
  serviceName: string;
  otlpEnabled: boolean;
  spansByOperation: Record<string, number>;
  avgDurationByOperation: Record<string, number>;
  errorRate: number;
} {
  const byOp: Record<string, number> = {};
  const durByOp: Record<string, number[]> = {};
  let errorCount = 0;

  for (const s of spanBuffer) {
    byOp[s.operationName] = (byOp[s.operationName] ?? 0) + 1;
    (durByOp[s.operationName] ??= []).push(s.durationMs);
    if (s.status === 'error') errorCount++;
  }

  const avgDurationByOperation: Record<string, number> = {};
  for (const [op, durs] of Object.entries(durByOp)) {
    avgDurationByOperation[op] = Math.round(durs.reduce((a, b) => a + b, 0) / durs.length);
  }

  return {
    totalSpans: spanBuffer.length,
    bufferCapacity: MAX_SPANS,
    serviceName: SERVICE_NAME,
    otlpEnabled: !!OTLP_ENDPOINT,
    spansByOperation: byOp,
    avgDurationByOperation,
    errorRate: spanBuffer.length > 0 ? Math.round((errorCount / spanBuffer.length) * 10000) / 10000 : 0,
  };
}

// ── OTLP Export (optional) ──

let flushTimer: ReturnType<typeof setInterval> | null = null;
/** Sequence number (bufferIndex) of the next span not yet exported. */
let lastFlushedIndex = 0;

function toOtlpSpan(span: Span): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? '',
    name: span.operationName,
    kind: span.kind === 'server' ? 2 : span.kind === 'client' ? 3 : 1,
    startTimeUnixNano: String(BigInt(span.startTimeMs) * 1_000_000n),
    endTimeUnixNano: String(BigInt(span.endTimeMs) * 1_000_000n),
    status: { code: span.status === 'error' ? 2 : span.status === 'ok' ? 1 : 0 },
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: typeof value === 'string'
        ? { stringValue: value }
        : typeof value === 'number'
          ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value })
          : { boolValue: value },
    })),
    events: span.events.map((e) => ({
      name: e.name,
      timeUnixNano: String(BigInt(e.timestampMs) * 1_000_000n),
      attributes: e.attributes
        ? Object.entries(e.attributes).map(([key, value]) => ({
            key,
            value: typeof value === 'string' ? { stringValue: value } : { intValue: String(value) },
          }))
        : [],
    })),
  };
}

async function flushToOtlp(): Promise<void> {
  if (!OTLP_ENDPOINT || spanBuffer.length === 0) return;

  // Spans are numbered by bufferIndex and stored at index % MAX_SPANS, so the
  // retained unexported range survives ring-buffer wraparound.
  const oldestRetained = bufferIndex - spanBuffer.length;
  const unflushed: Span[] = [];
  for (let sequence = Math.max(lastFlushedIndex, oldestRetained); sequence < bufferIndex; sequence++) {
    unflushed.push(spanBuffer[sequence % MAX_SPANS]!);
  }
  lastFlushedIndex = bufferIndex;
  if (unflushed.length === 0) return;

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: SERVICE_NAME } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'magnus-agent-tracer', version: '1.0.0' },
            spans: unflushed.map(toOtlpSpan),
          },
        ],
      },
    ],
  };

  try {
    const url = `${OTLP_ENDPOINT.replace(/\/+$/, '')}/v1/traces`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...OTLP_HEADERS,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('[otel] Failed to export spans:', err instanceof Error ? err.message : err);
  }
}

/**
 * Start the OTLP exporter flush loop.
 */
export function startOtlpExporter(): void {
  if (!OTLP_ENDPOINT || !ENABLED) return;
  console.log(`[otel] OTLP exporter enabled → ${OTLP_ENDPOINT}`);
  flushTimer = setInterval(() => {
    flushToOtlp().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

/**
 * Stop the OTLP exporter and flush remaining spans.
 */
export async function stopOtlpExporter(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushToOtlp();
}
