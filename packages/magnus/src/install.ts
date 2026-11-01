/** Installing one release into versions/<X.Y.Z> and running its server CLI. */
import { chownSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReleaseManifest } from '@hivemagnus/magnus-contracts';
import { mustRun, type Io } from './io.js';
import type { Project } from './project.js';
import { CONTRACTS_PACKAGE, META_PACKAGE, ownPackage, SERVER_PACKAGE, UI_PACKAGE, type ReleaseCatalog } from './release.js';
import { versionPackageJson } from './templates.js';

/** Exact pins (or local tarballs from --source) for one release. */
export function dependenciesFor(project: Project, manifest: ReleaseManifest, catalog: ReleaseCatalog): Record<string, string> {
  const pin = (name: string, version: string) => {
    const tarball = catalog.tarballs.get(`${name}@${version}`);
    return tarball ? `file:${tarball}` : version;
  };
  const dependencies: Record<string, string> = {};
  const wanted = [SERVER_PACKAGE, CONTRACTS_PACKAGE, ...(project.state.components.includes('ui') ? [UI_PACKAGE] : [])];
  for (const name of wanted) {
    const version = manifest.components[name];
    if (!version) throw new Error(`Release ${manifest.version} does not pin ${name}`);
    dependencies[name] = pin(name, version);
  }
  // Releases before the meta package existed are driven by this engine.
  const metaVersion = catalog.versions.includes(manifest.version) || catalog.tarballs.has(`${META_PACKAGE}@${manifest.version}`)
    ? manifest.version
    : ownPackage().version;
  dependencies[META_PACKAGE] = pin(META_PACKAGE, metaVersion);
  return dependencies;
}

/**
 * With --source, sibling packages of the same release (for example
 * @hivemagnus/magnus-skills, which the server pins exactly) come from the
 * local tarballs too. Tarballs of the engine's own release apply only inside
 * @hivemagnus/magnus when it is newer than the release being installed.
 */
export function overridesFor(manifest: ReleaseManifest, catalog: ReleaseCatalog, metaVersion: string): Record<string, string | Record<string, string>> {
  const overrides: Record<string, string | Record<string, string>> = {};
  const scoped: Record<string, string> = {};
  for (const [key, path] of catalog.tarballs) {
    const at = key.lastIndexOf('@');
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (name === META_PACKAGE) continue;
    if (version === manifest.version) overrides[name] = `file:${path}`;
    else if (version === metaVersion) scoped[name] = `file:${path}`;
  }
  if (metaVersion !== manifest.version && Object.keys(scoped).length) overrides[META_PACKAGE] = scoped;
  return overrides;
}

function metaVersionOf(catalog: ReleaseCatalog, spec: string): string {
  for (const [key, path] of catalog.tarballs) if (`file:${path}` === spec) return key.slice(key.lastIndexOf('@') + 1);
  return ownPackage().version;
}

export function isInstalled(project: Project, version: string): boolean {
  return existsSync(project.bin(version, 'magnus-server'));
}

/**
 * npm install into versions/<X>.tmp, then rename, so a failed or interrupted
 * install never leaves a half-populated version directory behind.
 */
export async function installVersion(io: Io, project: Project, manifest: ReleaseManifest, catalog: ReleaseCatalog): Promise<void> {
  const target = project.versionDir(manifest.version);
  if (isInstalled(project, manifest.version)) {
    io.log(`  versions/${manifest.version} is already installed`);
    return;
  }
  const staging = `${target}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const dependencies = dependenciesFor(project, manifest, catalog);
  const metaVersion = dependencies[META_PACKAGE]?.startsWith('file:') ? metaVersionOf(catalog, dependencies[META_PACKAGE]) : dependencies[META_PACKAGE] ?? manifest.version;
  writeFileSync(join(staging, 'package.json'), versionPackageJson(manifest.version, dependencies, overridesFor(manifest, catalog, metaVersion)));
  io.log(`  installing ${manifest.version} into versions/${manifest.version} (npm install; this takes a few minutes)`);
  await mustRun(io, 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: staging, capture: true });
  renameSync(staging, target);
}

/** Copy the serving version's manifest and lockfile to the project root (what `current` pins). */
export function publishPins(project: Project, version: string): void {
  for (const file of ['package.json', 'package-lock.json']) {
    const source = join(project.versionDir(version), file);
    if (existsSync(source)) cpSync(source, project.path(file));
  }
}

/** Keep the newest `keep` versions plus anything `current`/`previous` point at. */
export function pruneVersions(project: Project, keep: number, compare: (a: string, b: string) => number): string[] {
  const dir = project.path('versions');
  if (!existsSync(dir)) return [];
  const protectedVersions = new Set([project.state.current, project.state.previous].filter(Boolean));
  const versions = readdirSync(dir).filter((name) => !name.endsWith('.tmp') && statSync(join(dir, name)).isDirectory());
  const ordered = versions.filter((v) => /^\d+\.\d+\.\d+/.test(v)).sort(compare).reverse();
  const removed: string[] = [];
  for (const version of ordered.slice(keep)) {
    if (protectedVersions.has(version)) continue;
    rmSync(join(dir, version), { recursive: true, force: true });
    removed.push(version);
  }
  return removed;
}

export interface ServerCliOptions {
  capture?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Run a version's magnus-server CLI against the project's server env file. */
export function serverCli(io: Io, project: Project, version: string, args: string[], options: ServerCliOptions = {}) {
  return mustRun(io, process.execPath, [project.bin(version, 'magnus-server'), ...args, '--env-file', project.envFile('server')], {
    cwd: project.dir,
    capture: options.capture,
    env: { ...io.env, MAGNUS_PROJECT_DIR: project.dir, MAGNUS_BACKUP_DIR: project.path('backups'), ...options.env },
  });
}

export interface PendingMigration {
  name: string;
  impact: 'fast' | 'slow' | 'one-way';
  note: string;
}

/** Pending migrations as seen by a version's server (its packaged migrations vs the database). */
export async function pendingMigrations(io: Io, project: Project, version: string): Promise<PendingMigration[]> {
  const { stdout } = await serverCli(io, project, version, ['migrations', '--format', 'json'], { capture: true });
  return (JSON.parse(stdout) as { pending: PendingMigration[] }).pending;
}

/** Give the service account the files it writes to (system scope only). */
export async function chownForService(io: Io, user: string, paths: string[]): Promise<void> {
  const uid = Number((await mustRun(io, 'id', ['-u', user], { capture: true })).stdout.trim());
  const gid = Number((await mustRun(io, 'id', ['-g', user], { capture: true })).stdout.trim());
  for (const path of paths) if (existsSync(path)) chownSync(path, uid, gid);
}
