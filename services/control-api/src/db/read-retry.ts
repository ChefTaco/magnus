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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${label} failed after ${attempts} read attempts: ${message}`);
}
