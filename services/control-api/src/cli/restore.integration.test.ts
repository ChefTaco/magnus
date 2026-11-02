import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDatabase, pgRestoreFor, restoreDatabase } from './migrations.js';

const pgDump = process.env['MAGNUS_PG_DUMP'] ?? 'pg_dump';
const hasTools = (() => {
  try {
    execFileSync(pgDump, ['--version']);
    execFileSync(pgRestoreFor(process.env['MAGNUS_PG_DUMP']), ['--version']);
    return true;
  } catch {
    return false;
  }
})();

// A restore must leave exactly the dumped schema: tables a newer release
// created are gone, and the schema keeps its owner and grants.
describe.skipIf(!process.env['TEST_DATABASE_URL'] || !hasTools)('restoring a dump', () => {
  const admin = new URL(process.env['TEST_DATABASE_URL']!);
  const name = `magnus_ideas_restore_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const target = new URL(admin.toString());
  target.pathname = `/${name}`;
  const work = mkdtempSync(join(tmpdir(), 'magnus-restore-'));
  let db: pg.Client;

  beforeAll(async () => {
    if (!admin.pathname.startsWith('/magnus_ideas_')) throw new Error('Owned disposable test database required');
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    await client.query(`CREATE DATABASE ${name}`);
    await client.end();
    db = new pg.Client({ connectionString: target.toString() });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end();
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.end();
  });

  const schemaAcl = async () => (await db.query<{ owner: string; acl: string | null }>(
    `SELECT pg_get_userbyid(nspowner) AS owner, nspacl::text AS acl FROM pg_namespace WHERE nspname = 'public'`)).rows[0];

  it('drops objects the dump does not contain and keeps the schema owner and grants', async () => {
    await db.query('CREATE TABLE kept (id int PRIMARY KEY, value text)');
    await db.query(`INSERT INTO kept VALUES (1, 'before')`);
    const before = await schemaAcl();
    const backup = await backupDatabase({ databaseUrl: target.toString(), backupDir: join(work, 'backups'), label: 'test', client: db, pgDump });
    await db.query('CREATE TABLE added_by_newer_release (id int)');
    await db.query(`UPDATE kept SET value = 'after'`);
    await restoreDatabase({ databaseUrl: target.toString(), file: backup.file, client: db, pgRestore: pgRestoreFor(process.env['MAGNUS_PG_DUMP']) });
    const tables = (await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map(row => row.tablename);
    expect(tables).toEqual(['kept']);
    expect((await db.query('SELECT value FROM kept')).rows).toEqual([{ value: 'before' }]);
    expect(await schemaAcl()).toEqual(before);
    const leftovers = await db.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'magnus_pre_restore_%'`);
    expect(leftovers.rows).toEqual([]);
  });
});
