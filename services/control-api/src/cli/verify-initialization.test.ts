import type pg from 'pg';
import { expect, it } from 'vitest';
import { verifyInitialization } from './verify-initialization.js';
import { parseArgs } from './args.js';

it('requires committed initialization and mandatory base identities using SELECT only', async () => {
  for (const state of [{ completed: true, actor: true, sentinels: true }, { completed: false, actor: true, sentinels: true }, { completed: true, actor: false, sentinels: true }, { completed: true, actor: true, sentinels: false }]) {
    const queries: string[] = [];
    const client = { query: async (sql: string) => { queries.push(sql); return { rows: [state] }; } } as unknown as pg.Client;
    const result = verifyInitialization(client);
    if (Object.values(state).every(Boolean)) await result;
    else await expect(result).rejects.toThrow(/activation remains held/);
    expect(queries).toHaveLength(1); expect(queries[0]).toMatch(/^SELECT\s/);
  }
  expect(parseArgs(['verify-initialization']).command).toBe('verify-initialization');
});
