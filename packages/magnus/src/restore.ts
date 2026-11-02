/** `magnus restore <dump>`: stop the services, restore the dump into a clean schema, start them again. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForHealthy } from './health.js';
import type { Io } from './io.js';
import { acquireLock, Project } from './project.js';
import { stopAndRestore } from './rollback.js';
import { restartServices } from './supervisor.js';
import { requirePrivileges, UpgradeError } from './upgrade.js';

export interface RestoreOptions {
  dir: string;
  file: string;
  yes: boolean;
  healthTimeoutMs: number;
  breakLock?: boolean;
}

/** The version a dump was taken from, when its label says so (pre-upgrade-A-to-B, pre-migrate-B). */
export function dumpVersion(file: string): string | null {
  let label = '';
  try { label = (JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { label?: string }).label ?? ''; } catch { label = file; }
  return /pre-upgrade-(\d+\.\d+\.\d+)-to-/.exec(label)?.[1] ?? null;
}

export async function restore(io: Io, options: RestoreOptions): Promise<number> {
  const project = Project.load(options.dir);
  requirePrivileges(io, project);
  const file = resolve(options.file);
  if (!existsSync(file)) throw new UpgradeError(`${file} does not exist`);
  const release = acquireLock(project.path('run', 'upgrade.lock'), { breakLock: options.breakLock, command: 'magnus restore' });
  try {
    const current = project.linkedVersion() ?? project.state.current;
    if (!current) throw new UpgradeError(`${project.dir} has no serving version.`);
    const from = dumpVersion(file);
    if (from && from !== current) {
      io.warn(`${file} was taken while ${from} was serving, but ./current is ${current}. Roll back first (\`magnus rollback --restore-db\`) unless you know ${current} runs on it.`);
    }
    if (!options.yes && !await io.confirm(`Replace the database with ${file} and restart ${current}? Changes made since the dump are lost`)) {
      throw new UpgradeError('Stopped: the restore was not confirmed (pass --yes to confirm non-interactively).');
    }
    await stopAndRestore(io, project, file, options.yes);
    const restartedAt = io.now();
    await restartServices(io, project);
    const health = await waitForHealthy(io, project, { version: current, startedAfter: restartedAt, timeoutMs: options.healthTimeoutMs });
    project.record({ action: 'restore', from: current, to: current, at: io.now().toISOString(), result: health.ok ? 'ok' : 'failed', migrations: [], backup: file,
      ...(health.ok ? {} : { reason: health.detail }) });
    project.save();
    if (!health.ok) {
      io.warn(`Restored ${file}, but ${current} is ${health.detail}.`);
      return 1;
    }
    io.log(`Restored ${file}; ${health.detail}.`);
    return 0;
  } finally {
    release();
  }
}
