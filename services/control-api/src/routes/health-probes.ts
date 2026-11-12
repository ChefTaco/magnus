import type { Context, Env, Hono } from 'hono';
import { createHealth, type HealthCheck, type HealthResponse } from '@hivemagnus/hive-common/health';
import { getDb } from '../db/index.js';
import { getRedis } from '../queue/redis.js';

/**
 * Readiness dependencies. PostgreSQL is required; Redis only delays queued work, so its loss
 * reports `degraded` (still 200), as the dependency health view treats it.
 */
export const readinessChecks: readonly HealthCheck[] = [
  { name: 'database', check: async () => { await getDb().$queryRaw`SELECT 1`; } },
  { name: 'redis', critical: false, check: async () => (await getRedis().ping()) === 'PONG' },
];

/**
 * The suite probes: `GET /health/live` (never touches a dependency) and `GET /health/ready`
 * (200 `ready` or `degraded`, 503 `not_ready`). Public, so like `/api/v1/health` they carry no
 * version and no error text. Answered through the context, unlike the shared Hono helper's raw
 * Response, so the `x-request-id`, `traceparent` and security headers set earlier are kept.
 */
export function registerHealthProbes<E extends Env>(app: Hono<E>, checks: readonly HealthCheck[] = readinessChecks): void {
  const health = createHealth({ service: 'magnus-control-api', checks, timeoutMs: 2_000 });
  const send = (c: Context<E>, result: HealthResponse<object>) => c.json(result.body, result.status, { ...result.headers });
  for (const path of health.paths.live) app.get(path, (c) => send(c, health.live()));
  for (const path of health.paths.ready) app.get(path, async (c) => send(c, await health.ready()));
}
