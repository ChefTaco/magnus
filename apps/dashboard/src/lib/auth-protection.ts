import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';

const WINDOW_MS = 15 * 60 * 1000;
const SOURCE_LIMIT = 20;
const USERNAME_LIMIT = 10;
const PAIR_LIMIT = 5;
const MAX_CONCURRENT_AUTH = 8;
const MAX_DELAY_MS = 4_000;

const ATTEMPT_SCRIPT = `
local counts = {}
for i, key in ipairs(KEYS) do
  counts[i] = redis.call('INCR', key)
  if counts[i] == 1 then redis.call('PEXPIRE', key, ARGV[1]) end
end
return counts
`;

const ACQUIRE_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[1]) then return 0 end
count = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return count
`;

const RELEASE_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count <= 1 then redis.call('DEL', KEYS[1]); return 0 end
return redis.call('DECR', KEYS[1])
`;

export interface AuthRateLimitStore {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface AuthPermit {
  allowed: boolean;
  retryAfterSeconds: number;
  sourceLabel: string;
  usernameLabel: string;
  pairLabel: string;
  release(): Promise<void>;
  clearSuccessfulPair(): Promise<void>;
}

function label(kind: string, value: string): string {
  const key = process.env['AUTH_RATE_LIMIT_LABEL_KEY']
    ?? process.env['SESSION_SECRET']
    ?? 'magnus-auth-rate-limit-unconfigured';
  return createHmac('sha256', key).update(`${kind}\0${value}`).digest('hex').slice(0, 24);
}

export function resolveTrustedClientAddress(headers: Headers): string {
  if (headers.get('x-magnus-edge-normalized') !== '1') return 'unverified';
  const address = headers.get('x-real-ip')?.trim();
  return address && address.length <= 64 ? address : 'unverified';
}

export function createAuthProtection(
  store: AuthRateLimitStore,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  return async function beginAuthentication(source: string, username: string): Promise<AuthPermit> {
    const prefix = process.env['REDIS_PREFIX'] ?? 'magnus-';
    const sourceLabel = label('source', source);
    const usernameLabel = label('username', username.trim().toLowerCase());
    const pairLabel = label('pair', `${source}\0${username.trim().toLowerCase()}`);
    const concurrencyKey = `${prefix}dashboard-auth:concurrency`;
    const sourceKey = `${prefix}dashboard-auth:source:${sourceLabel}`;
    const usernameKey = `${prefix}dashboard-auth:username:${usernameLabel}`;
    const pairKey = `${prefix}dashboard-auth:pair:${pairLabel}`;
    let acquired = false;

    try {
      const slot = Number(await store.eval(ACQUIRE_SCRIPT, 1, concurrencyKey, MAX_CONCURRENT_AUTH, 30_000));
      if (slot <= 0) {
        return permit(false, 1);
      }
      acquired = true;
      const rawCounts = await store.eval(ATTEMPT_SCRIPT, 3, sourceKey, usernameKey, pairKey, WINDOW_MS);
      const counts = Array.isArray(rawCounts) ? rawCounts.map(Number) : [];
      if (counts.length !== 3 || counts.some((count) => !Number.isFinite(count))) throw new Error('invalid Redis limiter response');
      const [sourceCount, usernameCount, pairCount] = counts as [number, number, number];
      const delayMs = pairCount <= 1 ? 0 : Math.min(MAX_DELAY_MS, 250 * (2 ** (pairCount - 2)));
      if (delayMs > 0) await sleep(delayMs);
      const allowed = sourceCount <= SOURCE_LIMIT && usernameCount <= USERNAME_LIMIT && pairCount <= PAIR_LIMIT;
      return permit(allowed, allowed ? 0 : Math.ceil(WINDOW_MS / 1000));
    } catch (error) {
      if (acquired) await store.eval(RELEASE_SCRIPT, 1, concurrencyKey).catch(() => undefined);
      console.error('[dashboard-auth] durable admission control unavailable');
      throw error;
    }

    function permit(allowed: boolean, retryAfterSeconds: number): AuthPermit {
      let released = !acquired;
      return {
        allowed,
        retryAfterSeconds,
        sourceLabel,
        usernameLabel,
        pairLabel,
        async release() {
          if (released) return;
          released = true;
          await store.eval(RELEASE_SCRIPT, 1, concurrencyKey);
        },
        async clearSuccessfulPair() {
          await store.del(usernameKey, pairKey);
        },
      };
    }
  };
}

let redis: Redis | undefined;
function authRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      enableOfflineQueue: false,
    });
    redis.on('error', () => undefined);
  }
  return redis;
}

export const beginAuthentication = async (source: string, username: string): Promise<AuthPermit> => {
  const client = authRedis();
  if (client.status === 'wait') await client.connect();
  return createAuthProtection(client)(source, username);
};
