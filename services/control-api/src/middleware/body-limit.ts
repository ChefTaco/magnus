import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

export function bodyLimitMiddleware(limitBytes: number): MiddlewareHandler {
  return bodyLimit({
    maxSize: limitBytes,
    onError: (c) => c.json({
        success: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Request body exceeds ${limitBytes} bytes`,
        },
      }, 413),
  });
}
