/**
 * otel-middleware.ts — Hono middleware that auto-traces every HTTP request.
 *
 * Reads incoming `traceparent` header for context propagation,
 * creates a span per request, and attaches trace context to the response.
 */

import type { Context, Next } from 'hono';
import { startSpan, parseTraceparent, formatTraceparent } from './otel-collector.js';

export async function tracingMiddleware(c: Context, next: Next): Promise<void | Response> {
  const incoming = parseTraceparent(c.req.header('traceparent'));

  const span = startSpan(`${c.req.method} ${c.req.path}`, {
    kind: 'server',
    parentTraceId: incoming?.traceId,
    parentSpanId: incoming?.spanId,
    attributes: {
      'http.method': c.req.method,
      'http.url': c.req.path,
      'http.user_agent': c.req.header('user-agent') ?? '',
    },
  });

  try {
    await next();

    span.setAttribute('http.status_code', c.res.status);
    span.end(c.res.status >= 400 ? 'error' : 'ok');

    // Attach trace context to response for downstream correlation
    c.res.headers.set('x-trace-id', span.traceId);
    c.res.headers.set('traceparent', formatTraceparent(span.traceId, span.spanId));
  } catch (err) {
    span.setAttribute('error.message', err instanceof Error ? err.message : String(err));
    span.end('error');
    throw err;
  }
}
