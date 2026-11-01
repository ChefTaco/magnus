/** `magnus rollback`: switch back to the version that served before the last upgrade. */
import { restoreDatabase } from './database.js';
import { waitForHealthy } from './health.js';
import { isInstalled } from './install.js';
import type { Io } from './io.js';
import { acquireLock, Project } from './project.js';
import { restartServices, stopServices } from './supervisor.js';
import { requirePrivileges, UpgradeError } from './upgrade.js';

export interface RollbackOptions {
  dir: string;
  restoreDb: boolean;
  yes: boolean;
  healthTimeoutMs: number;
}

export async function rollback(io: Io, options: RollbackOptions): Promise<number> {
  const project = Project.load(options.dir);
  requirePrivileges(io, project);
  const release = acquireLock(project.path('run', 'upgrade.lock'));
  try {
    const current = project.state.current;
    const previous = project.state.previous;
    if (!current || !previous) throw new UpgradeError('Nothing to roll back to: no previous version is recorded.');
    if (!isInstalled(project, previous)) throw new UpgradeError(`versions/${previous} has been removed, so there is nothing to switch back to. Restore from a backup in ${project.path('backups')} instead.`);
    const upgradeEntry = project.state.history.findLast((entry) => entry.action === 'upgrade' && entry.to === current && entry.result === 'ok');
    const migrations = upgradeEntry?.migrations ?? [];

    let restore = false;
    if (migrations.length > 0) {
      io.warn(`${current} applied ${migrations.length} migration(s) that ${previous} does not know: ${migrations.join(', ')}.`);
      if (options.restoreDb && upgradeEntry?.backup) {
        restore = options.yes || await io.confirm(`Restore the database from ${upgradeEntry.backup}? Changes made since the upgrade are lost`);
        if (!restore) throw new UpgradeError('Stopped: the restore was not confirmed (pass --yes to confirm non-interactively).');
      } else if (upgradeEntry?.backup) {
        io.warn(`${previous} usually works with the newer schema. If it does not, re-run with --restore-db, or restore by hand:\n  ${upgradeEntry.restoreCommand ?? ''}`);
      }
    }

    if (restore && upgradeEntry?.backup) {
      io.log('  stopping services for the restore');
      await stopServices(io, project);
      await restoreDatabase(io, project, upgradeEntry.backup);
      io.log(`  restored ${upgradeEntry.backup}`);
    }
    const restartedAt = io.now();
    project.switchCurrent(previous);
    project.state.current = previous;
    project.state.previous = null;
    project.save();
    io.log(`  switched ./current to ${previous}; restarting`);
    await restartServices(io, project);
    const health = await waitForHealthy(io, project, { version: previous, startedAfter: restartedAt, timeoutMs: options.healthTimeoutMs });
    project.record({ action: 'rollback', from: current, to: previous, at: io.now().toISOString(), result: health.ok ? 'ok' : 'failed',
      migrations: [], ...(health.ok ? {} : { reason: health.detail }) });
    project.save();
    if (!health.ok) {
      io.warn(`Rolled back to ${previous}, but it is ${health.detail}.`);
      return 1;
    }
    io.log(`Rolled back from ${current} to ${previous}: ${health.detail}.`);
    return 0;
  } finally {
    release();
  }
}
