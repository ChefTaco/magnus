import { setTimeout as sleep } from 'node:timers/promises';
import { incMetric } from '../routes/metrics.js';

const TRANSIENT_DATABASE_PATTERNS = [
  'Timed out fetching a new connection',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'ECONNRESET',
  '57P01',
];

function isTransientReadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_DATABASE_PATTERNS.some((pattern) => message.includes(pattern));
}

export async function withReadRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 35;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransientReadError(err)) break;
      incMetric('dbReadRetries');
      await sleep(baseDelayMs * attempt);
    }
  }

  // An error that retrying cannot help is not an outage: keep it, so its handler can classify it.
  if (!isTransientReadError(lastErr)) throw lastErr;
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.error(`[db] ${label} failed after ${attempts} read attempts: ${message}`);
  throw Object.assign(new Error('The database is temporarily unavailable. Try again shortly.'), { status: 503, code: 'DATABASE_UNAVAILABLE' });
}
