import type { MiddlewareHandler } from 'hono';
import { nanoid } from 'nanoid';

/**
 * Correlation ID middleware — adds `x-request-id` header to every request/response.
 * If the client sends `x-request-id`, it is reused; otherwise a new one is generated.
 * The ID is stored in `c.var.requestId` for downstream use.
 */
export const correlationId: MiddlewareHandler = async (c, next) => {
  const id = c.req.header('x-request-id') ?? nanoid();
  c.set('requestId' as never, id);
  c.header('x-request-id', id);
  await next();
};
