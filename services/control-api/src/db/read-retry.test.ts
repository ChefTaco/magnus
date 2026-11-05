import { afterEach, describe, expect, it, vi } from 'vitest';
import { withReadRetry } from './read-retry.js';

describe('read retry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps an error it cannot help, so the error handler can classify it', async () => {
    const error = Object.assign(new Error('Invalid value'), { name: 'PrismaClientValidationError' });
    const read = vi.fn().mockRejectedValue(error);
    await expect(withReadRetry('nodes', read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('answers exhausted retries as an outage, with the driver text only in the log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly at db.example.com:5432'));
    const failure = await withReadRetry('nodes', read, { baseDelayMs: 0 }).catch((error: unknown) => error as Error & { status: number; code: string });
    expect(read).toHaveBeenCalledTimes(3);
    expect(failure).toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
    expect((failure as Error).message).not.toContain('db.example.com');
    expect(log.mock.calls[0]?.[0]).toContain('db.example.com');
  });
});
