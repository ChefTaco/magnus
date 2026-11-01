/**
 * `magnus upgrade`: install the target release next to the serving one, back
 * up, migrate, check, switch `current`, restart and wait for health. A
 * release that fails its health check is switched back automatically, and
 * the restore command for the pre-migration dump is printed.
 */
import { spawn } from 'node:child_process';
import {
  checkUpgradeAllowed,
  compareVersions,
  satisfiesRange,
  summarizeUpgradePath,
  type ReleaseEnvChange,
  type UpgradePath,
} from '@hivemagnus/magnus-contracts';
import { backupDatabase, type Backup } from './database.js';
import { appendMissing, generateSecret, readEnvFile } from './env-file.js';
import { waitForHealthy } from './health.js';
import { installVersion, pendingMigrations, publishPins, pruneVersions, serverCli, type PendingMigration } from './install.js';
import { CommandError, type Io } from './io.js';
import { acquireLock, Project, type Component } from './project.js';
import { ENGINE_PROTOCOL, fetchRegistryCatalog, newerMajor, pickTarget, releaseFor, sourceCatalog, type ReleaseCatalog } from './release.js';
import { restartServices } from './supervisor.js';

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
  /** Set when an older engine hands a release it installed to this (newer) engine. */
  resume: boolean;
}

export class UpgradeError extends Error {}

export async function loadCatalog(io: Io, options: Pick<UpgradeOptions, 'source' | 'registry'>): Promise<ReleaseCatalog> {
  return options.source ? sourceCatalog(io, options.source, options.registry) : fetchRegistryCatalog(io, options.registry);
}

export function requirePrivileges(io: Io, project: Project): void {
  if (project.state.supervisor === 'systemd' && project.state.scope === 'system' && !io.isRoot) {
    throw new UpgradeError(`This project runs system services; run the command as root (sudo magnus … --dir ${project.dir}).`);
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

export async function upgrade(io: Io, options: UpgradeOptions): Promise<number> {
  const project = Project.load(options.dir);
  requirePrivileges(io, project);
  let release = acquireLock(project.path('run', 'upgrade.lock'));
  try {
    const current = project.state.current;
    if (!current) throw new UpgradeError(`${project.dir} has no serving version; run \`magnus init\` again or \`magnus adopt\`.`);
    const catalog = await loadCatalog(io, options);
    const target = pickTarget(catalog, current, options.to);
    if (target === current) {
      io.log(`Already on ${current}, the newest ${current.split('.')[0]}.x release.`);
      const major = newerMajor(catalog, current);
      if (major) io.log(`${major} is available. Major upgrades are never automatic: read UPGRADING.md, then run \`magnus upgrade --to ${major} --allow-major\`.`);
      return 0;
    }
    const decision = checkUpgradeAllowed(current, target, { allowMajor: options.allowMajor });
    if (!decision.allowed) throw new UpgradeError(decision.reason ?? 'upgrade not allowed');
    const manifest = releaseFor(catalog, target);
    const path = summarizeUpgradePath(catalog.manifests.values(), current, target);
    if (path.blockedBy) throw new UpgradeError(`Cannot upgrade directly: ${path.blockedBy}.`);
    if (!satisfiesRange(io.nodeVersion, manifest.engines.node)) {
      throw new UpgradeError(`${target} needs Node.js ${manifest.engines.node}; this is ${io.nodeVersion}. Install a supported Node.js first.`);
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
    if (options.dryRun) {
      io.log(`Dry run: would install ${target} into versions/${target}, back up the database, migrate, switch ./current and restart. Nothing changed.`);
      return 0;
    }
    for (const component of ['server', 'ui'] as const) {
      const names = appendMissing(project.envFile(component), missing.filter((env) => env.component === component)
        .map((env) => ({ name: env.name, value: generateSecret(), comment: env.description })), `Added by magnus upgrade to ${target}`);
      if (names.length) io.log(`  generated ${names.join(', ')} in ${project.envFile(component)}`);
    }

    await installVersion(io, project, manifest, catalog);
    if (manifest.engineProtocol > ENGINE_PROTOCOL && !options.resume) {
      io.log(`  handing over to the ${target} upgrade engine`);
      release();
      release = () => undefined;
      return handOver(project, target, options);
    }
    return await applyInstalled(io, project, current, target, options);
  } finally {
    release();
  }
}

function handOver(project: Project, target: string, options: UpgradeOptions): Promise<number> {
  const args = [project.bin(target, 'magnus'), 'upgrade', '--resume', '--dir', project.dir, '--to', target,
    '--registry', options.registry, '--health-timeout', String(Math.round(options.healthTimeoutMs / 1000))];
  if (options.yes) args.push('--yes');
  if (options.allowMajor) args.push('--allow-major');
  if (options.source) args.push('--source', options.source);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Back up, migrate, check, switch, restart, verify; revert on failure. */
export async function applyInstalled(io: Io, project: Project, current: string, target: string, options: UpgradeOptions): Promise<number> {
  const pending = await pendingMigrations(io, project, target);
  await confirmAttention(io, pending, options.yes);
  let backup: Backup | undefined;
  if (pending.length > 0) {
    backup = await backupDatabase(io, project, target, `pre-upgrade-${current}-to-${target}`).catch((error: unknown) => {
      throw new UpgradeError(`Stopped before migrating: the database backup failed. ${error instanceof Error ? error.message : String(error)}`);
    });
    io.log(`  backup: ${backup.file}`);
    io.log(`  applying ${pending.length} migration(s) (${current} keeps serving meanwhile)`);
    try {
      await serverCli(io, project, target, ['migrate']);
    } catch (error) {
      project.record({ action: 'upgrade', from: current, to: target, at: io.now().toISOString(), result: 'failed',
        migrations: pending.map((m) => m.name), backup: backup.file, restoreCommand: backup.restoreCommand, reason: 'migration failed' });
      project.save();
      throw new UpgradeError([
        `Migration to ${target} failed; ${current} is still serving. ${error instanceof Error ? error.message : String(error)}`,
        'If the database was left half-migrated, stop the services and restore the backup:',
        `  ${backup.restoreCommand}`,
      ].join('\n'));
    }
  } else {
    io.log('  no database migrations');
  }

  const check = await serverCli(io, project, target, ['check', '--format', 'json'], { capture: true })
    .then((result) => result.stdout)
    .catch((error: unknown) => (error instanceof CommandError ? error.result?.stdout ?? '' : ''));
  const failures = ((JSON.parse(check || '{"results":[]}') as { results: Array<{ name: string; status: string; message: string }> }).results ?? [])
    .filter((result) => result.status === 'fail');
  if (failures.length > 0) {
    throw new UpgradeError([
      `${target} failed its configuration check; ${current} is still serving:`,
      ...failures.map((failure) => `  ${failure.name}: ${failure.message}`),
      ...(backup ? ['The database was migrated. If the old version misbehaves, restore with:', `  ${backup.restoreCommand}`] : []),
    ].join('\n'));
  }

  const restartedAt = io.now();
  project.state.previous = current;
  project.state.current = target;
  project.switchCurrent(target);
  project.save();
  io.log(`  switched ./current to ${target}; restarting`);
  await restartServices(io, project);
  const health = await waitForHealthy(io, project, { version: target, startedAfter: restartedAt, timeoutMs: options.healthTimeoutMs });
  const migrations = pending.map((m) => m.name);
  if (!health.ok) {
    io.warn(`  ${target} is ${health.detail}; switching back to ${current}`);
    project.switchCurrent(current);
    project.state.current = current;
    project.state.previous = project.state.history.findLast((entry) => entry.to === current && entry.result === 'ok')?.from ?? null;
    project.record({ action: 'upgrade', from: current, to: target, at: io.now().toISOString(), result: 'reverted', migrations,
      ...(backup ? { backup: backup.file, restoreCommand: backup.restoreCommand } : {}), reason: health.detail });
    project.save();
    const revertedAt = io.now();
    await restartServices(io, project);
    const back = await waitForHealthy(io, project, { version: current, startedAfter: revertedAt, timeoutMs: options.healthTimeoutMs });
    io.warn([
      `Upgrade to ${target} failed and was reverted; ${current} is ${back.ok ? 'serving again' : `NOT healthy either (${back.detail})`}.`,
      ...(backup ? [
        `${target} migrated the database. ${current} normally works with the newer schema; if it does not, stop the services and restore:`,
        `  ${backup.restoreCommand}`,
      ] : []),
      `Logs: ${project.state.supervisor === 'systemd' ? `journalctl ${project.state.scope === 'user' ? '--user ' : ''}-u ${project.state.units.server} -n 100` : 'see your service manager'}`,
    ].join('\n'));
    return 1;
  }
  project.record({ action: 'upgrade', from: current, to: target, at: io.now().toISOString(), result: 'ok', migrations,
    ...(backup ? { backup: backup.file, restoreCommand: backup.restoreCommand } : {}) });
  publishPins(project, target);
  const pruned = pruneVersions(project, project.state.keepVersions, compareVersions);
  project.save();
  io.log(`Upgraded to ${target}: ${health.detail}.${pruned.length ? ` Removed old versions ${pruned.join(', ')}.` : ''}`);
  io.log('Agents keep running their version until you upgrade them: `magnus-server agents upgrade` or the "Upgrade agents" button on the Nodes page.');
  return 0;
}
