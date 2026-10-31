import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { NODE_MANAGER_SECRET as NODE_SECRET, NODE_MANAGER_SECRET_PREVIOUS as NODE_SECRET_PREVIOUS } from './env.js';

/** Constant-time string comparison to prevent timing attacks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to avoid leaking length information via timing
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Auth middleware for control-api → node-manager calls.
 *
 * Accepts the active `NODE_MANAGER_SECRET` and, during a rotation, the bounded
 * `NODE_MANAGER_SECRET_PREVIOUS` grace credential so the control-api and agents
 * can be rolled in any order without a flag-day. The same active secret is used
 * by the agent when sending heartbeats back.
 */
export async function nodeAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const token = c.req.header('x-node-token');
  if (!token) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing x-node-token header' } }, 401);
  }

  if (!NODE_SECRET) {
    return c.json({ success: false, error: { code: 'CONFIG_ERROR', message: 'NODE_MANAGER_SECRET not configured' } }, 500);
  }

  // Evaluate both candidates unconditionally to avoid leaking which matched.
  const matchesActive = constantTimeEqual(token, NODE_SECRET);
  const matchesPrevious = NODE_SECRET_PREVIOUS.length > 0 && constantTimeEqual(token, NODE_SECRET_PREVIOUS);
  if (!matchesActive && !matchesPrevious) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid node token' } }, 401);
  }

  await next();
}
