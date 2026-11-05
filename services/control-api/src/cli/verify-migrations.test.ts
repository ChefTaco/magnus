import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { verifyCurrentMigrations } from './migrations.js';
import { parseArgs } from './args.js';
it('verifies exact finished immutable migrations with SELECT only, refusing all incomplete or conflicting states', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'magnus-migration-verification-'));
  try {
    const sql = 'CREATE TABLE synthetic_fixture (id text);\n', name = '20260101000000_synthetic';
    mkdirSync(join(directory, name)); writeFileSync(join(directory, name, 'migration.sql'), sql);
    const good = { migration_name: name, checksum: createHash('sha256').update(sql).digest('hex'), finished_at: new Date(), rolled_back_at: null };
    const verify = async (rows: unknown[], exists = true) => {
      const queries: string[] = [];
      const client = { query: async (query: string) => { queries.push(query); return { rows: queries.length === 1 ? [{ exists }] : rows }; } } as unknown as pg.Client;
      try { await verifyCurrentMigrations(client, directory); }
      finally { expect(queries.every(query => query.startsWith('SELECT '))).toBe(true); }
    };
    await verify([good]);
    await expect(verify([], false)).rejects.toThrow(/absent/);
    await expect(verify([])).rejects.toThrow(/exact release/);
    await expect(verify([{ ...good, finished_at: null }])).rejects.toThrow(/unfinished/);
    await expect(verify([{ ...good, checksum: '0'.repeat(64) }])).rejects.toThrow(/checksum/);
    await expect(verify([{ ...good, migration_name: 'unknown_release' }])).rejects.toThrow(/exact release/);
    await expect(verify([good, good])).rejects.toThrow(/exact release/);
    expect(parseArgs(['verify-migrations', '--env-file', '/opt/service/private.env']).command).toBe('verify-migrations');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
