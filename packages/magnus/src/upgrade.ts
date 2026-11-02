/**
 * `magnus upgrade`: install the target release next to the serving one,
 * check it, back up, migrate, switch `current`, restart and wait for health.
 * A release that fails its health check is switched back automatically, and
 * the restore command for the pre-migration dump is printed.
 *
 * From the backup on, magnus-project.json carries an in-progress journal, so
 * an upgrade that was killed (or lost its terminal) is noticed by the next
 * command, which offers `upgrade --resume` or `rollback`. SIGINT, SIGHUP and
 * SIGTERM stop the upgrade at the next safe point; a running migration
 * always finishes first.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import {
  checkUpgradeAllowed,
  compareVersions,
  satisfiesRange,
  summarizeUpgradePath,
  type ReleaseEnvChange,
  type UpgradePath,
} from '@hivemagnus/magnus-contracts';
import { backupDatabase, databaseBytes, pruneBackups, restoreCommandFor, type Backup } from './database.js';
import { appendMissing, generateSecret, readEnvFile } from './env-file.js';
import { waitForHealthy, type HealthResult } from './health.js';
import {
  installVersion, isInstalled, migrationReport, nodeVersionOf, npmFor, publishPins, pruneVersions, removeStaleStaging, serverCli, smokeTest,
  type PendingMigration,
} from './install.js';
import type { Io } from './io.js';
import { acquireLock, ownerOf, Project, type Component, type HistoryEntry, type Lock, type UpgradeJournal } from './project.js';
import { ENGINE_PROTOCOL, fetchRegistryCatalog, newerMajor, pickTarget, releaseFor, sourceCatalog, TooOldError, type ReleaseCatalog } from './release.js';
import { checkSupervisor, manualRestartHint, refreshUnits, restartServices, stopServices } from './supervisor.js';
import { projectEnv } from './templates.js';

export interface UpgradeOptions {
  dir: string;
  to?: string;
  dryRun: boolean;
  allowMajor: boolean;
  yes: boolean;
  generateSecrets: boolean;
  source?: string;
  registry: string;
  healthTimeoutMs: number;
  /**
   * Finish an upgrade the journal says was interrupted; also set when an
   * older engine hands a release it installed to this (newer) engine.
   */
  resume: boolean;
  /** Start the previous version after a failed upgrade even over one-way migrations. */
  force?: boolean;
  breakLock?: boolean;
  /** Switch the Node.js the services run (and the upgrade uses); the units are rewritten. */
  nodePath?: string;
}

export class UpgradeError extends Error {}
export class InterruptedError extends UpgradeError {}

/** Free space an npm install of one release needs. */
export const INSTALL_BYTES = 1024 ** 3;

export async function loadCatalog(io: Io, options: Pick<UpgradeOptions, 'source' | 'registry'>): Promise<ReleaseCatalog> {
  return options.source ? sourceCatalog(io, options.source, options.registry) : fetchRegistryCatalog(io, options.registry);
}

export function requirePrivileges(io: Io, project: Project): void {
  if (project.state.supervisor === 'systemd' && project.state.scope === 'system') {
    if (!io.isRoot) throw new UpgradeError(`This project runs system services; run the command as root (sudo magnus … --dir ${project.dir}).`);
    return;
  }
  // User units belong to the account that owns the project; root (sudo) has no session bus for them and would leave root-owned files.
  const owner = ownerOf(Project.file(project.dir));
  if (io.uid !== null && owner !== null && io.uid !== owner) {
    throw new UpgradeError(`${project.dir} belongs to uid ${owner}, but this is uid ${io.uid}. Run magnus as the account that owns the project (without sudo).`);
  }
}

/** New required variables that the project's env files do not set yet. */
export function missingEnv(project: Project, required: readonly ReleaseEnvChange[]): ReleaseEnvChange[] {
  const files = new Map<Component, Record<string, string>>();
  return required.filter((env) => {
    if (env.component !== 'server' && env.component !== 'ui') return false;
    if (!project.state.components.includes(env.component)) return false;
    if (!files.has(env.component)) files.set(env.component, readEnvFile(project.envFile(env.component)));
    return files.get(env.component)?.[env.name] === undefined;
  });
}

function describePath(io: Io, path: UpgradePath, kind: string): void {
  io.log(`Upgrade ${path.from} -> ${path.to} (${kind}${path.breaking ? ', contains breaking changes: read the release notes' : ''})`);
  for (const release of path.releases) {
    io.log(`  ${release.version}${release.summary ? `: ${release.summary}` : ''}${release.notesUrl ? `\n    notes: ${release.notesUrl}` : ''}`);
  }
  if (path.newRequiredEnv.length) {
    io.log('  New required settings:');
    for (const env of path.newRequiredEnv) io.log(`    ${env.name} (${env.component}${env.secret ? ', secret' : ''}): ${env.description}`);
  }
  if (path.newOptionalEnv.length) {
    io.log(`  New optional settings (their defaults keep working; see the release notes): ${path.newOptionalEnv.map((env) => env.name).join(', ')}`);
  }
  for (const env of path.removedEnv) io.log(`  Removed setting ${env.name} (${env.component})${env.note ? `: ${env.note}` : ''}`);
  if (path.migrations.length) {
    io.log(`  Database migrations: ${path.migrations.map((m) => `${m.name} [${m.impact}]`).join(', ')}`);
  }
  for (const migration of path.attention) {
    io.warn(`  ! ${migration.name} is ${migration.impact === 'slow' ? 'SLOW' : 'ONE-WAY (rollback needs the database restore)'}${migration.note ? `: ${migration.note}` : ''}`);
  }
}

async function confirmAttention(io: Io, migrations: readonly PendingMigration[], yes: boolean): Promise<void> {
  const attention = migrations.filter((m) => m.impact !== 'fast');
  if (attention.length === 0 || yes) return;
  if (!await io.confirm(`Apply ${attention.length} slow or one-way migration(s)?`)) {
    throw new UpgradeError('Stopped: slow or one-way migrations need confirmation. Re-run with --yes when you are ready (the database is backed up first).');
  }
}

function logsHint(project: Project): string {
  return project.state.supervisor === 'systemd'
    ? `journalctl ${project.state.scope === 'user' ? '--user ' : ''}-u ${project.state.units.server} -n 100`
    : 'see your service manager';
}

/** What the next command says about an interrupted upgrade. */
export function journalMessage(project: Project, journal: UpgradeJournal): string {
  const dir = project.dir;
  return [
    `An upgrade ${journal.from} -> ${journal.to} was interrupted during "${journal.phase}" (started ${journal.startedAt} by pid ${journal.pid}); ./current points at ${project.linkedVersion() ?? 'nothing'}.`,
    `  magnus upgrade --resume --dir ${dir}     finish it (runs the remaining steps again)`,
    `  magnus rollback --dir ${dir}             go back to ${journal.from}${journal.backup ? ` (add --restore-db to restore ${journal.backup})` : ''}`,
  ].join('\n');
}

interface SignalTrap {
  readonly signal: NodeJS.Signals | null;
  /** Throws InterruptedError when a signal arrived. */
  checkpoint(): void;
  /** From here on signals only print a note: the revert must finish. */
  reverting(): void;
  dispose(): void;
}

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGHUP', 'SIGTERM'];

function trapSignals(io: Io): SignalTrap {
  let received: NodeJS.Signals | null = null;
  let reverting = false;
  const handler = (signal: NodeJS.Signals) => {
    if (reverting) { io.warn(`  ${signal}: switching back, please wait`); return; }
    if (received) return;
    received = signal;
    io.warn(`  ${signal}: stopping at the next safe step (a running migration always finishes first)`);
  };
  // A closed terminal (SIGHUP) must not crash the upgrade through a failed write.
  const ignore = () => undefined;
  const handlers = SIGNALS.map((signal) => [signal, () => handler(signal)] as const);
  for (const [signal, listener] of handlers) process.on(signal, listener);
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
  return {
    get signal() { return received; },
    checkpoint() { if (received) throw new InterruptedError(`Interrupted (${received}).`); },
    reverting() { reverting = true; },
    dispose() {
      for (const [signal, listener] of handlers) process.off(signal, listener);
      process.stdout.off('error', ignore);
      process.stderr.off('error', ignore);
    },
  };
}

/** Same file system: one free-space budget. */
function sameDevice(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Free space for the npm install (and, when `dumpBytes` is given, the dump). Returns problems. */
export function diskProblems(io: Io, project: Project, needs: { install: boolean; dumpBytes: number | null }): string[] {
  const problems: string[] = [];
  const versions = existsSync(project.path('versions')) ? project.path('versions') : project.dir;
  const backups = existsSync(project.path('backups')) ? project.path('backups') : project.dir;
  const install = needs.install ? INSTALL_BYTES : 0;
  const dump = needs.dumpBytes ?? 0;
  const shared = sameDevice(versions, backups);
  const checks = shared ? [{ path: versions, bytes: install + dump, what: 'the install and the database dump' }]
    : [{ path: versions, bytes: install, what: 'the install' }, { path: backups, bytes: dump, what: 'the database dump' }];
  for (const check of checks) {
    if (check.bytes === 0) continue;
    const free = io.freeBytes(check.path);
    if (free !== null && free < check.bytes) {
      problems.push(`${check.path} has ${gib(free)} free; ${check.what} need about ${gib(check.bytes)}. Free some space (old dumps are in ${project.path('backups')}).`);
    }
  }
  return problems;
}

export async function upgrade(io: Io, options: UpgradeOptions): Promise<number> {
  const project = Project.load(options.dir);
  requirePrivileges(io, project);
  let lock: Lock | (() => void) = acquireLock(project.path('run', 'upgrade.lock'), {
    inheritToken: io.env['MAGNUS_LOCK_TOKEN'], breakLock: options.breakLock, command: 'magnus upgrade',
  });
  try {
    const journal = project.state.inProgress;
    if (journal) {
      if (!options.resume) throw new UpgradeError(journalMessage(project, journal));
      if (options.to && options.to !== journal.to) throw new UpgradeError(`The interrupted upgrade was to ${journal.to}, not ${options.to}.\n${journalMessage(project, journal)}`);
      return await resumeJournal(io, project, journal, options);
    }
    const current = project.state.current;
    if (!current) throw new UpgradeError(`${project.dir} has no serving version; run \`magnus init\` again or \`magnus adopt\`.`);
    if (options.nodePath) {
      if (!existsSync(options.nodePath)) throw new UpgradeError(`--node ${options.nodePath} does not exist`);
      project.state.nodePath = options.nodePath;
    }
    if (!options.dryRun) {
      const stale = removeStaleStaging(project);
      if (stale.length) io.log(`  removed unfinished installs: ${stale.join(', ')}`);
    }
    const catalog = await loadCatalog(io, options);
    const target = pickTarget(catalog, current, options.to);
    if (target === current) {
      if (options.nodePath && !options.dryRun) return await switchNode(io, project, current, options);
      io.log(`Already on ${current}, the newest ${current.split('.')[0]}.x release.`);
      const major = newerMajor(catalog, current);
      if (major) io.log(`${major} is available. Major upgrades are never automatic: read UPGRADING.md, then run \`magnus upgrade --to ${major} --allow-major\`.`);
      return 0;
    }
    const decision = checkUpgradeAllowed(current, target, { allowMajor: options.allowMajor });
    if (!decision.allowed) throw new UpgradeError(decision.reason ?? 'upgrade not allowed');
    let manifest;
    try {
      manifest = releaseFor(catalog, target);
    } catch (error) {
      if (error instanceof TooOldError) throw new UpgradeError(error.message);
      throw error;
    }
    const path = summarizeUpgradePath(catalog.manifests.values(), current, target);
    if (path.blockedBy) {
      const step = path.releases.find((release) => release.minUpgradeFrom && compareVersions(current, release.minUpgradeFrom) < 0)?.minUpgradeFrom;
      throw new UpgradeError(`Cannot upgrade directly: ${path.blockedBy}.${step ? ` Upgrade in two steps: magnus upgrade --to ${step}, then magnus upgrade.` : ''}`);
    }
    const nodePath = project.nodePath();
    const nodeVersion = await nodeVersionOf(io, nodePath).catch((error: unknown) => { throw new UpgradeError(error instanceof Error ? error.message : String(error)); });
    if (!satisfiesRange(nodeVersion, manifest.engines.node)) {
      throw new UpgradeError(`${target} needs Node.js ${manifest.engines.node}; the services run ${nodePath} (${nodeVersion}). Install a supported Node.js and pass --node <path>.`);
    }
    describePath(io, path, decision.kind);

    const missing = missingEnv(project, path.newRequiredEnv);
    if (missing.length) {
      const fillable = missing.every((env) => env.secret);
      if (!(options.generateSecrets && fillable)) {
        throw new UpgradeError([
          `${target} needs settings your env files do not have yet:`,
          ...missing.map((env) => `  ${env.name} in ${project.envFile(env.component as Component)}: ${env.description}`),
          fillable ? 'They are all secrets: re-run with --generate-secrets to add random values.' : 'Add them, then re-run.',
        ].join('\n'));
      }
    }

    const problems: string[] = [];
    await checkSupervisor(io, project.state.supervisor, project.state.scope).catch((error: unknown) => {
      problems.push(error instanceof Error ? error.message : String(error));
    });
    const installed = isInstalled(project, target);
    problems.push(...diskProblems(io, project, { install: !installed, dumpBytes: options.dryRun ? await estimateDump(io, project, current) : null }));
    if (options.dryRun) {
      problems.push(...await dryRunChecks(io, project, current, nodePath));
      if (problems.length) {
        io.warn(['Dry run found problems to fix before upgrading:', ...problems.map((problem) => `  - ${problem}`)].join('\n'));
        return 1;
      }
      io.log(`Dry run: would install ${target} into versions/${target}, check it, back up the database, migrate, switch ./current and restart. Prerequisites look fine; nothing changed.`);
      return 0;
    }
    if (problems.length) throw new UpgradeError(['Stopped before changing anything:', ...problems.map((problem) => `  - ${problem}`)].join('\n'));

    for (const component of ['server', 'ui'] as const) {
      const names = appendMissing(project.envFile(component), missing.filter((env) => env.component === component)
        .map((env) => ({ name: env.name, value: generateSecret(), comment: env.description })), `Added by magnus upgrade to ${target}`);
      if (names.length) io.log(`  generated ${names.join(', ')} in ${project.envFile(component)}`);
    }
    const located = appendMissing(project.envFile('server'), projectEnv(project.dir, project.path('run', 'server-runtime.json')), `Added by magnus upgrade to ${target}`);
    if (located.length) io.log(`  added ${located.join(', ')} to ${project.envFile('server')}`);
    project.save();

    await installVersion(io, project, manifest, catalog);
    if (manifest.engineProtocol > ENGINE_PROTOCOL && !options.resume) {
      io.log(`  handing over to the ${target} upgrade engine`);
      // The child takes this lock over (MAGNUS_LOCK_TOKEN); it is never free in between.
      const token = (lock as Lock).token;
      lock = () => undefined;
      return await handOver(project, target, options, token);
    }
    return await applyInstalled(io, project, current, target, options);
  } finally {
    lock();
  }
}

/** Upper bound of the pre-migration dump: the database size. */
async function estimateDump(io: Io, project: Project, current: string): Promise<number | null> {
  if (project.state.database.kind === 'compose') return databaseBytes(io, project);
  return (await migrationReport(io, project, current).catch(() => null))?.databaseBytes ?? null;
}

/** pg_dump, npm and the services' Node.js, without changing anything. */
async function dryRunChecks(io: Io, project: Project, current: string, nodePath: string): Promise<string[]> {
  const problems: string[] = [];
  const npm = npmFor(nodePath);
  const npmVersion = await io.run(npm.command, [...npm.prefix, '--version'], { capture: true }).catch(() => null);
  if (!npmVersion || npmVersion.code !== 0) problems.push(`npm cannot be run (${npm.command}); it installs the new release.`);
  if (project.state.database.kind === 'external') {
    const env = readEnvFile(project.envFile('server'));
    const pgDump = env['MAGNUS_PG_DUMP'] ?? io.env['MAGNUS_PG_DUMP'] ?? 'pg_dump';
    const result = await io.run(pgDump, ['--version'], { capture: true }).catch(() => null);
    const major = Number(/(\d+)/.exec(result?.stdout ?? '')?.[1]);
    if (!result || result.code !== 0 || !Number.isFinite(major)) {
      problems.push(`${pgDump} is not installed; the pre-migration backup needs the PostgreSQL client tools (or MAGNUS_PG_DUMP in ${project.envFile('server')}).`);
    } else {
      const server = (await migrationReport(io, project, current).catch(() => null))?.postgresMajor ?? null;
      if (server !== null && major < server) problems.push(`${pgDump} is PostgreSQL ${major} but the database runs PostgreSQL ${server}; install the ${server} client and set MAGNUS_PG_DUMP.`);
    }
  }
  return problems;
}

function handOver(project: Project, target: string, options: UpgradeOptions, token: string): Promise<number> {
  const args = [project.bin(target, 'magnus'), 'upgrade', '--resume', '--dir', project.dir, '--to', target,
    '--registry', options.registry, '--health-timeout', String(Math.round(options.healthTimeoutMs / 1000))];
  if (options.yes) args.push('--yes');
  if (options.allowMajor) args.push('--allow-major');
  if (options.force) args.push('--force');
  if (options.source) args.push('--source', options.source);
  return new Promise((resolve, reject) => {
    const child = spawn(project.nodePath(), args, { stdio: 'inherit', env: { ...process.env, MAGNUS_LOCK_TOKEN: token } });
    // The child handles signals itself (it shares the terminal); this process only waits.
    const ignore = () => undefined;
    for (const signal of SIGNALS) process.on(signal, ignore);
    const done = () => { for (const signal of SIGNALS) process.off(signal, ignore); };
    child.on('error', (error) => { done(); reject(error); });
    child.on('close', (code) => { done(); resolve(code ?? 1); });
  });
}

/** `upgrade --node PATH` on the serving version: rewrite the units and restart. */
async function switchNode(io: Io, project: Project, current: string, options: UpgradeOptions): Promise<number> {
  const version = await nodeVersionOf(io, project.nodePath()).catch((error: unknown) => { throw new UpgradeError(error instanceof Error ? error.message : String(error)); });
  const problems = await smokeTest(io, project, current);
  if (problems.length) throw new UpgradeError([`${current} does not start on ${project.nodePath()} (${version}); nothing changed:`, ...problems.map((p) => `  ${p}`)].join('\n'));
  await checkSupervisor(io, project.state.supervisor, project.state.scope);
  project.save();
  for (const file of refreshUnits(io, project, project.state.nodePath)) io.log(`  updated ${file}`);
  const restartedAt = io.now();
  await restartServices(io, project);
  const health = await waitForHealthy(io, project, { version: current, startedAfter: restartedAt, timeoutMs: options.healthTimeoutMs });
  if (!health.ok) {
    io.warn(`${current} on ${project.nodePath()} is ${health.detail}. Logs: ${logsHint(project)}`);
    return 1;
  }
  io.log(`Services now run Node.js ${version} (${project.nodePath()}): ${health.detail}.`);
  return 0;
}

/** Finish an upgrade the journal says was interrupted: back to the "from serving" state, then the normal steps. */
async function resumeJournal(io: Io, project: Project, journal: UpgradeJournal, options: UpgradeOptions): Promise<number> {
  io.log(`Resuming the interrupted upgrade ${journal.from} -> ${journal.to} (it stopped during "${journal.phase}")`);
  if (!isInstalled(project, journal.to) || !isInstalled(project, journal.from)) {
    throw new UpgradeError(`versions/${isInstalled(project, journal.to) ? journal.from : journal.to} is missing, so the upgrade cannot be resumed. Use \`magnus rollback --dir ${project.dir}\`.`);
  }
  if (project.linkedVersion() !== journal.from) project.switchCurrent(journal.from);
  project.state.current = journal.from;
  project.state.previous = project.state.history.findLast((entry) => entry.to === journal.from && entry.result === 'ok')?.from ?? project.state.previous;
  delete project.state.inProgress;
  project.save();
  return applyInstalled(io, project, journal.from, journal.to, options,
    journal.backup ? { backup: { file: journal.backup, restoreCommand: restoreCommandFor(project, journal.backup) }, oneWay: journal.oneWay, migrations: journal.migrations } : undefined);
}

interface Prior {
  backup: Backup;
  oneWay: string[];
  migrations: string[];
}

/** Every migration history marks one-way (the impact the manifest gave when it was applied). */
export function knownOneWay(project: Project): Set<string> {
  return new Set(project.state.history.flatMap((entry) => entry.oneWay ?? []));
}

/** Check, back up, migrate, switch, restart, verify; revert on failure. */
export async function applyInstalled(io: Io, project: Project, current: string, target: string, options: UpgradeOptions, prior?: Prior): Promise<number> {
  const report = await migrationReport(io, project, target);
  if (report.failed.length) {
    throw new UpgradeError([
      `Stopped before changing anything: migration(s) ${report.failed.join(', ')} failed earlier and are still marked failed in the database, which may be half-migrated.`,
      `Restore the dump taken before that attempt (${prior ? restoreCommandFor(project, prior.backup.file) : `magnus restore <dump in ${project.path('backups')}> --dir ${project.dir}`}),`,
      'or repair the schema and mark the migration with `npx prisma migrate resolve --rolled-back <name>` (or `--applied <name>`).',
    ].join('\n'));
  }
  const pending = report.pending;
  await confirmAttention(io, pending, options.yes);

  io.log(`  checking ${target} before touching the database`);
  const problems = await smokeTest(io, project, target);
  if (problems.length) {
    throw new UpgradeError([`${target} failed its checks; nothing changed and ${current} is still serving:`, ...problems.map((problem) => `  ${problem}`)].join('\n'));
  }
  try {
    await checkSupervisor(io, project.state.supervisor, project.state.scope);
  } catch (error) {
    throw new UpgradeError(`Stopped before changing anything: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (pending.length > 0) {
    const space = diskProblems(io, project, { install: false, dumpBytes: report.databaseBytes ?? await databaseBytes(io, project) });
    if (space.length) throw new UpgradeError(['Stopped before the backup:', ...space.map((problem) => `  ${problem}`)].join('\n'));
  }

  const migrations = [...new Set([...(prior?.migrations ?? []), ...pending.map((m) => m.name)])];
  const oneWay = [...new Set([...(prior?.oneWay ?? []), ...pending.filter((m) => m.impact === 'one-way').map((m) => m.name)])];
  const journal: UpgradeJournal = { phase: 'backup', from: current, to: target, migrations, oneWay, startedAt: io.now().toISOString(), pid: process.pid,
    ...(prior ? { backup: prior.backup.file } : {}) };
  const step = (phase: UpgradeJournal['phase']) => {
    journal.phase = phase;
    project.state.inProgress = journal;
    project.save();
  };
  const entry = (result: HistoryEntry['result'], reason?: string): HistoryEntry => ({
    action: 'upgrade', from: current, to: target, at: io.now().toISOString(), result, migrations,
    ...(backup ? { backup: backup.file, restoreCommand: backup.restoreCommand } : {}), ...(oneWay.length ? { oneWay } : {}), ...(reason ? { reason } : {}),
  });
  const finish = (record: HistoryEntry) => {
    delete project.state.inProgress;
    project.record(record);
    project.save();
  };

  let backup: Backup | undefined = prior?.backup;
  const trap = trapSignals(io);
  let switched = false;
  try {
    step('backup');
    if (pending.length > 0) {
      trap.checkpoint();
      backup = await backupDatabase(io, project, target, `pre-upgrade-${current}-to-${target}`).catch((error: unknown) => {
        throw new UpgradeError(`Stopped before migrating: the database backup failed. ${error instanceof Error ? error.message : String(error)}`);
      });
      journal.backup = backup.file;
      io.log(`  backup: ${backup.file}`);
      trap.checkpoint();
      step('migrate');
      io.log(`  applying ${pending.length} migration(s) (${current} keeps serving meanwhile)`);
      try {
        // Its own process group: a Ctrl-C now waits for the migration instead of killing it halfway.
        await serverCli(io, project, target, ['migrate'], { detached: true });
      } catch (error) {
        throw new UpgradeError([
          `Migration to ${target} failed; ${current} is still serving. ${error instanceof Error ? error.message : String(error)}`,
          'If the database was left half-migrated, restore the backup (it stops and restarts the services):',
          `  ${backup.restoreCommand}`,
        ].join('\n'));
      }
    } else {
      io.log('  no database migrations');
    }
    trap.checkpoint();

    step('switch');
    project.state.previous = current;
    project.state.current = target;
    project.switchCurrent(target);
    switched = true;
    step('restart');
    for (const file of refreshUnits(io, project, project.state.nodePath)) io.log(`  updated ${file}`);
    io.log(`  switched ./current to ${target}; restarting`);
    const restartedAt = io.now();
    let health: HealthResult;
    try {
      await restartServices(io, project);
      step('health');
      health = await waitForHealthy(io, project, { version: target, startedAfter: restartedAt, timeoutMs: options.healthTimeoutMs, abort: () => trap.signal !== null });
    } catch (error) {
      health = { ok: false, detail: `the restart failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (trap.signal && !health.ok) health = { ok: false, detail: `interrupted (${trap.signal}) before it became healthy` };
    if (!health.ok) return await revert(io, project, { current, target, backup, oneWay, reason: health.detail, options, trap, entry, finish });

    publishPins(project, target);
    const pruned = pruneVersions(project, project.state.keepVersions, compareVersions);
    const dumps = pruneBackups(project.path('backups'), project.keepBackups(), backup ? [backup.file] : []);
    finish(entry('ok'));
    io.log(`Upgraded to ${target}: ${health.detail}.${pruned.length ? ` Removed old versions ${pruned.join(', ')}.` : ''}${dumps.length ? ` Removed ${dumps.length} old dump(s).` : ''}`);
    io.log('Agents keep running their version until you upgrade them: `magnus-server agents upgrade` or the "Upgrade agents" button on the Nodes page.');
    return 0;
  } catch (error) {
    if (switched && project.state.inProgress) {
      return await revert(io, project, { current, target, backup, oneWay, reason: error instanceof Error ? error.message : String(error), options, trap, entry, finish });
    }
    if (project.state.inProgress) {
      const migrated = journal.phase !== 'backup';
      const interrupted = error instanceof InterruptedError || trap.signal !== null;
      finish(entry('failed', interrupted ? `interrupted (${trap.signal})` : (migrated ? 'migration failed' : 'stopped before migrating')));
      if (interrupted) {
        io.warn([
          `Upgrade to ${target} stopped (${trap.signal}); ${current} is still serving.`,
          ...(migrated && backup ? [`The database was migrated. ${current} normally works with the newer schema; to undo it: ${backup.restoreCommand}`] : []),
        ].join('\n'));
        return 130;
      }
    }
    throw error;
  } finally {
    trap.dispose();
  }
}

interface RevertContext {
  current: string;
  target: string;
  backup?: Backup;
  oneWay: string[];
  reason: string;
  options: UpgradeOptions;
  trap: SignalTrap;
  entry: (result: HistoryEntry['result'], reason?: string) => HistoryEntry;
  finish: (record: HistoryEntry) => void;
}

/**
 * Switch back to the version that served before. Over one-way migrations the
 * old version is not started (unless --force): only the dump undoes them.
 * The restore hint is printed whatever happens here.
 */
async function revert(io: Io, project: Project, context: RevertContext): Promise<number> {
  const { current, target, backup, oneWay, options } = context;
  context.trap.reverting();
  io.warn(`  ${target} is ${context.reason}; switching back to ${current}`);
  let back: HealthResult = { ok: false, detail: 'not restarted' };
  const blocked = oneWay.length > 0 && !options.force;
  try {
    project.state.inProgress = { ...project.state.inProgress!, phase: 'revert' };
    project.save();
    project.switchCurrent(current);
    project.state.current = current;
    project.state.previous = project.state.history.findLast((entry) => entry.to === current && entry.result === 'ok')?.from ?? null;
    project.save();
    if (blocked) {
      await stopServices(io, project, { timeoutMs: 60_000 }).catch((error: unknown) => {
        io.warn(`  could not stop the services: ${error instanceof Error ? error.message : String(error)}`);
      });
      back = { ok: false, detail: `not started: ${target} applied one-way migration(s) ${oneWay.join(', ')}, which ${current} cannot run on` };
    } else {
      const revertedAt = io.now();
      await restartServices(io, project);
      back = await waitForHealthy(io, project, { version: current, startedAfter: revertedAt, timeoutMs: options.healthTimeoutMs });
    }
  } catch (error) {
    back = { ok: false, detail: `the restart failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    context.finish(context.entry('reverted', context.reason));
    io.warn([
      `Upgrade to ${target} failed and was reverted; ${current} is ${back.ok ? 'serving again' : `NOT serving (${back.detail})`}.`,
      ...(backup ? (blocked
        ? [`Restore the pre-upgrade dump; it starts ${current} afterwards:`, `  ${backup.restoreCommand}`,
          `To start ${current} on the migrated database anyway: ${manualRestartHint(project)}`]
        : [`${target} migrated the database. ${current} normally works with the newer schema; if it does not, restore the dump (it stops and restarts the services):`,
          `  ${backup.restoreCommand}`])
        : []),
      `Logs: ${logsHint(project)}`,
    ].join('\n'));
  }
  return 1;
}
