import { Redis } from 'ioredis';

let redis: Redis | undefined;

/** Singleton Redis connection (local Redis with prefix support). */
export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      keyPrefix: process.env['REDIS_PREFIX'] ?? 'magnus:',
    });
  }
  return redis;
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = undefined;
  }
}
