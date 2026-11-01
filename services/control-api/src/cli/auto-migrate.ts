/**
 * Startup auto-migrate (`MAGNUS_AUTO_MIGRATE=true`).
 *
 * Runs before the server listens. A session advisory lock serializes every
 * instance sharing the database, so only one dumps and migrates while the
 * others wait and then find nothing pending. A failed backup stops startup:
 * migrations never run without a dump unless the operator turned the dump off.
 */
import { join } from 'node:path';
import pg from 'pg';
import type { UpgradeSettings } from '../config/features.js';
import {
  backupDatabase,
  describeMigration,
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
}

export interface AutoMigrateResult {
  decision: AutoMigrateDecision;
  backup?: BackupResult;
}

export async function autoMigrate(options: AutoMigrateOptions): Promise<AutoMigrateResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const client = new pg.Client({ connectionString: options.databaseUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  let locked = false;
  try {
    const tried = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [MIGRATE_LOCK_KEY]);
    if (!tried.rows[0]?.locked) {
      log('[auto-migrate] another instance is migrating; waiting for it to finish');
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MIGRATE_LOCK_KEY]);
    }
    locked = true;
    const state = await readMigrationState(client, options.migrationsDir);
    const decision = decideAutoMigrate(state, options.settings);
    if (decision.action === 'skip') {
      log(`[auto-migrate] nothing to do: ${decision.reason}`);
      return { decision };
    }
    if (decision.action === 'refuse') throw new Error(`Auto-migrate refused: ${decision.reason}`);
    log(`[auto-migrate] ${state.pending.length} pending: ${state.pending.map(describeMigration).join(', ')}`);
    let backup: BackupResult | undefined;
    if (decision.backup) {
      backup = await backupDatabase({
        databaseUrl: options.databaseUrl,
        backupDir: options.backupDir,
        label: `pre-migrate-${options.version}`,
        client,
        pgDump: options.pgDump,
      }).catch((error: unknown) => {
        throw new Error(`Auto-migrate stopped before migrating: the backup failed. ${error instanceof Error ? error.message : String(error)}`);
      });
      log(`[auto-migrate] backup written to ${backup.file}`);
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
    return { decision, backup };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATE_LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export function defaultBackupDir(env: NodeJS.ProcessEnv, home: string): string {
  return env['MAGNUS_BACKUP_DIR']?.trim() || join(home, 'backups');
}
