import type { Context, MiddlewareHandler } from 'hono';
import { Redis } from 'ioredis';
import { HiveError } from '@hivemagnus/hive-common/errors';
import {
  addressKey, createRateLimiter, enforceRateLimit, resolveClientAddress, trustedProxies,
  type RateLimiter, type RateLimitResult, type RateLimitStore, type TrustedProxies,
} from '@hivemagnus/hive-common/rate-limit';
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
      // Reported through getRateLimitHealth() when a request finds Redis unavailable.
    });
  }
  return _redis;
}

/**
 * A HiveCommon `RateLimitStore` on a Redis sorted set: a sliding window of `max` requests per
 * `windowMs`, shared by every server process and kept across restarts. Refused requests count too,
 * so a client that keeps retrying stays refused. Throws when Redis is unavailable.
 */
function redisWindowStore(max: number, windowMs: number): RateLimitStore {
  return {
    async consume(key) {
      const now = Date.now();
      const redis = getRedis();
      const pipe = redis.pipeline();
      pipe.zremrangebyscore(key, '-inf', now - windowMs);
      pipe.zadd(key, now, `${now}-${Math.random()}`);
      pipe.zcard(key);
      pipe.pexpire(key, windowMs);
      const results = await pipe.exec();
      const count = (results?.[2]?.[1] as number) ?? 0;
      const allowed = count <= max;
      return {
        allowed,
        limit: max,
        remaining: Math.max(0, max - count),
        retryAfterMs: allowed ? 0 : await retryAfterMs(redis, key, count, max, now, windowMs),
        resetMs: windowMs,
      } satisfies RateLimitResult;
    },
  };
}

/**
 * Milliseconds until a client that stops now may send again. Refused requests count too, so that is
 * when every entry but the newest max - 1 has left the window: entry (count - max) in age order.
 * Falls back to the whole window when the entry cannot be read.
 */
async function retryAfterMs(redis: Redis, key: string, count: number, max: number, now: number, windowMs: number): Promise<number> {
  try {
    const entry = await redis.zrange(key, String(count - max), String(count - max), 'WITHSCORES');
    const score = Number(entry[1]);
    if (Number.isFinite(score)) return Math.min(windowMs, Math.max(1, score + windowMs - now));
  } catch {
    // The window is the safe answer.
  }
  return windowMs;
}

let proxies: { raw: string; trusted: TrustedProxies } | undefined;

/**
 * Proxies whose `X-Forwarded-For` the rate limiter believes (`MAGNUS_TRUSTED_PROXIES`: addresses,
 * CIDR ranges and the presets `loopback`, `private`, `linklocal`). Unset trusts none, so the socket
 * peer is the client, as before: port 4000 is directly reachable by fleet peers, and a
 * caller-controlled forwarding header must never rotate a rate-limit identity. The env schema
 * refuses an invalid list at startup.
 */
export function rateLimitTrustedProxies(): TrustedProxies {
  const raw = process.env['MAGNUS_TRUSTED_PROXIES'] ?? '';
  if (proxies?.raw !== raw) proxies = { raw, trusted: trustedProxies(raw) };
  return proxies.trusted;
}

/** The client a request is charged to when it carries no verified subject. */
function clientKey(c: Context): string {
  const client = resolveClientAddress({
    // The Node socket peer; adapter-free requests (tests) fall back as heartbeatPeerAddress() does.
    peer: heartbeatPeerAddress(c) || undefined,
    forwardedFor: c.req.header('x-forwarded-for'),
    trusted: rateLimitTrustedProxies(),
  });
  // IPv6 clients are grouped by /64, since one host usually holds a whole prefix.
  return client.decision === 'unknown_peer' ? 'unknown-peer' : addressKey(client.address);
}

function tooManyRequests(c: Context, error: HiveError): Response {
  c.header('Retry-After', error.headers?.['retry-after'] ?? '60');
  return c.json({ error: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' }, 429);
}

/**
 * Rate limiter on HiveCommon `/rate-limit`, backed by Redis (see `redisWindowStore()`).
 * Keyed by the verified subject of an Oathweave token, otherwise by the client address.
 * When Redis is unavailable, a `failClosed` route answers 503; any other route falls back to an
 * in-process HiveCommon token bucket with the same budget.
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
  const serviceMax = opts.serviceMax ?? personMax;
  const prefix = opts.keyPrefix ?? 'rl';
  const stores = { person: redisWindowStore(personMax, windowMs), service: redisWindowStore(serviceMax, windowMs) };
  const fallbacks: Record<'person' | 'service', RateLimiter> = {
    person: createRateLimiter({ limit: personMax, windowMs }),
    service: createRateLimiter({ limit: serviceMax, windowMs }),
  };

  return async (c, next) => {
    const authorization = c.req.header('Authorization');
    const subject = authorization?.startsWith('Bearer ')
      ? await oathweaveRateLimitSubject(authorization.slice(7))
      : undefined;
    // Behind a same-origin ingress every browser shares one peer address, so a
    // verified subject gets its own bucket. Anything else, including a token
    // that failed verification, stays on the client-address bucket.
    const identity = subject ? `subject:${subject}` : clientKey(c);
    // One linked service identity carries many people's work, so it may get a larger budget.
    const budget = subject?.startsWith('service:') ? 'service' : 'person';
    const key = `${REDIS_PREFIX}${prefix}:${identity}`;

    try {
      await enforceRateLimit(stores[budget], key);
      // Recovery clears the health warning; lastErrorAt keeps the history.
      lastRateLimitError = null;
    } catch (error: unknown) {
      if (HiveError.is(error) && error.status === 429) {
        // Redis answered: a refusal clears the health warning as well.
        lastRateLimitError = null;
        return tooManyRequests(c, error);
      }
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
      // Redis unavailable: other routes are limited per process until it is back.
      try {
        await enforceRateLimit(fallbacks[budget], key);
      } catch (fallbackError: unknown) {
        if (HiveError.is(fallbackError) && fallbackError.status === 429) return tooManyRequests(c, fallbackError);
        throw fallbackError;
      }
    }

    return next();
  };
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
