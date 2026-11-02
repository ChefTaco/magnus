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
  readPackument,
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

/**
 * Upgrade-engine protocol; a newer target engine takes over migrate and switch.
 * 2: the in-progress journal, lock hand-over (MAGNUS_LOCK_TOKEN) and the
 * clean-schema restore.
 */
export const ENGINE_PROTOCOL = 2;

/** First release whose meta package carries a manifest; older ones get a synthetic one. */
export const MANIFEST_SINCE = '1.1.0';

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
  /** Versions whose manifest exists but is newer than this engine understands. */
  unparsable?: Set<string>;
  deprecated?: Set<string>;
  /** The registry's `latest` dist-tag: automatic targets never go past it. */
  latest?: string | null;
}

export class TooOldError extends Error {}

export const TOO_OLD_HINT = 'this engine is too old to read it; run the newest one: npx @hivemagnus/magnus@latest upgrade';

/**
 * The registry to use: --registry, MAGNUS_UPDATE_REGISTRY, then npm's own
 * configuration (.npmrc), then the public registry.
 */
export async function resolveRegistry(io: Io, explicit: string | undefined, npm: () => Promise<string | null> = () => npmConfigRegistry(io)): Promise<string> {
  const chosen = explicit ?? io.env['MAGNUS_UPDATE_REGISTRY']?.trim();
  if (chosen) return chosen;
  return (await npm().catch(() => null)) || 'https://registry.npmjs.org';
}

async function npmConfigRegistry(io: Io): Promise<string | null> {
  const result = await io.run('npm', ['config', 'get', 'registry'], { capture: true });
  const value = result.code === 0 ? result.stdout.trim() : '';
  return /^https?:\/\//.test(value) ? value : null;
}

export async function fetchRegistryCatalog(io: Io, registry: string, packageName = META_PACKAGE): Promise<ReleaseCatalog> {
  const url = `${registry.replace(/\/+$/, '')}/${packageName.replace('/', '%2f')}`;
  let response: Response;
  try {
    // The full document: the abbreviated install format drops custom fields.
    response = await io.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    const proxy = io.env['HTTPS_PROXY'] || io.env['https_proxy'] || io.env['HTTP_PROXY'] || io.env['http_proxy'];
    throw new Error(`Cannot reach the npm registry (${url}): ${error instanceof Error ? error.message : String(error)}`
      + `${proxy && !io.env['NODE_USE_ENV_PROXY'] ? '. A proxy is configured: run with NODE_USE_ENV_PROXY=1 so Node.js uses it.' : ''}`);
  }
  if (response.status === 404) {
    throw new Error(`The registry ${registry} has no ${packageName} (404 for ${url}). Check --registry or MAGNUS_UPDATE_REGISTRY, or use --source with packed tarballs.`);
  }
  if (!response.ok) throw new Error(`The npm registry answered ${response.status} for ${url}`);
  const packument = await response.json() as { versions?: Record<string, unknown> };
  const read = readPackument(packument);
  return {
    versions: Object.keys(packument.versions ?? {}),
    manifests: new Map(read.manifests.map((m) => [m.version, m])),
    tarballs: new Map(),
    unparsable: new Set(read.unparsable),
    deprecated: new Set(read.deprecated),
    latest: read.latest,
  };
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
  const unparsable = new Set<string>();
  const versions: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.tgz')).sort()) {
    const path = join(dir, file);
    const { stdout } = await mustRun(io, 'tar', ['-xzOf', path, 'package/package.json'], { capture: true });
    const pkg = JSON.parse(stdout) as { name: string; version: string; magnusRelease?: unknown };
    tarballs.set(`${pkg.name}@${pkg.version}`, path);
    if (pkg.name === META_PACKAGE) {
      versions.push(pkg.version);
      if (pkg.magnusRelease === undefined) continue;
      const parsed = releaseManifestSchema.safeParse(pkg.magnusRelease);
      if (parsed.success) manifests.set(pkg.version, parsed.data);
      else unparsable.add(pkg.version);
    }
  }
  return { versions, manifests, tarballs, unparsable };
}

/** Registry history plus local tarballs; local entries win. The registry is optional here. */
export async function sourceCatalog(io: Io, sourceDir: string, registry: string): Promise<ReleaseCatalog> {
  const local = await readSourceCatalog(io, sourceDir);
  const remote = await fetchRegistryCatalog(io, registry).catch(() => null);
  if (!remote) return local;
  const unparsable = new Set([...(remote.unparsable ?? [])].filter((version) => !local.manifests.has(version)));
  for (const version of local.unparsable ?? []) unparsable.add(version);
  return {
    versions: [...new Set([...remote.versions, ...local.versions])],
    manifests: new Map([...remote.manifests, ...local.manifests]),
    tarballs: local.tarballs,
    unparsable,
    deprecated: remote.deprecated,
    // Local tarballs are what the operator asked for; the registry tag does not cap them.
    latest: null,
  };
}

/**
 * The manifest for a version. Releases before the meta package existed
 * (1.0.x) have none: their components share the release version and this
 * engine drives them. A later release without a readable manifest is never
 * guessed at: its manifest is newer than this engine, or the release is broken.
 */
export function releaseFor(catalog: ReleaseCatalog, version: string): ReleaseManifest {
  const found = catalog.manifests.get(version);
  if (found) return found;
  if (catalog.unparsable?.has(version)) throw new TooOldError(`The release manifest of ${version} uses a newer format: ${TOO_OLD_HINT}`);
  if (compareVersions(version, MANIFEST_SINCE) >= 0) {
    throw new TooOldError(`${META_PACKAGE}@${version} has no release manifest this engine can read; ${TOO_OLD_HINT}`);
  }
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
  const latest = latestVersion(automaticCandidates(catalog), { sameMajorAs: current });
  return latest && compareVersions(latest, current) > 0 ? latest : current;
}

/** Versions an automatic upgrade may pick: not deprecated, and not past dist-tags.latest. */
export function automaticCandidates(catalog: ReleaseCatalog): string[] {
  const cap = catalog.latest;
  return catalog.versions.filter((version) => !catalog.deprecated?.has(version)
    && (!cap || compareVersions(version, cap) <= 0));
}

export function newerMajor(catalog: ReleaseCatalog, current: string): string | null {
  const latest = latestVersion(automaticCandidates(catalog));
  return latest && compareVersions(latest, current) > 0 && latest.split('.')[0] !== current.split('.')[0] ? latest : null;
}
