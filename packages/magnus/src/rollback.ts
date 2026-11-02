/**
 * `magnus rollback`: switch back to the version that served before the last
 * upgrade (or before an interrupted one), optionally restoring its dump.
 */
import { newestDumpBefore, restoreCommandFor, restoreDatabase } from './database.js';
import { waitForHealthy } from './health.js';
import { isInstalled, migrationReport } from './install.js';
import type { Io } from './io.js';
import { acquireLock, Project } from './project.js';
import { restartServices, stopServices } from './supervisor.js';
import { knownOneWay, requirePrivileges, UpgradeError } from './upgrade.js';

export interface RollbackOptions {
  dir: string;
  restoreDb: boolean;
  yes: boolean;
  healthTimeoutMs: number;
  /** Start the previous version even when the database has one-way migrations it does not know. */
  force?: boolean;
  breakLock?: boolean;
}

/** Stop, restore; on failure start the services again on the untouched database. */
export async function stopAndRestore(io: Io, project: Project, file: string, yes: boolean): Promise<void> {
  io.log('  stopping services for the restore');
  await stopServices(io, project, { confirm: project.state.supervisor === 'none' && !yes });
  try {
    await restoreDatabase(io, project, file);
  } catch (error) {
    const restartedAt = io.now();
    const restarted = await restartServices(io, project).then(() => waitForHealthy(io, project, {
      version: project.linkedVersion() ?? project.state.current ?? '', startedAfter: restartedAt, timeoutMs: 120_000,
    })).catch((restartError: unknown) => ({ ok: false, detail: restartError instanceof Error ? restartError.message : String(restartError) }));
    throw new UpgradeError([
      `The restore of ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
      `The services were started again on the unchanged database (${restarted.ok ? 'healthy' : restarted.detail}).`,
      `Check the dump with \`pg_restore --list ${file}\`, then retry: ${restoreCommandFor(project, file)}`,
    ].join('\n'));
  }
  io.log(`  restored ${file}`);
}

export async function rollback(io: Io, options: RollbackOptions): Promise<number> {
  const project = Project.load(options.dir);
  requirePrivileges(io, project);
  const release = acquireLock(project.path('run', 'upgrade.lock'), { breakLock: options.breakLock, command: 'magnus rollback' });
  try {
    const journal = project.state.inProgress;
    const current = journal ? (project.linkedVersion() ?? project.state.current) : project.state.current;
    const previous = journal ? journal.from : project.state.previous;
    if (!current || !previous) throw new UpgradeError('Nothing to roll back to: no previous version is recorded.');
    if (!isInstalled(project, previous)) throw new UpgradeError(`versions/${previous} has been removed, so there is nothing to switch back to. Restore from a backup in ${project.path('backups')} instead.`);
    if (journal) io.log(`Rolling back the interrupted upgrade ${journal.from} -> ${journal.to} (stopped during "${journal.phase}")`);
    const upgradeEntry = journal ? undefined
      : project.state.history.findLast((entry) => entry.action === 'upgrade' && entry.to === current && entry.result === 'ok');

    // What the database has that `previous` does not know, asked of `previous` itself.
    const report = await migrationReport(io, project, previous).catch(() => null);
    const recorded = journal?.migrations ?? upgradeEntry?.migrations ?? [];
    const ahead = report ? report.unknown.map((m) => m.name) : recorded;
    const oneWay = knownOneWay(project);
    for (const name of journal?.oneWay ?? []) oneWay.add(name);
    const aheadOneWay = ahead.filter((name) => oneWay.has(name));
    const firstAhead = report?.unknown.map((m) => m.appliedAt).filter((at): at is string => Boolean(at)).sort()[0] ?? null;
    const dump = journal?.backup ?? upgradeEntry?.backup ?? (ahead.length ? newestDumpBefore(project, firstAhead) : null);

    let restore = false;
    if (options.restoreDb) {
      if (!dump) {
        throw new UpgradeError(`--restore-db cannot be honoured: no dump is recorded for this upgrade${ahead.length ? '' : ' (it applied no migrations)'}. `
          + `Restore one from ${project.path('backups')} with \`magnus restore <file> --dir ${project.dir}\`, or roll back without --restore-db.`);
      }
      restore = options.yes || await io.confirm(`Restore the database from ${dump}? Changes made since then are lost`);
      if (!restore) throw new UpgradeError('Stopped: the restore was not confirmed (pass --yes to confirm non-interactively).');
    } else if (ahead.length > 0) {
      io.warn(`The database has ${ahead.length} migration(s) that ${previous} does not know: ${ahead.join(', ')}.`);
      if (aheadOneWay.length > 0 && !options.force) {
        throw new UpgradeError([
          `${aheadOneWay.join(', ')} ${aheadOneWay.length === 1 ? 'is' : 'are'} one-way: ${previous} cannot run on that schema.`,
          dump ? `Roll back with the dump: magnus rollback --restore-db --dir ${project.dir}   (restores ${dump})` : `Restore a dump from ${project.path('backups')} with \`magnus restore <file>\`.`,
          'Or start it anyway with --force.',
        ].join('\n'));
      }
      if (dump) io.warn(`${previous} usually works with the newer schema. If it does not, re-run with --restore-db, or restore by hand:\n  ${restoreCommandFor(project, dump)}`);
    }

    if (restore && dump) await stopAndRestore(io, project, dump, options.yes);
    const restartedAt = io.now();
    if (project.linkedVersion() !== previous) project.switchCurrent(previous);
    project.state.current = previous;
    project.state.previous = journal ? project.state.history.findLast((entry) => entry.to === previous && entry.result === 'ok')?.from ?? null : null;
    delete project.state.inProgress;
    project.save();
    io.log(`  switched ./current to ${previous}; restarting`);
    let health;
    try {
      await restartServices(io, project);
      health = await waitForHealthy(io, project, { version: previous, startedAfter: restartedAt, timeoutMs: options.healthTimeoutMs });
    } catch (error) {
      health = { ok: false, detail: `the restart failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    project.record({ action: 'rollback', from: current, to: previous, at: io.now().toISOString(), result: health.ok ? 'ok' : 'failed',
      migrations: [], ...(restore && dump ? { backup: dump } : {}), ...(health.ok ? {} : { reason: health.detail }) });
    project.save();
    if (!health.ok) {
      io.warn(`Rolled back to ${previous}, but it is ${health.detail}.${dump && !restore ? ` If the newer schema is the cause: ${restoreCommandFor(project, dump)}` : ''}`);
      return 1;
    }
    io.log(`Rolled back from ${current} to ${previous}: ${health.detail}.`);
    return 0;
  } finally {
    release();
  }
}
