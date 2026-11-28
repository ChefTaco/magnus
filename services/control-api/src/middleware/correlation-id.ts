import type { MiddlewareHandler } from 'hono';
import { getHiveContext, requestContext } from '@hivemagnus/hive-common/hono';

const hiveRequestContext = requestContext();

/**
 * Request context middleware (HiveCommon `requestContext()`): every request gets a request ID
 * and a W3C trace context, kept in AsyncLocalStorage for loggers and outbound clients.
 *
 * - An inbound `x-request-id` (or `x-hive-request-id`, `x-correlation-id`) is reused only when it is
 *   1-128 characters of `[A-Za-z0-9._:@/+=-]`; anything else gets a generated ID, so a caller can
 *   no longer put arbitrary text into logs and response headers.
 * - A valid inbound `traceparent` is continued with a new span for this server; otherwise a new
 *   trace starts. `middleware/tracing.ts` reads that span.
 * - The ID is echoed as `x-request-id` on the response and stored in `c.var.requestId`.
 */
export const correlationId: MiddlewareHandler = (c, next) => hiveRequestContext(c, async () => {
  const context = getHiveContext(c);
  if (context) c.set('requestId' as never, context.requestId as never);
  await next();
});
