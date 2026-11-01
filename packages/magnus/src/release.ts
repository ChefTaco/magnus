/**
 * Where release information comes from: the npm registry (the full packument
 * of @hivemagnus/magnus carries every release's `magnusRelease` manifest), a
 * directory of packed tarballs (`--source`, for CI and offline hosts), and
 * this package's own manifest.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  latestVersion,
  manifestsFromPackument,
  releaseManifestSchema,
  type ReleaseManifest,
} from '@hivemagnus/magnus-contracts';
import { mustRun, type Io } from './io.js';

export const META_PACKAGE = '@hivemagnus/magnus';
export const SERVER_PACKAGE = '@hivemagnus/magnus-server';
export const UI_PACKAGE = '@hivemagnus/magnus-ui';
export const CONTRACTS_PACKAGE = '@hivemagnus/magnus-contracts';
export const AGENT_PACKAGE = '@hivemagnus/magnus-agent';

/** Packages a project installs; the agent runs on managed hosts, not here. */
export const PROJECT_PACKAGES = [SERVER_PACKAGE, UI_PACKAGE, CONTRACTS_PACKAGE] as const;

/** Upgrade-engine protocol; a newer target engine takes over migrate and switch. */
export const ENGINE_PROTOCOL = 1;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function ownPackage(): { version: string; magnusRelease: ReleaseManifest } {
  const raw = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string; magnusRelease: unknown };
  return { version: raw.version, magnusRelease: releaseManifestSchema.parse(raw.magnusRelease) };
}

export interface ReleaseCatalog {
  /** Every published version of the meta package. */
  versions: string[];
  manifests: Map<string, ReleaseManifest>;
  /** Tarballs by `name@version` when installing from --source. */
  tarballs: Map<string, string>;
}

export async function fetchRegistryCatalog(io: Io, registry: string, packageName = META_PACKAGE): Promise<ReleaseCatalog> {
  const url = `${registry.replace(/\/+$/, '')}/${packageName.replace('/', '%2f')}`;
  let response: Response;
  try {
    // The full document: the abbreviated install format drops custom fields.
    response = await io.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new Error(`Cannot reach the npm registry (${url}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) return { versions: [], manifests: new Map(), tarballs: new Map() };
  if (!response.ok) throw new Error(`The npm registry answered ${response.status} for ${url}`);
  const packument = await response.json() as { versions?: Record<string, unknown> };
  const manifests = new Map(manifestsFromPackument(packument).map((m) => [m.version, m]));
  return { versions: Object.keys(packument.versions ?? {}), manifests, tarballs: new Map() };
}

/** npm pack names files `<scope>-<name>-<version>.tgz`. */
export function tarballName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

export async function readSourceCatalog(io: Io, sourceDir: string): Promise<ReleaseCatalog> {
  const dir = resolve(sourceDir);
  if (!existsSync(dir)) throw new Error(`--source ${dir} does not exist`);
  const tarballs = new Map<string, string>();
  const manifests = new Map<string, ReleaseManifest>();
  const versions: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.tgz')).sort()) {
    const path = join(dir, file);
    const { stdout } = await mustRun(io, 'tar', ['-xzOf', path, 'package/package.json'], { capture: true });
    const pkg = JSON.parse(stdout) as { name: string; version: string; magnusRelease?: unknown };
    tarballs.set(`${pkg.name}@${pkg.version}`, path);
    if (pkg.name === META_PACKAGE) {
      versions.push(pkg.version);
      const parsed = releaseManifestSchema.safeParse(pkg.magnusRelease);
      if (parsed.success) manifests.set(pkg.version, parsed.data);
    }
  }
  return { versions, manifests, tarballs };
}

/** Registry history plus local tarballs; local entries win. The registry is optional here. */
export async function sourceCatalog(io: Io, sourceDir: string, registry: string): Promise<ReleaseCatalog> {
  const local = await readSourceCatalog(io, sourceDir);
  const remote = await fetchRegistryCatalog(io, registry).catch(() => null);
  if (!remote) return local;
  return {
    versions: [...new Set([...remote.versions, ...local.versions])],
    manifests: new Map([...remote.manifests, ...local.manifests]),
    tarballs: local.tarballs,
  };
}

/**
 * The manifest for a version. Releases before the meta package existed
 * (1.0.x) have none: their components share the release version and this
 * engine drives them.
 */
export function releaseFor(catalog: ReleaseCatalog, version: string): ReleaseManifest {
  const found = catalog.manifests.get(version);
  if (found) return found;
  const own = ownPackage().magnusRelease;
  return releaseManifestSchema.parse({
    schema: 1,
    version,
    engines: own.engines,
    components: Object.fromEntries([...PROJECT_PACKAGES, AGENT_PACKAGE].map((name) => [name, version])),
    engineProtocol: ENGINE_PROTOCOL,
    agent: { selfUpgradeProtocol: 0, minLauncher: 0 },
    summary: 'Release without a manifest (before @hivemagnus/magnus existed).',
  });
}

export function pickTarget(catalog: ReleaseCatalog, current: string, requested?: string): string {
  if (requested) {
    if (!catalog.versions.includes(requested) && !catalog.manifests.has(requested)) {
      throw new Error(`${META_PACKAGE}@${requested} is not published${catalog.tarballs.size ? ' and not in --source' : ''}.`);
    }
    return requested;
  }
  const latest = latestVersion(catalog.versions, { sameMajorAs: current });
  return latest && compareVersions(latest, current) > 0 ? latest : current;
}

export function newerMajor(catalog: ReleaseCatalog, current: string): string | null {
  const latest = latestVersion(catalog.versions);
  return latest && compareVersions(latest, current) > 0 && latest.split('.')[0] !== current.split('.')[0] ? latest : null;
}
