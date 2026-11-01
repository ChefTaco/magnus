/** Pre-migration dumps and restores for both database kinds a project can use. */
import { closeSync, chmodSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile } from './env-file.js';
import { mustRun, type Io } from './io.js';
import type { Project } from './project.js';
import { serverCli } from './install.js';

export interface Backup {
  file: string;
  restoreCommand: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function composeArgs(project: Project): string[] {
  const db = project.state.database;
  if (db.kind !== 'compose') throw new Error('not a compose database');
  return ['compose', '-f', project.path(db.composeFile), '--env-file', project.path('config', 'deps.env')];
}

export function restoreCommandFor(project: Project, file: string): string {
  const db = project.state.database;
  if (db.kind === 'compose') {
    return `docker ${composeArgs(project).map(shellQuote).join(' ')} exec -T ${db.service} pg_restore --clean --if-exists --no-owner -U ${db.user} -d ${db.database} < ${shellQuote(file)}`;
  }
  return `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" ${shellQuote(file)}`;
}

/**
 * Dump before migrating. Compose databases are dumped with the container's own
 * pg_dump (always the server's version); external ones through the target
 * server's `magnus-server backup`, which checks the pg_dump version.
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
    await mustRun(io, 'docker', [...composeArgs(project), 'exec', '-T', db.service, 'pg_dump', '--format=custom', '--no-owner', '-U', db.user, '-d', db.database],
      { stdoutFd: fd, capture: false });
  } finally {
    closeSync(fd);
  }
  if (statSync(file).size === 0) throw new Error(`pg_dump wrote nothing to ${file}`);
  chmodSync(file, 0o600);
  const restoreCommand = restoreCommandFor(project, file);
  writeFileSync(`${file}.json`, `${JSON.stringify({ createdAt: io.now().toISOString(), label, restoreCommand }, null, 2)}\n`, { mode: 0o600 });
  return { file, restoreCommand };
}

/** Restore a dump. The services must be stopped first. */
export async function restoreDatabase(io: Io, project: Project, file: string): Promise<void> {
  const db = project.state.database;
  if (db.kind === 'compose') {
    const fd = openSync(file, 'r');
    try {
      await mustRun(io, 'docker', [...composeArgs(project), 'exec', '-T', db.service, 'pg_restore', '--clean', '--if-exists', '--no-owner', '-U', db.user, '-d', db.database],
        { stdinFd: fd });
    } finally {
      closeSync(fd);
    }
    return;
  }
  const url = new URL(readEnvFile(project.envFile('server'))['DATABASE_URL'] ?? '');
  // Keep the password out of the process list.
  const password = decodeURIComponent(url.password);
  url.password = '';
  await mustRun(io, 'pg_restore', ['--clean', '--if-exists', '--no-owner', '-d', url.toString(), file],
    { env: { ...io.env, ...(password ? { PGPASSWORD: password } : {}) } });
}
