import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { upgradeSettings, envSwitch } from '../config/features.js';
import { decideAutoMigrate } from './auto-migrate.js';
import { backupDatabase, packagedMigrations, readMigrationImpact, restoreCommand, type MigrationState } from './migrations.js';

const state = (pending: MigrationState['pending'], fresh = false): MigrationState =>
  ({ packaged: ['a', ...pending.map(m => m.name)], applied: new Set(fresh ? [] : ['a']), pending, fresh });

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
    expect(restoreCommand("/var/backups/it's.dump")).toBe(`pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" '/var/backups/it'\\''s.dump'`);
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
    const run = async (_command: string, args: readonly string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: 'pg_dump (PostgreSQL) 17.4', stderr: '' };
      writeFileSync(args[args.indexOf('--file') + 1]!, 'PGDMP');
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await backupDatabase({ databaseUrl: 'postgresql://example', backupDir: join(dir, 'b'), label: 'pre-migrate-1.1.0', client: client as never, run, now: new Date('2026-11-01T00:00:00Z') });
    expect(result.file).toBe(join(dir, 'b', '2026-11-01T00-00-00-000Z-pre-migrate-1.1.0.dump'));
    const { statSync, readFileSync } = await import('node:fs');
    expect(statSync(result.file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(result.metadataFile, 'utf8')).restoreCommand).toBe(result.restoreCommand);
  });
});
