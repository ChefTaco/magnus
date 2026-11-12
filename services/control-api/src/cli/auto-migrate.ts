import { optional } from '../utils/optional.js';
/**
 * Startup auto-migrate (`MAGNUS_AUTO_MIGRATE=true`).
 *
 * Runs before the server listens. A session advisory lock serializes every
 * instance sharing the database, so only one dumps and migrates while the
 * others wait (up to MAGNUS_AUTO_MIGRATE_LOCK_TIMEOUT) and then find nothing
 * pending. A failed backup stops startup: migrations never run without a dump
 * unless the operator turned the dump off. A database with a failed migration
 * is refused before any dump, and a restart loop reuses its recent dump, so a
 * crash-looping service cannot fill the disk.
 */
import { join } from 'node:path';
import pg from 'pg';
import type { UpgradeSettings } from '../config/features.js';
import {
  backupDatabase,
  backupKeep,
  describeMigration,
  failedMigrationAdvice,
  findReusableBackup,
  restoreCommand,
  migrationsNeedingAttention,
  readMigrationState,
  type BackupResult,
  type MigrationState,
} from './migrations.js';

/** Key for `pg_advisory_lock(hashtextextended(key, 0))`; distinct from Prisma's own migrate lock. */
export const MIGRATE_LOCK_KEY = 'magnus:migrate';

export type AutoMigrateDecision =
  | { action: 'skip'; reason: string }
  | { action: 'refuse'; reason: string }
  | { action: 'migrate'; backup: boolean };

/** Pure decision, separated for tests. */
export function decideAutoMigrate(state: MigrationState, settings: Pick<UpgradeSettings, 'autoMigrateBackup' | 'autoMigrateAllowSlow'>): AutoMigrateDecision {
  if (state.failed.length > 0) return { action: 'refuse', reason: failedMigrationAdvice(state.failed) };
  if (state.pending.length === 0) return { action: 'skip', reason: `${state.packaged.length} migration(s) already applied` };
  const attention = migrationsNeedingAttention(state.pending);
  if (attention.length > 0 && !settings.autoMigrateAllowSlow) {
    return {
      action: 'refuse',
      reason: `pending migration(s) need an operator: ${attention.map(describeMigration).join('; ')}. `
        + 'Run `magnus upgrade` (or `magnus-server migrate` after a backup), or set MAGNUS_AUTO_MIGRATE_ALLOW_SLOW=true.',
    };
  }
  // A fresh database has nothing to back up.
  return { action: 'migrate', backup: settings.autoMigrateBackup && !state.fresh };
}

/** A dump this recent of the same database state is reused by the next attempt. */
export const BACKUP_REUSE_MS = 60 * 60_000;

export interface AutoMigrateLimits {
  /** How long to wait for another instance's migrate lock (MAGNUS_AUTO_MIGRATE_LOCK_TIMEOUT, seconds). */
  lockTimeoutMs: number;
  /** Dumps kept in the backup directory (MAGNUS_BACKUP_KEEP). */
  keepBackups: number;
}

export function autoMigrateLimits(env: NodeJS.ProcessEnv = process.env): AutoMigrateLimits {
  const seconds = Number(env['MAGNUS_AUTO_MIGRATE_LOCK_TIMEOUT'] ?? '');
  return { lockTimeoutMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000, keepBackups: backupKeep(env) };
}

/**
 * The connection migrations and dumps use: MAGNUS_MIGRATE_DATABASE_URL when
 * set (a direct connection past a pooler), else DATABASE_URL.
 */
export function migrateDatabaseUrl(env: NodeJS.ProcessEnv, fallback: string): string {
  return env['MAGNUS_MIGRATE_DATABASE_URL']?.trim() || fallback;
}

/** Advisory locks do not survive PgBouncer transaction pooling. */
export function poolerWarning(url: string): string | null {
  try {
    return new URL(url).searchParams.get('pgbouncer') === 'true'
      ? 'DATABASE_URL goes through PgBouncer (pgbouncer=true): the migrate lock and prisma migrate need a direct connection; set MAGNUS_MIGRATE_DATABASE_URL.'
      : null;
  } catch {
    return null;
  }
}

export interface AutoMigrateOptions {
  databaseUrl: string;
  migrationsDir: string;
  backupDir: string;
  version: string;
  settings: Pick<UpgradeSettings, 'autoMigrateBackup' | 'autoMigrateAllowSlow'>;
  pgDump?: string;
  /** Applies the migrations (prisma migrate deploy + base data). */
  migrate: () => Promise<void>;
  log?: (line: string) => void;
  limits?: Partial<AutoMigrateLimits>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface AutoMigrateResult {
  decision: AutoMigrateDecision;
  backup?: BackupResult;
}

export async function autoMigrate(options: AutoMigrateOptions): Promise<AutoMigrateResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const limits = { ...autoMigrateLimits(), ...options.limits };
  const pooler = poolerWarning(options.databaseUrl);
  if (pooler) log(`[auto-migrate] warning: ${pooler}`);
  const client = new pg.Client({ connectionString: options.databaseUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  let locked = false;
  try {
    const deadline = now().getTime() + limits.lockTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      const tried = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [MIGRATE_LOCK_KEY]);
      if (tried.rows[0]?.locked) break;
      if (attempt === 0) log('[auto-migrate] another instance is migrating; waiting for it to finish');
      if (now().getTime() >= deadline) {
        throw new Error(`Auto-migrate gave up after ${Math.round(limits.lockTimeoutMs / 1000)} s waiting for another instance's migrate lock (MAGNUS_AUTO_MIGRATE_LOCK_TIMEOUT). `
          + 'If no other server is migrating, a stale session holds it: check pg_locks for advisory locks, or connect without a pooler (MAGNUS_MIGRATE_DATABASE_URL).');
      }
      await sleep(2_000);
    }
    locked = true;
    const state = await readMigrationState(client, options.migrationsDir);
    if (state.unknown.length > 0) {
      log(`[auto-migrate] warning: the database has ${state.unknown.length} migration(s) this version does not know (a newer release applied them): ${state.unknown.map(m => m.name).join(', ')}. `
        + 'If this version misbehaves, upgrade again or restore the dump taken before that upgrade.');
    }
    const decision = decideAutoMigrate(state, options.settings);
    if (decision.action === 'skip') {
      log(`[auto-migrate] nothing to do: ${decision.reason}`);
      return { decision };
    }
    if (decision.action === 'refuse') throw new Error(`Auto-migrate refused: ${decision.reason}`);
    log(`[auto-migrate] ${state.pending.length} pending: ${state.pending.map(describeMigration).join(', ')}`);
    let backup: BackupResult | undefined;
    if (decision.backup) {
      const label = `pre-migrate-${options.version}`;
      const recent = findReusableBackup(options.backupDir, label, state.lastApplied, BACKUP_REUSE_MS, now());
      if (recent) {
        backup = { file: recent, metadataFile: `${recent}.json`, restoreCommand: restoreCommand(recent), reused: true };
        log(`[auto-migrate] reusing the dump of the same database state from the last attempt: ${recent}`);
      } else {
        backup = await backupDatabase({ databaseUrl: options.databaseUrl, backupDir: options.backupDir, label, client, ...optional("pgDump", options.pgDump), lastApplied: state.lastApplied, keep: limits.keepBackups, now: now() }).catch((error: unknown) => {
          throw new Error(`Auto-migrate stopped before migrating: the backup failed. ${error instanceof Error ? error.message : String(error)}`);
        });
        log(`[auto-migrate] backup written to ${backup.file}`);
      }
    } else if (!state.fresh) {
      log('[auto-migrate] MAGNUS_AUTO_MIGRATE_BACKUP=false: migrating without a dump');
    }
    try {
      await options.migrate();
    } catch (error) {
      const restore = backup ? ` To restore the pre-migration state: ${backup.restoreCommand}` : '';
      throw new Error(`${error instanceof Error ? error.message : String(error)}${restore}`);
    }
    log('[auto-migrate] migrations applied');
    return { decision, ...optional("backup", backup) };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATE_LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export function defaultBackupDir(env: NodeJS.ProcessEnv, home: string): string {
  return env['MAGNUS_BACKUP_DIR']?.trim() || join(home, 'backups');
}
