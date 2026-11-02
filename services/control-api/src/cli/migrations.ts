/**
 * Migration state, impact notes and pre-migration backups, shared by
 * `magnus-server migrate`, `check` and startup auto-migrate.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { restoreAsideSchema, restoreFinishSql, restoreRevertSql, restoreSwapSql } from '@hivemagnus/magnus-contracts';
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
  /** Started but never finished (a failed `migrate deploy`): Prisma refuses to continue until resolved. */
  failed: string[];
  /** Applied but not packaged with this version: the database is ahead (a newer release migrated it). */
  unknown: Array<{ name: string; appliedAt: string | null }>;
  /** Newest applied migration, used to recognise a dump of the same database state. */
  lastApplied: string | null;
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
  const rows = table.rows[0]?.exists
    ? (await client.query<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>(
      'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name')).rows
    : [];
  const done = rows.filter(row => row.finished_at && !row.rolled_back_at);
  const applied = new Set(done.map(row => row.migration_name));
  const failed = [...new Set(rows.filter(row => !row.finished_at && !row.rolled_back_at && !applied.has(row.migration_name)).map(row => row.migration_name))];
  const known = new Set(packaged);
  const pending = packaged.filter(name => !applied.has(name))
    .map(name => ({ name, ...readMigrationImpact(migrationsDir, name) }));
  const unknown = done.filter(row => !known.has(row.migration_name))
    .map(row => ({ name: row.migration_name, appliedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null }));
  const lastApplied = [...applied].sort().at(-1) ?? null;
  return { packaged, applied, pending, fresh: applied.size === 0, failed, unknown, lastApplied };
}

/** Why Prisma will not migrate a database with failed rows, and the ways out. */
export function failedMigrationAdvice(failed: readonly string[]): string {
  return [
    `migration(s) ${failed.join(', ')} failed earlier and are still marked as failed in _prisma_migrations; the database may be half-migrated.`,
    'Restore the dump taken before that attempt (`magnus restore <dump>`, or `magnus-server restore <dump> --env-file <file>` with the server stopped),',
    'or repair the schema by hand and then mark the migration with `npx prisma migrate resolve --rolled-back <name>` (or `--applied <name>`).',
  ].join(' ');
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
  /** True when a recent dump of the same database state was reused instead of dumping again. */
  reused?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that restores a dump; it never contains the connection string. */
export function restoreCommand(file: string, envFile = process.env['MAGNUS_ENV_FILE']): string {
  return `magnus-server restore ${shellQuote(file)}${envFile ? ` --env-file ${shellQuote(envFile)}` : ''}`;
}

/** Connection URL without its password, and the password for PGPASSWORD (never in argv). */
export function splitPassword(databaseUrl: string): { url: string; env: NodeJS.ProcessEnv } {
  try {
    const url = new URL(databaseUrl);
    const password = decodeURIComponent(url.password);
    url.password = '';
    return { url: url.toString(), env: password ? { PGPASSWORD: password } : {} };
  } catch {
    return { url: databaseUrl, env: {} };
  }
}

/** pg_restore next to the configured pg_dump (same client version), else from PATH. */
export function pgRestoreFor(pgDump: string | undefined): string {
  return pgDump && pgDump.includes('/') ? join(dirname(pgDump), 'pg_restore') : 'pg_restore';
}

export interface BackupOptions {
  databaseUrl: string;
  backupDir: string;
  label: string;
  client: pg.Client;
  pgDump?: string;
  run?: CommandRunner;
  now?: Date;
  /** Newest applied migration, recorded so a crash loop can reuse the dump. */
  lastApplied?: string | null;
  /** Dumps to keep in backupDir (MAGNUS_BACKUP_KEEP); the newest of each label is always kept. */
  keep?: number;
}

interface BackupMetadata {
  createdAt?: string;
  label?: string;
  lastApplied?: string | null;
}

function readMetadata(file: string): BackupMetadata | null {
  try {
    return JSON.parse(readFileSync(`${file}.json`, 'utf8')) as BackupMetadata;
  } catch {
    return null;
  }
}

function dumpsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.dump')).map(name => join(dir, name));
}

/**
 * A dump taken within `maxAgeMs` with the same label and the same newest
 * applied migration: the database is in the state it captured (a restart loop
 * after a failed migrate), so dumping again would only fill the disk.
 */
export function findReusableBackup(dir: string, label: string, lastApplied: string | null, maxAgeMs: number, now = new Date()): string | null {
  let best: { file: string; at: number } | null = null;
  for (const file of dumpsIn(dir)) {
    const meta = readMetadata(file);
    if (!meta?.createdAt || meta.label !== label || (meta.lastApplied ?? null) !== lastApplied || !('lastApplied' in meta)) continue;
    const at = Date.parse(meta.createdAt);
    if (!Number.isFinite(at) || now.getTime() - at > maxAgeMs || at > now.getTime()) continue;
    if (statSync(file).size === 0) continue;
    if (!best || at > best.at) best = { file, at };
  }
  return best?.file ?? null;
}

/**
 * Keep the newest `keep` dumps; older ones go, except the newest dump of each
 * label (the one a rollback of that step would restore). Returns removed files.
 */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) return [];
  const dumps = dumpsIn(dir).map(file => {
    const meta = readMetadata(file);
    return { file, label: meta?.label ?? basename(file), at: Date.parse(meta?.createdAt ?? '') || statSync(file).mtimeMs };
  }).sort((a, b) => b.at - a.at);
  const newestPerLabel = new Set<string>();
  const removed: string[] = [];
  dumps.forEach((dump, index) => {
    const newest = !newestPerLabel.has(dump.label);
    newestPerLabel.add(dump.label);
    if (index < keep || newest) return;
    rmSync(dump.file, { force: true });
    rmSync(`${dump.file}.json`, { force: true });
    removed.push(dump.file);
  });
  return removed;
}

export function backupKeep(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env['MAGNUS_BACKUP_KEEP'] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : 5;
}

/**
 * `pg_dump -Fc` into the backup directory (0700 directory, 0600 dump).
 * Refuses when pg_dump is older than the server, which would produce an
 * unusable or partial dump. The password goes through PGPASSWORD, never argv,
 * and the dump is read back with `pg_restore --list` before it counts.
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
    throw new Error(`${pgDump} is PostgreSQL ${clientMajor} but the server is PostgreSQL ${serverMajor}; install the PostgreSQL ${serverMajor} client and set MAGNUS_PG_DUMP to it (on Debian and Ubuntu: /usr/lib/postgresql/${serverMajor}/bin/pg_dump).`);
  }

  mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
  const now = options.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = join(options.backupDir, `${stamp}-${options.label.replace(/[^A-Za-z0-9._-]+/g, '_')}.dump`);
  const { url, env } = splitPassword(options.databaseUrl);
  const result = await run(pgDump, ['--format=custom', '--no-owner', '--file', file, '--dbname', url], { capture: true, env: { ...process.env, ...env } });
  if (result.code !== 0) {
    rmSync(file, { force: true });
    throw new Error(`pg_dump failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
  }
  if (!existsSync(file) || statSync(file).size === 0) throw new Error(`pg_dump wrote no data to ${file}`);
  chmodSync(file, 0o600);
  const listed = await run(pgRestoreFor(options.pgDump), ['--list', file], { capture: true }).catch(() => null);
  if (listed && listed.code !== 0) {
    rmSync(file, { force: true });
    throw new Error(`the dump ${file} is not readable by pg_restore: ${(listed.stderr || listed.stdout).trim().split('\n').slice(-2).join(' ')}`);
  }
  const metadataFile = `${file}.json`;
  const restore = restoreCommand(file);
  writeFileSync(metadataFile, `${JSON.stringify({
    createdAt: now.toISOString(),
    label: options.label,
    postgresMajor: serverMajor,
    pgDumpMajor: clientMajor,
    lastApplied: options.lastApplied ?? null,
    verified: listed !== null,
    restoreCommand: restore,
  }, null, 2)}\n`, { mode: 0o600 });
  if (options.keep) pruneBackups(options.backupDir, options.keep);
  return { file, metadataFile, restoreCommand: restore };
}

export interface RestoreOptions {
  databaseUrl: string;
  file: string;
  client: pg.Client;
  pgRestore?: string;
  run?: CommandRunner;
  now?: Date;
  log?: (line: string) => void;
}

/**
 * Restore a dump into an empty `public` schema (see restoreSwapSql). The
 * services must be stopped. On failure the original schema is put back.
 */
export async function restoreDatabase(options: RestoreOptions): Promise<void> {
  const run = options.run ?? runCommand;
  const log = options.log ?? (() => undefined);
  const pgRestore = options.pgRestore ?? 'pg_restore';
  if (!existsSync(options.file)) throw new Error(`${options.file} does not exist`);
  const listed = await run(pgRestore, ['--list', options.file], { capture: true }).catch((error: unknown) => {
    throw new Error(`${pgRestore} could not be started (install the PostgreSQL client tools or set MAGNUS_PG_DUMP): ${error instanceof Error ? error.message : String(error)}`);
  });
  if (listed.code !== 0) throw new Error(`${options.file} is not a readable dump: ${(listed.stderr || listed.stdout).trim().split('\n').slice(-2).join(' ')}`);
  const aside = restoreAsideSchema(options.now ?? new Date());
  await options.client.query(restoreSwapSql(aside));
  log(`  moved the current schema aside as ${aside}`);
  const { url, env } = splitPassword(options.databaseUrl);
  const result = await run(pgRestore, ['--single-transaction', '--exit-on-error', '--no-owner', '--dbname', url, options.file],
    { capture: true, env: { ...process.env, ...env } });
  if (result.code !== 0) {
    await options.client.query(restoreRevertSql(aside)).catch((error: unknown) => {
      throw new Error(`pg_restore failed and putting the original schema back failed too; it is kept as ${aside}: ${error instanceof Error ? error.message : String(error)}`);
    });
    throw new Error(`pg_restore failed (exit ${result.code}); the database is unchanged: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
  }
  await options.client.query(restoreFinishSql(aside));
}
