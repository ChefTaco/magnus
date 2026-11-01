import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autoMigrate } from './auto-migrate.js';

// Two instances starting at once against one database: exactly one dumps and
// migrates, the other waits on the advisory lock and then finds nothing to do.
describe.skipIf(!process.env['TEST_DATABASE_URL'])('auto-migrate under concurrent startup', () => {
  const admin = new URL(process.env['TEST_DATABASE_URL']!);
  const name = `magnus_ideas_automigrate_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const target = new URL(admin.toString());
  target.pathname = `/${name}`;
  const work = mkdtempSync(join(tmpdir(), 'magnus-automigrate-'));
  const migrationsDir = join(work, 'migrations');
  const fakePgDump = join(work, 'pg_dump');

  beforeAll(async () => {
    if (!admin.pathname.startsWith('/magnus_ideas_')) throw new Error('Owned disposable test database required');
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    await client.query(`CREATE DATABASE ${name}`);
    await client.end();
    for (const migration of ['1_applied', '2_pending']) {
      mkdirSync(join(migrationsDir, migration), { recursive: true });
      writeFileSync(join(migrationsDir, migration, 'migration.sql'), 'SELECT 1;');
    }
    const db = new pg.Client({ connectionString: target.toString() });
    await db.connect();
    await db.query(`CREATE TABLE _prisma_migrations (migration_name text PRIMARY KEY, finished_at timestamptz, rolled_back_at timestamptz)`);
    await db.query(`INSERT INTO _prisma_migrations VALUES ('1_applied', now(), NULL)`);
    await db.end();
    // Stand-in pg_dump: reports the server's major version and writes a file.
    writeFileSync(fakePgDump, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 99.0"; exit 0; fi
while [ $# -gt 0 ]; do if [ "$1" = "--file" ]; then printf PGDMP > "$2"; fi; shift; done
`);
    chmodSync(fakePgDump, 0o755);
  });

  afterAll(async () => {
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.end();
  });

  it('dumps and migrates exactly once', async () => {
    let migrations = 0;
    const migrate = async () => {
      migrations++;
      await new Promise(resolve => setTimeout(resolve, 300));
      const db = new pg.Client({ connectionString: target.toString() });
      await db.connect();
      await db.query(`INSERT INTO _prisma_migrations VALUES ('2_pending', now(), NULL)`);
      await db.end();
    };
    const backupDir = join(work, 'backups');
    const options = {
      databaseUrl: target.toString(), migrationsDir, backupDir, version: '1.1.0', pgDump: fakePgDump, migrate, log: () => undefined,
      settings: { autoMigrateBackup: true, autoMigrateAllowSlow: false },
    };
    const results = await Promise.all([autoMigrate(options), autoMigrate(options)]);
    expect(migrations).toBe(1);
    expect(results.map(result => result.decision.action).sort()).toEqual(['migrate', 'skip']);
    expect(readdirSync(backupDir).filter(file => file.endsWith('.dump'))).toHaveLength(1);
  });
});
