import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { upgradeSettings, envSwitch } from '../config/features.js';
import { autoMigrateLimits, decideAutoMigrate, migrateDatabaseUrl, poolerWarning } from './auto-migrate.js';
import {
  backupDatabase, findReusableBackup, packagedMigrations, pruneBackups, readMigrationImpact, restoreCommand, restoreDatabase, splitPassword,
  type MigrationState,
} from './migrations.js';

const state = (pending: MigrationState['pending'], fresh = false, failed: string[] = []): MigrationState =>
  ({ packaged: ['a', ...pending.map(m => m.name)], applied: new Set(fresh ? [] : ['a']), pending, fresh, failed, unknown: [], lastApplied: fresh ? null : 'a' });

describe('upgrade switches', () => {
  it('keep auto-migrate off and everything else on unless set', () => {
    expect(upgradeSettings({})).toMatchObject({
      autoMigrate: false, autoMigrateBackup: true, autoMigrateAllowSlow: false, updateCheck: true,
      agentUpgrades: true, agentUpgradeConcurrency: 5, legacyGitSelfUpdate: false, updateRegistry: 'https://registry.npmjs.org',
    });
    expect(upgradeSettings({ MAGNUS_AUTO_MIGRATE: 'TRUE', MAGNUS_UPDATE_CHECK: 'false', MAGNUS_AGENT_UPGRADE_CONCURRENCY: '500' }))
      .toMatchObject({ autoMigrate: true, updateCheck: false, agentUpgradeConcurrency: 50 });
    expect(envSwitch('yes', false)).toBe(false);
  });
});

describe('auto-migrate decision', () => {
  const settings = { autoMigrateBackup: true, autoMigrateAllowSlow: false };
  it('skips when nothing is pending', () => {
    expect(decideAutoMigrate(state([]), settings).action).toBe('skip');
  });
  it('backs up before a fast migration, except on a fresh database', () => {
    expect(decideAutoMigrate(state([{ name: 'b', impact: 'fast', note: '' }]), settings)).toEqual({ action: 'migrate', backup: true });
    expect(decideAutoMigrate(state([{ name: 'b', impact: 'fast', note: '' }], true), settings)).toEqual({ action: 'migrate', backup: false });
    expect(decideAutoMigrate(state([{ name: 'b', impact: 'fast', note: '' }]), { ...settings, autoMigrateBackup: false }))
      .toEqual({ action: 'migrate', backup: false });
  });
  it('refuses a database with a failed migration before any dump', () => {
    const refused = decideAutoMigrate(state([{ name: 'b', impact: 'fast', note: '' }], false, ['b']), settings);
    expect(refused.action).toBe('refuse');
    expect(refused.action === 'refuse' && refused.reason).toMatch(/b failed earlier.*prisma migrate resolve/s);
  });
  it('reads its limits and the migrate connection from the environment', () => {
    expect(autoMigrateLimits({})).toEqual({ lockTimeoutMs: 600_000, keepBackups: 5 });
    expect(autoMigrateLimits({ MAGNUS_AUTO_MIGRATE_LOCK_TIMEOUT: '30', MAGNUS_BACKUP_KEEP: '2' })).toEqual({ lockTimeoutMs: 30_000, keepBackups: 2 });
    expect(migrateDatabaseUrl({ MAGNUS_MIGRATE_DATABASE_URL: 'postgresql://direct/db' }, 'postgresql://pool/db')).toBe('postgresql://direct/db');
    expect(migrateDatabaseUrl({}, 'postgresql://pool/db')).toBe('postgresql://pool/db');
    expect(poolerWarning('postgresql://u@pool:6432/db?pgbouncer=true')).toMatch(/MAGNUS_MIGRATE_DATABASE_URL/);
    expect(poolerWarning('postgresql://u@db:5432/db')).toBeNull();
  });
  it('refuses slow or one-way migrations unless allowed', () => {
    const pending = [{ name: 'b', impact: 'one-way' as const, note: 'drops a column' }];
    const refused = decideAutoMigrate(state(pending), settings);
    expect(refused.action).toBe('refuse');
    expect(refused.action === 'refuse' && refused.reason).toMatch(/drops a column/);
    expect(decideAutoMigrate(state(pending), { ...settings, autoMigrateAllowSlow: true }).action).toBe('migrate');
  });
});

describe('migration files and backups', () => {
  it('reads impact notes next to each migration and defaults to fast', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-migrations-'));
    for (const name of ['2_second', '1_first']) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'migration.sql'), 'SELECT 1;');
    }
    mkdirSync(join(dir, 'not_a_migration'));
    writeFileSync(join(dir, '2_second', 'magnus-impact.json'), JSON.stringify({ impact: 'slow', note: 'rewrites a table' }));
    expect(packagedMigrations(dir)).toEqual(['1_first', '2_second']);
    expect(readMigrationImpact(dir, '1_first')).toEqual({ impact: 'fast', note: '' });
    expect(readMigrationImpact(dir, '2_second')).toEqual({ impact: 'slow', note: 'rewrites a table' });
  });

  it('never puts the connection string in the restore command', () => {
    expect(restoreCommand("/var/backups/it's.dump", '/etc/magnus/server.env')).toBe(`magnus-server restore '/var/backups/it'\\''s.dump' --env-file '/etc/magnus/server.env'`);
    expect(splitPassword('postgresql://magnus:s%40cret@db.example.com:5432/magnus')).toEqual({
      url: 'postgresql://magnus@db.example.com:5432/magnus', env: { PGPASSWORD: 's@cret' },
    });
  });

  it('refuses a pg_dump older than the server', async () => {
    const client = { query: async () => ({ rows: [{ server_version_num: '170004' }] }) };
    const run = async () => ({ code: 0, stdout: 'pg_dump (PostgreSQL) 16.6', stderr: '' });
    await expect(backupDatabase({ databaseUrl: 'postgresql://example', backupDir: tmpdir(), label: 'x', client: client as never, run }))
      .rejects.toThrow(/PostgreSQL 16 but the server is PostgreSQL 17/);
  });

  it('writes a private dump and a metadata file with the restore command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-backups-'));
    const client = { query: async () => ({ rows: [{ server_version_num: '170004' }] }) };
    const calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const run = async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
      calls.push({ command, args, env: options.env });
      if (args[0] === '--version') return { code: 0, stdout: 'pg_dump (PostgreSQL) 17.4', stderr: '' };
      if (args[0] === '--list') return { code: 0, stdout: ';  Archive created', stderr: '' };
      writeFileSync(args[args.indexOf('--file') + 1]!, 'PGDMP');
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await backupDatabase({ databaseUrl: 'postgresql://magnus:hunter2@db/magnus', backupDir: join(dir, 'b'), label: 'pre-migrate-1.1.0',
      client: client as never, run, now: new Date('2026-11-01T00:00:00Z'), pgDump: '/usr/lib/postgresql/17/bin/pg_dump' });
    expect(result.file).toBe(join(dir, 'b', '2026-11-01T00-00-00-000Z-pre-migrate-1.1.0.dump'));
    const { statSync, readFileSync } = await import('node:fs');
    expect(statSync(result.file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(result.metadataFile, 'utf8')).restoreCommand).toBe(result.restoreCommand);
    const dump = calls.find(call => call.args.includes('--file'))!;
    expect(dump.args.join(' ')).not.toMatch(/hunter2/);
    expect(dump.env?.['PGPASSWORD']).toBe('hunter2');
    expect(calls.find(call => call.args[0] === '--list')?.command).toBe('/usr/lib/postgresql/17/bin/pg_restore');
  });

  it('rejects a dump pg_restore cannot read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-backups-'));
    const client = { query: async () => ({ rows: [{ server_version_num: '170004' }] }) };
    const run = async (_command: string, args: readonly string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: 'pg_dump (PostgreSQL) 17.4', stderr: '' };
      if (args[0] === '--list') return { code: 1, stdout: '', stderr: 'pg_restore: error: input file is too short' };
      writeFileSync(args[args.indexOf('--file') + 1]!, 'X');
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(backupDatabase({ databaseUrl: 'postgresql://example', backupDir: dir, label: 'x', client: client as never, run }))
      .rejects.toThrow(/not readable by pg_restore/);
    expect(readdirSync(dir).filter(name => name.endsWith('.dump'))).toEqual([]);
  });

  const writeDump = (dir: string, name: string, meta: Record<string, unknown>) => {
    writeFileSync(join(dir, name), 'PGDMP');
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(meta));
  };

  it('reuses a recent dump of the same database state, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-backups-'));
    const now = new Date('2026-11-01T01:00:00Z');
    writeDump(dir, 'a.dump', { createdAt: '2026-11-01T00:50:00Z', label: 'pre-migrate-1.1.3', lastApplied: 'm1' });
    writeDump(dir, 'old.dump', { createdAt: '2026-10-31T00:00:00Z', label: 'pre-migrate-1.1.3', lastApplied: 'm1' });
    expect(findReusableBackup(dir, 'pre-migrate-1.1.3', 'm1', 3_600_000, now)).toBe(join(dir, 'a.dump'));
    expect(findReusableBackup(dir, 'pre-migrate-1.1.3', 'm2', 3_600_000, now)).toBeNull();
    expect(findReusableBackup(dir, 'pre-migrate-1.1.4', 'm1', 3_600_000, now)).toBeNull();
    expect(findReusableBackup(dir, 'pre-migrate-1.1.3', 'm1', 60_000, now)).toBeNull();
  });

  it('prunes old dumps but keeps the newest of every label', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-backups-'));
    for (let i = 0; i < 6; i++) writeDump(dir, `loop-${i}.dump`, { createdAt: `2026-11-01T0${i}:00:00Z`, label: 'pre-migrate-1.1.3' });
    writeDump(dir, 'upgrade.dump', { createdAt: '2026-10-01T00:00:00Z', label: 'pre-upgrade-1.1.2-to-1.1.3' });
    const removed = pruneBackups(dir, 3);
    expect(removed.map(file => file.slice(dir.length + 1)).sort()).toEqual(['loop-0.dump', 'loop-1.dump', 'loop-2.dump']);
    expect(existsSync(join(dir, 'upgrade.dump'))).toBe(true);
    expect(existsSync(join(dir, 'loop-0.dump.json'))).toBe(false);
  });

  it('restores into a fresh schema and puts the original back when pg_restore fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-restore-'));
    const file = join(dir, 'x.dump');
    writeFileSync(file, 'PGDMP');
    const queries: string[] = [];
    const client = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } };
    let restoreCode = 0;
    const run = async (_command: string, args: readonly string[]) => (args[0] === '--list'
      ? { code: 0, stdout: '', stderr: '' } : { code: restoreCode, stdout: '', stderr: 'pg_restore: error: boom' });
    await restoreDatabase({ databaseUrl: 'postgresql://u:p@db/x', file, client: client as never, run, now: new Date('2026-11-01T00:00:00Z') });
    expect(queries[0]).toMatch(/ALTER SCHEMA public RENAME TO %I', 'magnus_pre_restore_20261101000000'/);
    expect(queries[1]).toBe('DROP SCHEMA "magnus_pre_restore_20261101000000" CASCADE;');
    queries.length = 0;
    restoreCode = 1;
    await expect(restoreDatabase({ databaseUrl: 'postgresql://u:p@db/x', file, client: client as never, run })).rejects.toThrow(/database is unchanged/);
    expect(queries[1]).toMatch(/DROP SCHEMA public CASCADE; ALTER SCHEMA "magnus_pre_restore_\d+" RENAME TO public/);
  });
});
