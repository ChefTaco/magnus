import type { MiddlewareHandler } from 'hono';
import { Redis } from 'ioredis';
import { incMetric } from '../routes/metrics.js';
import { heartbeatPeerAddress } from '../utils/heartbeat-peer.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const REDIS_PREFIX = process.env['REDIS_PREFIX'] ?? 'magnus-';

let _redis: Redis | null = null;
let lastRateLimitError: string | null = null;
let lastRateLimitErrorAt: string | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    _redis.connect().catch(() => {
      // silently fail — rate limiter becomes permissive when Redis is unavailable
    });
  }
  return _redis;
}

/**
 * Sliding-window rate limiter backed by Redis.
 * Keyed by client IP address. Falls through (allows) if Redis is unavailable.
 *
 * @param opts.windowMs  Time window in milliseconds (default: 60_000 = 1 minute)
 * @param opts.max       Maximum requests per window (default: 100)
 * @param opts.keyPrefix Redis key prefix segment (default: 'rl')
 */
export function rateLimitMiddleware(
  opts: { windowMs?: number; max?: number; keyPrefix?: string; failClosed?: boolean } = {},
): MiddlewareHandler {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 100;
  const prefix = opts.keyPrefix ?? 'rl';

  return async (c, next) => {
    // Port 4000 is directly reachable by fleet peers. A caller-controlled
    // forwarding header must not let login or mutation clients rotate their
    // rate-limit identity. The helper prefers the Node socket peer and only
    // falls back to forwarded metadata in adapter-free/test contexts.
    const ip = heartbeatPeerAddress(c) || 'unknown-peer';

    const key = `${REDIS_PREFIX}${prefix}:${ip}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
      const redis = getRedis();
      const pipe = redis.pipeline();
      pipe.zremrangebyscore(key, '-inf', windowStart);
      pipe.zadd(key, now, `${now}-${Math.random()}`);
      pipe.zcard(key);
      pipe.pexpire(key, windowMs);
      const results = await pipe.exec();
      // Recovery clears the health warning; lastErrorAt keeps the history.
      lastRateLimitError = null;

      const count = (results?.[2]?.[1] as number) ?? 0;

      if (count > max) {
        const retryAfter = Math.ceil(windowMs / 1000);
        c.header('Retry-After', String(retryAfter));
        return c.json(
          { error: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
          429,
        );
      }
    } catch {
      lastRateLimitError = 'Redis unavailable for rate limiting';
      lastRateLimitErrorAt = new Date().toISOString();
      incMetric('rateLimiterFailures');
      if (opts.failClosed && process.env['NODE_ENV'] !== 'test') {
        return c.json(
          {
            error: 'RATE_LIMIT_UNAVAILABLE',
            message: 'Rate limiter is unavailable for this sensitive endpoint.',
          },
          503,
        );
      }
      // Redis unavailable — fail open only for non-critical routes and tests.
    }

    return next();
  };
}

export function getRateLimitHealth(): { status: 'pass' | 'warn'; message: string; lastErrorAt: string | null } {
  return {
    status: lastRateLimitError ? 'warn' : 'pass',
    message: lastRateLimitError ?? 'rate limiter available or not yet exercised',
    lastErrorAt: lastRateLimitErrorAt,
  };
}
