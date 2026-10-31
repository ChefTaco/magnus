/**
 * Lightweight W3C Trace Context propagation middleware.
 *
 * Implements W3C Trace Context Level 2 (traceparent / tracestate headers)
 * for distributed tracing across Magnus services without requiring the
 * full OpenTelemetry SDK.
 *
 * Each request gets a trace span that is propagated to downstream calls.
 * When a full OTel collector is deployed, these headers are compatible.
 */

import { randomBytes } from 'node:crypto';
import type { Context, Next } from 'hono';

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sampled: boolean;
}

function exportSpan(span: Record<string, unknown>): void {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint) return;
  void fetch(endpoint.replace(/\/+$/, '') + '/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'magnus-control-api' } }] },
        scopeSpans: [{
          scope: { name: 'magnus-control-api' },
          spans: [span],
        }],
      }],
    }),
  }).catch(() => {});
}

/** Parse a W3C traceparent header, or generate a new trace context. */
function parseOrCreateTrace(traceparent: string | undefined): TraceContext {
  const spanId = randomBytes(8).toString('hex');

  if (traceparent) {
    const match = TRACEPARENT_REGEX.exec(traceparent);
    if (match) {
      return {
        traceId: match[1]!,
        spanId,
        parentSpanId: match[2]!,
        sampled: (parseInt(match[3]!, 16) & 0x01) === 1,
      };
    }
  }

  return {
    traceId: randomBytes(16).toString('hex'),
    spanId,
    parentSpanId: null,
    sampled: true,
  };
}

/** Format a trace context as a W3C traceparent header. */
function formatTraceparent(ctx: TraceContext): string {
  const flags = ctx.sampled ? '01' : '00';
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Hono middleware: extracts or creates W3C trace context,
 * adds it to the response headers, and stores it on the context.
 */
export async function tracing(c: Context, next: Next): Promise<void> {
  const incoming = c.req.header('traceparent');
  const trace = parseOrCreateTrace(incoming);

  // Store on Hono context for use in downstream calls
  c.set('traceId', trace.traceId);
  c.set('spanId', trace.spanId);

  // Propagate trace to response
  c.header('traceparent', formatTraceparent(trace));
  const tracestate = c.req.header('tracestate');
  if (tracestate) {
    c.header('tracestate', tracestate);
  }

  const startTime = performance.now();
  await next();
  const durationMs = performance.now() - startTime;

  // Log span (structured, OTel-compatible field names)
  if (trace.sampled && durationMs > 100) {
    const spanLog = {
      severity: 'TRACE',
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Math.round(durationMs * 100) / 100,
    };
    console.log(JSON.stringify(spanLog));
    exportSpan({
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId ?? undefined,
      name: `${c.req.method} ${new URL(c.req.url).pathname}`,
      kind: 2,
      startTimeUnixNano: String(Math.floor((Date.now() - durationMs) * 1_000_000)),
      endTimeUnixNano: String(Date.now() * 1_000_000),
      attributes: [
        { key: 'http.request.method', value: { stringValue: c.req.method } },
        { key: 'url.path', value: { stringValue: new URL(c.req.url).pathname } },
        { key: 'http.response.status_code', value: { intValue: String(c.res.status) } },
      ],
      status: { code: c.res.status >= 500 ? 2 : 1 },
    });
  }
}

/**
 * Helper to propagate trace headers to outgoing fetch calls.
 * Use in services that call other Magnus APIs.
 */
export function traceHeaders(c: Context): Record<string, string> {
  const traceId = c.get('traceId') as string | undefined;
  const spanId = c.get('spanId') as string | undefined;
  if (!traceId || !spanId) return {};

  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    ...(c.req.header('tracestate') ? { tracestate: c.req.header('tracestate')! } : {}),
  };
}
