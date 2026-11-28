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

import type { Context, Next } from 'hono';
import { createRequestContext, formatTraceparent } from '@hivemagnus/hive-common/context';
import { getHiveContext } from '@hivemagnus/hive-common/hono';

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

/**
 * This request's span. The request context (`middleware/correlation-id.ts`, HiveCommon
 * `requestContext()`) already parsed the inbound `traceparent` and opened a child span; without
 * it (a router mounted on its own), the same rules apply here.
 */
function traceFor(c: Context): { trace: TraceContext; tracestate: string | undefined } {
  const context = getHiveContext(c) ?? createRequestContext(name => c.req.header(name));
  return {
    trace: {
      traceId: context.trace.traceId,
      spanId: context.trace.spanId,
      parentSpanId: context.parentTrace?.spanId ?? null,
      sampled: context.trace.sampled,
    },
    tracestate: context.tracestate,
  };
}

/** Format a trace context as a W3C traceparent header. */
function formatTrace(ctx: TraceContext): string {
  return formatTraceparent({ traceId: ctx.traceId, spanId: ctx.spanId, sampled: ctx.sampled });
}

/**
 * Hono middleware: extracts or creates W3C trace context,
 * adds it to the response headers, and stores it on the context.
 */
export async function tracing(c: Context, next: Next): Promise<void> {
  const { trace, tracestate } = traceFor(c);

  // Store on Hono context for use in downstream calls
  c.set('traceId', trace.traceId);
  c.set('spanId', trace.spanId);

  // Propagate trace to response
  c.header('traceparent', formatTrace(trace));
  // Only a valid inbound tracestate (with a valid traceparent) is propagated.
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

  const tracestate = getHiveContext(c)?.tracestate;
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    ...(tracestate ? { tracestate } : {}),
  };
}
