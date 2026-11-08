import type { MiddlewareHandler } from 'hono';
import { Redis } from 'ioredis';
import { incMetric } from '../routes/metrics.js';
import { heartbeatPeerAddress } from '../utils/heartbeat-peer.js';
import { oathweaveRateLimitSubject } from './oathweave.js';

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
 * Keyed by the verified subject of an Oathweave token, otherwise by client IP
 * address. Falls through (allows) if Redis is unavailable.
 *
 * @param opts.windowMs  Time window in milliseconds (default: 60_000 = 1 minute)
 * @param opts.max       Maximum requests per window (default: 100)
 * @param opts.serviceMax Maximum for a linked Oathweave service identity (default: max)
 * @param opts.keyPrefix Redis key prefix segment (default: 'rl')
 */
export function rateLimitMiddleware(
  opts: { windowMs?: number; max?: number; serviceMax?: number; keyPrefix?: string; failClosed?: boolean } = {},
): MiddlewareHandler {
  const windowMs = opts.windowMs ?? 60_000;
  const personMax = opts.max ?? 100;
  const prefix = opts.keyPrefix ?? 'rl';

  return async (c, next) => {
    // Port 4000 is directly reachable by fleet peers. A caller-controlled
    // forwarding header must not let login or mutation clients rotate their
    // rate-limit identity. The helper prefers the Node socket peer and only
    // falls back to forwarded metadata in adapter-free/test contexts.
    const authorization = c.req.header('Authorization');
    const subject = authorization?.startsWith('Bearer ')
      ? await oathweaveRateLimitSubject(authorization.slice(7))
      : undefined;
    // Behind a same-origin ingress every browser shares one peer address, so a
    // verified subject gets its own bucket. Anything else, including a token
    // that failed verification, stays on the peer bucket.
    const identity = subject ? `subject:${subject}` : heartbeatPeerAddress(c) || 'unknown-peer';
    // One linked service identity carries many people's work, so it may get a larger budget.
    const max = subject?.startsWith('service:') && opts.serviceMax !== undefined ? opts.serviceMax : personMax;

    const key = `${REDIS_PREFIX}${prefix}:${identity}`;
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
        c.header('Retry-After', String(await retryAfterSeconds(redis, key, count, max, now, windowMs)));
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

/**
 * Seconds until a client that stops now may send again. Refused requests count too, so that is when
 * every entry but the newest max - 1 has left the window: entry (count - max) in age order. Falls
 * back to the whole window when the entry cannot be read.
 */
async function retryAfterSeconds(redis: Redis, key: string, count: number, max: number, now: number, windowMs: number): Promise<number> {
  try {
    const entry = await redis.zrange(key, String(count - max), String(count - max), 'WITHSCORES');
    const score = Number(entry[1]);
    if (Number.isFinite(score)) return Math.min(Math.ceil(windowMs / 1000), Math.max(1, Math.ceil((score + windowMs - now) / 1000)));
  } catch {
    // The window is the safe answer.
  }
  return Math.ceil(windowMs / 1000);
}

/** Per-minute budgets for one subject on the Ardent bridge. */
export const ARDENT_RATE_LIMITS = {
  /**
   * GET and HEAD: profile reads, polls, task and operation streams and artifact downloads. A Studio or
   * profile page reads several resources at once and polls tasks, so reads get a wide budget.
   */
  read: { max: 600, serviceMax: 3000 },
  /** Every other method: actions, New Agent, resume and Enable HiveMem change agents and stay tight. */
  action: { max: 60, serviceMax: 1200 },
} as const;

/**
 * The Ardent bridge limiter: reads and actions have separate budgets and buckets, so reading pages
 * quickly never uses up the budget for changing an agent, and the reverse.
 */
export function ardentRateLimitMiddleware(windowMs = 60_000): MiddlewareHandler {
  const read = rateLimitMiddleware({ windowMs, ...ARDENT_RATE_LIMITS.read, keyPrefix: 'rl:ardent-read' });
  const action = rateLimitMiddleware({ windowMs, ...ARDENT_RATE_LIMITS.action, keyPrefix: 'rl:ardent' });
  return (c, next) => (c.req.method === 'GET' || c.req.method === 'HEAD' ? read : action)(c, next);
}

export function getRateLimitHealth(): { status: 'pass' | 'warn'; message: string; lastErrorAt: string | null } {
  return {
    status: lastRateLimitError ? 'warn' : 'pass',
    message: lastRateLimitError ?? 'rate limiter available or not yet exercised',
    lastErrorAt: lastRateLimitErrorAt,
  };
}
