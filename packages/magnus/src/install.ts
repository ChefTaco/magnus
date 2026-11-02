/** Installing one release into versions/<X.Y.Z> and running its server CLI. */
import { chownSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isVersion, type ReleaseManifest } from '@hivemagnus/magnus-contracts';
import { CommandError, mustRun, type Io } from './io.js';
import type { Project } from './project.js';
import { CONTRACTS_PACKAGE, META_PACKAGE, ownPackage, SERVER_PACKAGE, UI_PACKAGE, type ReleaseCatalog } from './release.js';
import { ALLOW_SCRIPTS, versionPackageJson } from './templates.js';

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

/**
 * npm for a Node.js binary: the npm-cli.js shipped next to it (so installs
 * build native modules for the Node.js the services run), else npm on PATH.
 */
export function npmFor(nodePath: string): { command: string; prefix: string[] } {
  for (const cli of [join(dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(cli)) return { command: nodePath, prefix: [cli] };
  }
  return { command: 'npm', prefix: [] };
}

/** `node --version` of the binary the services run (without the v). */
export async function nodeVersionOf(io: Io, nodePath: string): Promise<string> {
  const result = await io.run(nodePath, ['--version'], { capture: true }).catch((error: unknown) => {
    throw new Error(`The Node.js the services run (${nodePath}) cannot be started: ${error instanceof Error ? error.message : String(error)}. Pass --node <path> to switch.`);
  });
  const version = result.stdout.trim().replace(/^v/, '');
  if (result.code !== 0 || !isVersion(version)) throw new Error(`${nodePath} --version failed; pass --node <path to node> to switch the Node.js the services run.`);
  return version;
}

/** Remove half-finished installs (versions/*.tmp) left by an interrupted run. */
export function removeStaleStaging(project: Project): string[] {
  const dir = project.path('versions');
  if (!existsSync(dir)) return [];
  const stale = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  for (const name of stale) rmSync(join(dir, name), { recursive: true, force: true });
  return stale;
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
  // The release knows which install scripts its tree needs; this engine's list only covers releases without one.
  const allowScripts = manifest.allowScripts ?? ALLOW_SCRIPTS;
  writeFileSync(join(staging, 'package.json'), versionPackageJson(manifest.version, dependencies, overridesFor(manifest, catalog, metaVersion), allowScripts));
  io.log(`  installing ${manifest.version} into versions/${manifest.version} (npm install; this takes a few minutes)`);
  const npm = npmFor(project.nodePath());
  await mustRun(io, npm.command, [...npm.prefix, 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: staging, capture: true, env: { ...io.env, PATH: `${dirname(project.nodePath())}:${io.env['PATH'] ?? ''}` } });
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
  detached?: boolean;
}

/** Run a version's magnus-server CLI (with the services' Node.js) against the project's server env file. */
export function serverCli(io: Io, project: Project, version: string, args: string[], options: ServerCliOptions = {}) {
  return mustRun(io, project.nodePath(), [project.bin(version, 'magnus-server'), ...args, '--env-file', project.envFile('server')], {
    cwd: project.dir,
    capture: options.capture,
    detached: options.detached,
    env: { ...io.env, MAGNUS_PROJECT_DIR: project.dir, MAGNUS_BACKUP_DIR: project.path('backups'), MAGNUS_BACKUP_KEEP: String(project.keepBackups()), ...options.env },
  });
}

export interface PendingMigration {
  name: string;
  impact: 'fast' | 'slow' | 'one-way';
  note: string;
}

export interface MigrationReport {
  packaged: string[];
  applied: string[];
  pending: PendingMigration[];
  /** Started but never finished. */
  failed: string[];
  /** Applied but not packaged with this version: the database is ahead of it. */
  unknown: Array<{ name: string; appliedAt: string | null }>;
  databaseBytes: number | null;
  postgresMajor: number | null;
}

/**
 * Migration state as seen by a version's server (its packaged migrations vs
 * the database). Servers before 1.1.3 report only packaged/applied/pending;
 * the rest is derived from those or left unknown.
 */
export async function migrationReport(io: Io, project: Project, version: string): Promise<MigrationReport> {
  const { stdout } = await serverCli(io, project, version, ['migrations', '--format', 'json'], { capture: true });
  const raw = JSON.parse(stdout) as Partial<MigrationReport> & { pending: PendingMigration[] };
  const packaged = raw.packaged ?? [];
  const applied = raw.applied ?? [];
  const known = new Set(packaged);
  return {
    packaged,
    applied,
    pending: raw.pending,
    failed: raw.failed ?? [],
    unknown: raw.unknown ?? (packaged.length ? applied.filter((name) => !known.has(name)).map((name) => ({ name, appliedAt: null })) : []),
    databaseBytes: typeof raw.databaseBytes === 'number' ? raw.databaseBytes : null,
    postgresMajor: typeof raw.postgresMajor === 'number' ? raw.postgresMajor : null,
  };
}

export async function pendingMigrations(io: Io, project: Project, version: string): Promise<PendingMigration[]> {
  return (await migrationReport(io, project, version)).pending;
}

/** Native modules the server and console load at startup, checked before anything changes. */
const NATIVE_MODULES = ['argon2', 'better-sqlite3', 'ssh2', 'sharp'];

/**
 * Before the backup: the new version starts on this Node.js (`--version`
 * prints its version, native modules load) and its configuration check
 * passes. A check that crashes or prints no results counts as a failure.
 */
export async function smokeTest(io: Io, project: Project, version: string): Promise<string[]> {
  const problems: string[] = [];
  const printed = await serverCli(io, project, version, ['--version'], { capture: true }).then((result) => result.stdout.trim())
    .catch((error: unknown) => { problems.push(`magnus-server --version failed: ${error instanceof Error ? error.message : String(error)}`); return null; });
  if (printed !== null && printed !== version) problems.push(`magnus-server --version printed "${printed.split('\n')[0]}", expected ${version}`);
  const script = `import { createRequire } from 'node:module';
const req = createRequire(process.argv[1] + '/');
const failed = [];
for (const name of ${JSON.stringify(NATIVE_MODULES)}) {
  let path; try { path = req.resolve(name); } catch { continue; }
  try { const mod = await import(path); if (name === 'better-sqlite3') new mod.default(':memory:').close(); } catch (error) { failed.push(name + ': ' + String(error && error.message || error).split('\\n')[0]); }
}
if (failed.length) { console.error(failed.join('\\n')); process.exit(1); }`;
  const roots = [join(project.versionDir(version), 'node_modules', '@hivemagnus', 'magnus-server'),
    ...(project.state.components.includes('ui') ? [join(project.versionDir(version), 'node_modules', '@hivemagnus', 'magnus-ui')] : [])];
  for (const root of roots.filter((path) => existsSync(path))) {
    const result = await io.run(project.nodePath(), ['--input-type=module', '-e', script, root], { capture: true, cwd: project.versionDir(version) })
      .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    if (result.code !== 0) problems.push(`native modules of ${root.split('/').pop()} do not load on Node.js ${project.nodePath()}: ${result.stderr.trim().split('\n').slice(0, 3).join('; ')}`);
  }
  const check = await serverCli(io, project, version, ['check', '--format', 'json'], { capture: true })
    .then((result) => result.stdout)
    .catch((error: unknown) => (error instanceof CommandError ? error.result?.stdout ?? '' : ''));
  type CheckEntry = { name: string; status: string; message: string };
  let results: CheckEntry[] | null = null;
  try {
    const parsed = JSON.parse(check) as { results?: unknown };
    if (Array.isArray(parsed.results)) results = parsed.results as CheckEntry[];
  } catch { /* handled below */ }
  if (!results) problems.push('`magnus-server check` crashed or printed no results (run it by hand to see why)');
  else for (const result of results.filter((entry) => entry.status === 'fail')) problems.push(`${result.name}: ${result.message}`);
  return problems;
}

/** Give the service account the files it writes to (system scope only). */
export async function chownForService(io: Io, user: string, paths: string[]): Promise<void> {
  const uid = Number((await mustRun(io, 'id', ['-u', user], { capture: true })).stdout.trim());
  const gid = Number((await mustRun(io, 'id', ['-g', user], { capture: true })).stdout.trim());
  for (const path of paths) if (existsSync(path)) chownSync(path, uid, gid);
}
