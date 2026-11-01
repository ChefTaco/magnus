/**
 * Migration state, impact notes and pre-migration backups, shared by
 * `magnus-server migrate`, `check` and startup auto-migrate.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type pg from 'pg';

export type MigrationImpact = 'fast' | 'slow' | 'one-way';

export interface PendingMigration {
  name: string;
  impact: MigrationImpact;
  note: string;
}

export interface MigrationState {
  packaged: string[];
  applied: Set<string>;
  pending: PendingMigration[];
  /** True when no Magnus migration has ever been applied (a fresh database). */
  fresh: boolean;
}

/** Packaged migration directory names, in apply order. */
export function packagedMigrations(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, 'migration.sql')))
    .map(entry => entry.name)
    .sort();
}

/**
 * Each migration may carry `magnus-impact.json` (`{"impact":"slow","note":"…"}`).
 * A migration without one is treated as fast and reversible by rollback.
 */
export function readMigrationImpact(migrationsDir: string, name: string): { impact: MigrationImpact; note: string } {
  const path = join(migrationsDir, name, 'magnus-impact.json');
  if (!existsSync(path)) return { impact: 'fast', note: '' };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { impact?: unknown; note?: unknown };
  const impact = raw.impact === 'slow' || raw.impact === 'one-way' ? raw.impact : 'fast';
  return { impact, note: typeof raw.note === 'string' ? raw.note : '' };
}

export async function readMigrationState(client: pg.Client, migrationsDir: string): Promise<MigrationState> {
  const packaged = packagedMigrations(migrationsDir);
  const table = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`);
  const applied = table.rows[0]?.exists
    ? new Set((await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows
      .map(row => row.migration_name))
    : new Set<string>();
  const pending = packaged.filter(name => !applied.has(name))
    .map(name => ({ name, ...readMigrationImpact(migrationsDir, name) }));
  return { packaged, applied, pending, fresh: applied.size === 0 };
}

/** Pending migrations an operator must confirm: slow ones, or ones only a restore can undo. */
export function migrationsNeedingAttention(pending: readonly PendingMigration[]): PendingMigration[] {
  return pending.filter(migration => migration.impact !== 'fast');
}

export function describeMigration(migration: PendingMigration): string {
  return `${migration.name} (${migration.impact}${migration.note ? `: ${migration.note}` : ''})`;
}

export type CommandRunner = (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string; capture?: boolean }) =>
  Promise<{ code: number; stdout: string; stderr: string }>;

export const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
});

/** Absolute path of the prisma CLI installed next to magnus-server. */
export function prismaCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
}

export function majorOf(versionText: string): number | null {
  const match = /(\d+)(?:\.\d+)?/.exec(versionText);
  return match ? Number(match[1]) : null;
}

export interface BackupResult {
  file: string;
  metadataFile: string;
  restoreCommand: string;
}

/** A restore command that never contains the connection password. */
export function restoreCommand(file: string): string {
  return `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" '${file.replace(/'/g, `'\\''`)}'`;
}

export interface BackupOptions {
  databaseUrl: string;
  backupDir: string;
  label: string;
  client: pg.Client;
  pgDump?: string;
  run?: CommandRunner;
  now?: Date;
}

/**
 * `pg_dump -Fc` into the backup directory (0700 directory, 0600 dump).
 * Refuses when pg_dump is older than the server, which would produce an
 * unusable or partial dump.
 */
export async function backupDatabase(options: BackupOptions): Promise<BackupResult> {
  const run = options.run ?? runCommand;
  const pgDump = options.pgDump ?? 'pg_dump';
  const serverVersion = (await options.client.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]?.server_version_num ?? '';
  const serverMajor = serverVersion ? Math.floor(Number(serverVersion) / 10_000) : null;
  let client: Awaited<ReturnType<CommandRunner>>;
  try {
    client = await run(pgDump, ['--version'], { capture: true });
  } catch {
    throw new Error(`${pgDump} is not installed. Install the PostgreSQL ${serverMajor ?? ''} client tools (or set MAGNUS_PG_DUMP), or set MAGNUS_AUTO_MIGRATE_BACKUP=false if you back up the database another way.`.replace('  ', ' '));
  }
  const clientMajor = majorOf(client.stdout);
  if (client.code !== 0 || clientMajor === null) throw new Error(`${pgDump} --version failed: ${client.stderr.trim() || client.stdout.trim()}`);
  if (serverMajor !== null && clientMajor < serverMajor) {
    throw new Error(`${pgDump} is PostgreSQL ${clientMajor} but the server is PostgreSQL ${serverMajor}; install a matching client (or set MAGNUS_PG_DUMP).`);
  }

  mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const file = join(options.backupDir, `${stamp}-${options.label.replace(/[^A-Za-z0-9._-]+/g, '_')}.dump`);
  const result = await run(pgDump, ['--format=custom', '--no-owner', '--file', file, '--dbname', options.databaseUrl], { capture: true });
  if (result.code !== 0) throw new Error(`pg_dump failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
  if (!existsSync(file) || statSync(file).size === 0) throw new Error(`pg_dump wrote no data to ${file}`);
  chmodSync(file, 0o600);
  const metadataFile = `${file}.json`;
  const restore = restoreCommand(file);
  writeFileSync(metadataFile, `${JSON.stringify({
    createdAt: (options.now ?? new Date()).toISOString(),
    label: options.label,
    postgresMajor: serverMajor,
    pgDumpMajor: clientMajor,
    restoreCommand: restore,
  }, null, 2)}\n`, { mode: 0o600 });
  return { file, metadataFile, restoreCommand: restore };
}
