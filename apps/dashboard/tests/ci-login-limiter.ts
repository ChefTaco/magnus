import { Redis } from 'ioredis';

// The CI harness signs in from one unproxied source, so every login in the run shares the
// console's per-source budget (20 per 15 minutes). Specs that spend it on purpose reset it.
const prefix = 'magnus-ui-ci-dashboard-auth:';

export async function resetLoginLimiter(): Promise<void> {
  const url = process.env['UI_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:55440';
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Local disposable Redis required');
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      // The concurrency lease belongs to in-flight sign-ins; leave it to its own TTL.
      const counters = keys.filter((key) => !key.endsWith(':concurrency'));
      if (counters.length) await redis.del(...counters);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}
