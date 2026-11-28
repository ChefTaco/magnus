/** `magnus backups [prune] [--dry-run]`: list the dumps in backups/ and prune them by the project's retention. */
import { planBackupPrune, pruneBackups, rollbackDumps, type BackupRetention } from './database.js';
import type { Io } from './io.js';
import { acquireLock, Project } from './project.js';
import { requirePrivileges, UpgradeError } from './upgrade.js';

export interface BackupsOptions {
  dir: string;
  /** Delete the dumps the retention does not keep (otherwise only list them). */
  prune: boolean;
  /** With `prune`: say what would go, delete nothing. */
  dryRun: boolean;
  /** Override magnus-project.json `keepBackups` for this run. */
  keep?: number;
  /** Override magnus-project.json `keepBackupDays` for this run. */
  keepDays?: number;
  json: boolean;
  breakLock?: boolean;
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.ceil(bytes / 1024)} KiB`;
}

export async function backups(io: Io, options: BackupsOptions): Promise<number> {
  const project = Project.load(options.dir);
  const retention: BackupRetention = { keep: options.keep ?? project.keepBackups(), keepDays: options.keepDays ?? project.keepBackupDays() };
  if (!Number.isInteger(retention.keep) || retention.keep < 1) throw new UpgradeError('--keep must be a whole number of at least 1');
  if (!Number.isFinite(retention.keepDays) || retention.keepDays < 0) throw new UpgradeError('--keep-days must be a number of days, 0 or more');
  const dir = project.path('backups');
  const deleting = options.prune && !options.dryRun;
  if (deleting) requirePrivileges(io, project);
  // Deleting takes the upgrade lock so a prune never races an upgrade's own dump; listing does not.
  const release = deleting ? acquireLock(project.path('run', 'upgrade.lock'), { breakLock: options.breakLock, command: 'magnus backups prune' }) : null;
  try {
    const now = io.now().getTime();
    const protect = rollbackDumps(project);
    const plan = planBackupPrune(dir, retention, protect, now);
    const removed = deleting ? pruneBackups(dir, retention, protect, { now }) : plan.remove.map((dump) => dump.file);
    const freed = plan.remove.reduce((sum, dump) => sum + dump.bytes, 0);
    if (options.json) {
      io.log(JSON.stringify({
        dir, retention, dryRun: !deleting,
        keep: plan.keep.map(({ file, at, bytes, label, good, reasons }) => ({ file, createdAt: new Date(at).toISOString(), bytes, label, good, reasons })),
        remove: plan.remove.map(({ file, at, bytes, label, good }) => ({ file, createdAt: new Date(at).toISOString(), bytes, label, good })),
        ...(deleting ? { removed } : {}),
      }, null, 2));
      return 0;
    }
    if (plan.keep.length + plan.remove.length === 0) {
      io.log(`No dumps in ${dir}.`);
      return 0;
    }
    io.log(`Dumps in ${dir} (keep the newest ${retention.keep}${retention.keepDays > 0 ? ` and any younger than ${retention.keepDays} day(s)` : ''}):`);
    const rows = [...plan.keep.map((dump) => ({ ...dump, mark: `keep (${dump.reasons.join(', ')})` })),
      ...plan.remove.map((dump) => ({ ...dump, mark: deleting ? 'removed' : options.prune ? 'would remove' : 'prunable' }))]
      .sort((a, b) => b.at - a.at);
    for (const row of rows) {
      io.log(`  ${new Date(row.at).toISOString()}  ${size(row.bytes).padStart(9)}  ${row.good ? '' : '[unverified] '}${row.label ?? row.file}  ${row.mark}`);
    }
    if (!plan.remove.length) io.log('Nothing to prune.');
    else if (deleting) io.log(`Removed ${removed.length} dump(s), ${size(freed)}.`);
    else io.log(`${plan.remove.length} dump(s), ${size(freed)}, ${options.prune ? 'would be removed (dry run; nothing deleted)' : 'can go'}: \`magnus backups prune --dir ${project.dir}\`${options.prune ? '' : ' (add --dry-run to check first)'}.`);
    return 0;
  } finally {
    release?.();
  }
}
