/** Pre-migration dumps and restores for both database kinds a project can use. */
import { closeSync, chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compareVersions, restoreAsideSchema, restoreFinishSql, restoreRevertSql, restoreSwapSql } from '@hivemagnus/magnus-contracts';
import { readEnvFile } from './env-file.js';
import { mustRun, type Io } from './io.js';
import type { Project } from './project.js';
import { isInstalled, serverCli } from './install.js';

export interface Backup {
  file: string;
  restoreCommand: string;
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+,=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function composeArgs(project: Project): string[] {
  const db = project.state.database;
  if (db.kind !== 'compose') throw new Error('not a compose database');
  return ['compose', '-p', project.composeProject(), '-f', project.path(db.composeFile), '--env-file', project.path('config', 'deps.env')];
}

/** What to run to restore a dump: stops the services, restores into a clean schema, starts them again. */
export function restoreCommandFor(project: Project, file: string): string {
  return `magnus restore ${shellQuote(file)} --dir ${shellQuote(project.dir)}`;
}

/** First server release with `magnus-server restore` (and the clean-schema restore). */
export const SERVER_RESTORE_SINCE = '1.1.3';

/** Compose databases: psql in the container. */
async function composePsql(io: Io, project: Project, sql: string): Promise<void> {
  const db = project.state.database;
  if (db.kind !== 'compose') throw new Error('not a compose database');
  await mustRun(io, 'docker', [...composeArgs(project), 'exec', '-T', db.service, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', db.user, '-d', db.database, '-c', sql], { capture: true });
}

async function composeRun(io: Io, project: Project, args: string[], options: { stdinFd?: number; stdoutFd?: number; capture?: boolean } = {}) {
  const db = project.state.database;
  if (db.kind !== 'compose') throw new Error('not a compose database');
  return mustRun(io, 'docker', [...composeArgs(project), 'exec', '-T', db.service, ...args], options);
}

/** Bytes the database occupies (an upper bound for its dump), or null when it cannot be asked. */
export async function databaseBytes(io: Io, project: Project): Promise<number | null> {
  const db = project.state.database;
  if (db.kind !== 'compose') return null;
  const result = await composeRun(io, project, ['psql', '-tA', '-U', db.user, '-d', db.database, '-c', 'SELECT pg_database_size(current_database())'], { capture: true })
    .catch(() => null);
  const bytes = Number(result?.stdout.trim());
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/**
 * Keep the newest `keep` dumps in backups/; older ones go, except the newest
 * dump of each label (the one a rollback of that step restores) and any file
 * in `protect`.
 */
export function pruneBackups(dir: string, keep: number, protect: readonly string[] = []): string[] {
  if (!existsSync(dir) || keep < 1) return [];
  const dumps = readdirSync(dir).filter((name) => name.endsWith('.dump')).map((name) => {
    const file = join(dir, name);
    let meta: { label?: string; createdAt?: string } = {};
    try { meta = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as typeof meta; } catch { /* no metadata */ }
    return { file, label: meta.label ?? basename(file), at: Date.parse(meta.createdAt ?? '') || statSync(file).mtimeMs };
  }).sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const removed: string[] = [];
  dumps.forEach((dump, index) => {
    const newest = !seen.has(dump.label);
    seen.add(dump.label);
    if (index < keep || newest || protect.includes(dump.file)) return;
    rmSync(dump.file, { force: true });
    rmSync(`${dump.file}.json`, { force: true });
    removed.push(dump.file);
  });
  return removed;
}

/**
 * Dump before migrating. Compose databases are dumped with the container's own
 * pg_dump (always the server's version); external ones through the target
 * server's `magnus-server backup`, which checks the pg_dump version. Either
 * dump is read back with `pg_restore --list` before it counts.
 */
export async function backupDatabase(io: Io, project: Project, version: string, label: string): Promise<Backup> {
  const db = project.state.database;
  if (db.kind === 'external') {
    const { stdout } = await serverCli(io, project, version, ['backup', '--label', label], { capture: true });
    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { file?: string };
    if (!result.file) throw new Error('magnus-server backup did not report a dump file');
    return { file: result.file, restoreCommand: restoreCommandFor(project, result.file) };
  }
  const dir = project.path('backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${io.now().toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^A-Za-z0-9._-]+/g, '_')}.dump`);
  const fd = openSync(file, 'w', 0o600);
  try {
    await composeRun(io, project, ['pg_dump', '--format=custom', '--no-owner', '-U', db.user, '-d', db.database], { stdoutFd: fd });
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
  if (!existsSync(file) || statSync(file).size === 0) {
    rmSync(file, { force: true });
    throw new Error(`pg_dump wrote nothing to ${file}`);
  }
  chmodSync(file, 0o600);
  const input = openSync(file, 'r');
  try {
    await composeRun(io, project, ['pg_restore', '--list'], { stdinFd: input, capture: true });
  } catch (error) {
    rmSync(file, { force: true });
    throw new Error(`the dump ${file} is not readable by pg_restore: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    closeSync(input);
  }
  const restoreCommand = restoreCommandFor(project, file);
  writeFileSync(`${file}.json`, `${JSON.stringify({ createdAt: io.now().toISOString(), label, restoreCommand }, null, 2)}\n`, { mode: 0o600 });
  pruneBackups(dir, project.keepBackups(), [file]);
  return { file, restoreCommand };
}

/** Newest installed version whose server CLI can restore (1.1.3+). */
function restoringVersion(project: Project, compare = compareVersions): string | null {
  const dir = project.path('versions');
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir).filter((name) => /^\d+\.\d+\.\d+$/.test(name) && isInstalled(project, name)
    && compare(name, SERVER_RESTORE_SINCE) >= 0).sort(compare);
  return versions.at(-1) ?? null;
}

/**
 * Restore a dump into a clean schema (see restoreSwapSql in
 * @hivemagnus/magnus-contracts). The services must be stopped first.
 */
export async function restoreDatabase(io: Io, project: Project, file: string): Promise<void> {
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const db = project.state.database;
  const aside = restoreAsideSchema(io.now());
  if (db.kind === 'compose') {
    const check = openSync(file, 'r');
    try {
      await composeRun(io, project, ['pg_restore', '--list'], { stdinFd: check, capture: true });
    } catch (error) {
      throw new Error(`${file} is not a readable dump: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      closeSync(check);
    }
    await composePsql(io, project, restoreSwapSql(aside));
    const fd = openSync(file, 'r');
    try {
      await composeRun(io, project, ['pg_restore', '--single-transaction', '--exit-on-error', '--no-owner', '-U', db.user, '-d', db.database], { stdinFd: fd, capture: true });
    } catch (error) {
      await composePsql(io, project, restoreRevertSql(aside)).catch(() => {
        throw new Error(`pg_restore failed and the original schema could not be put back; it is kept as ${aside}. ${error instanceof Error ? error.message : String(error)}`);
      });
      throw new Error(`pg_restore failed; the database is unchanged. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      closeSync(fd);
    }
    await composePsql(io, project, restoreFinishSql(aside));
    return;
  }
  const version = restoringVersion(project);
  if (version) {
    await serverCli(io, project, version, ['restore', file, '--yes']);
    return;
  }
  // Only servers before 1.1.3 are installed: the same steps with the host's client tools
  // (next to MAGNUS_PG_DUMP, so pg_restore is as new as the pg_dump that wrote the file).
  const serverEnv = readEnvFile(project.envFile('server'));
  const url = new URL(serverEnv['MAGNUS_MIGRATE_DATABASE_URL'] ?? serverEnv['DATABASE_URL'] ?? '');
  const password = decodeURIComponent(url.password);
  url.password = '';
  const env = { ...io.env, ...(password ? { PGPASSWORD: password } : {}) };
  const pgDump = serverEnv['MAGNUS_PG_DUMP'] ?? io.env['MAGNUS_PG_DUMP'];
  const tool = (name: string) => (pgDump?.includes('/') ? join(dirname(pgDump), name) : name);
  await mustRun(io, tool('pg_restore'), ['--list', file], { capture: true, env });
  const psql = (sql: string) => mustRun(io, tool('psql'), ['-v', 'ON_ERROR_STOP=1', '-q', '-d', url.toString(), '-c', sql], { capture: true, env });
  await psql(restoreSwapSql(aside));
  try {
    await mustRun(io, tool('pg_restore'), ['--single-transaction', '--exit-on-error', '--no-owner', '-d', url.toString(), file], { capture: true, env });
  } catch (error) {
    await psql(restoreRevertSql(aside)).catch(() => {
      throw new Error(`pg_restore failed and the original schema could not be put back; it is kept as ${aside}.`);
    });
    throw new Error(`pg_restore failed; the database is unchanged. ${error instanceof Error ? error.message : String(error)}`);
  }
  await psql(restoreFinishSql(aside));
}

/**
 * Newest dump taken before `before` (the first migration this version does
 * not know was applied then), for restore guidance when history has none.
 */
export function newestDumpBefore(project: Project, before: string | null): string | null {
  const dir = project.path('backups');
  if (!existsSync(dir)) return null;
  const limit = before ? Date.parse(before) : Number.POSITIVE_INFINITY;
  let best: { file: string; at: number } | null = null;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.dump'))) {
    const file = join(dir, name);
    let at = statSync(file).mtimeMs;
    try { at = Date.parse((JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { createdAt: string }).createdAt) || at; } catch { /* mtime */ }
    if (at <= limit && (!best || at > best.at)) best = { file, at };
  }
  return best?.file ?? null;
}
