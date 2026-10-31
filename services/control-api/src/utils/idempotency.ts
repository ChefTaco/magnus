import { createHash, randomUUID } from 'node:crypto';
import { getRedis } from '../queue/redis.js';
import type { Context } from 'hono';
import { routePath } from 'hono/route';
import { HttpError } from '../middleware/error-handler.js';

const IDEMPOTENCY_TTL_SECONDS = 86_400;
const RELEASE_IF_OWNED = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** A held idempotency key. Release it only when the request created nothing. */
export interface IdempotencyClaim {
  release(): Promise<void>;
}

/** Keys are namespaced by operation scope and actor, so the same client key
 * used on another route or by another user is not a duplicate. */
function idempotencyRedisKey(scope: string, actorId: string, key: string): string {
  return `idem:${createHash('sha256').update(JSON.stringify([scope, actorId, key])).digest('hex')}`;
}

/**
 * Atomically claim an idempotency key (Redis SET NX, 24-hour TTL). Throws 409
 * DUPLICATE_REQUEST if the key is already held for this scope and actor.
 * Callers claim after validation, dry-run, and preflight checks, immediately
 * before the first durable effect.
 */
export async function claimIdempotency(scope: string, actorId: string, key: string): Promise<IdempotencyClaim> {
  const redis = getRedis();
  const redisKey = idempotencyRedisKey(scope, actorId, key);
  const token = randomUUID();
  const result = await redis.set(redisKey, token, 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
  if (result === null) {
    throw new HttpError(409, 'DUPLICATE_REQUEST', `Idempotency key already used: ${key}`);
  }
  return {
    async release() {
      await redis.eval(RELEASE_IF_OWNED, 1, redisKey, token).catch(() => undefined);
    },
  };
}

/**
 * Enforce idempotency when the `x-idempotency-key` header is present.
 * For endpoints where the key is optional — callers that supply it get
 * duplicate-request protection; callers that omit it proceed normally.
 * The key is scoped to the matched route and the authenticated actor.
 */
export async function enforceIdempotencyFromHeader(c: Context): Promise<IdempotencyClaim | undefined> {
  const key = c.req.header('x-idempotency-key');
  if (!key) return undefined;
  const actorId = (c.var as { user?: { userId?: string } }).user?.userId ?? 'anonymous';
  return claimIdempotency(`${c.req.method} ${routePath(c) || c.req.path}`, actorId, key);
}
