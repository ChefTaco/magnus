#!/usr/bin/env node
// Builds the release manifest that `@hivemagnus/magnus` publishes as
// `magnusRelease` (in packages/magnus/package.json) and checks it is current.
//
// Inputs:
//   - the root version and Node engines
//   - release/<version>.json (optional): summary, breaking, minUpgradeFrom,
//     newRequiredEnv, newOptionalEnv, removedEnv and migrations (names)
//   - services/control-api/prisma/migrations/<name>/magnus-impact.json
//     ({"impact":"fast|slow|one-way","note":"…"}; absent means fast)
//
// Checks: every new env name is documented in its component's env catalogue
// and in CHANGELOG.md under "### New environment variables"; every slow or
// one-way migration is described under "### Migration impact"; every
// migration after the baseline belongs to exactly one release file.
//
//   node scripts/check-release-manifest.mjs           check (CI)
//   node scripts/check-release-manifest.mjs --write   regenerate packages/magnus/package.json#magnusRelease
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Bumped when the upgrade engine's hand-over contract changes (see packages/magnus/src/release.ts). */
export const ENGINE_PROTOCOL = 1;
/** Agent self-upgrade wire protocol and the launcher it needs. */
export const AGENT_PROTOCOLS = { selfUpgradeProtocol: 1, minLauncher: 1 };
const COMPONENTS = ['@hivemagnus/magnus-server', '@hivemagnus/magnus-ui', '@hivemagnus/magnus-contracts', '@hivemagnus/magnus-agent'];
const MIGRATIONS = 'services/control-api/prisma/migrations';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function migrationImpact(root, name) {
  const path = join(root, MIGRATIONS, name, 'magnus-impact.json');
  if (!existsSync(path)) return { impact: 'fast', note: '' };
  const raw = readJson(path);
  if (!['fast', 'slow', 'one-way'].includes(raw.impact)) throw new Error(`${path}: impact must be fast, slow or one-way`);
  return { impact: raw.impact, note: typeof raw.note === 'string' ? raw.note : '' };
}

export function releaseFiles(root) {
  const dir = join(root, 'release');
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir).filter((file) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.json$/.test(file))
    .map((file) => [file.slice(0, -'.json'.length), readJson(join(dir, file))]));
}

export function buildManifest(root) {
  const rootPackage = readJson(join(root, 'package.json'));
  const version = rootPackage.version;
  const notes = releaseFiles(root).get(version) ?? {};
  const env = (list = []) => list.map((entry) => ({ name: entry.name, component: entry.component, secret: entry.secret === true, description: entry.description }));
  return {
    schema: 1,
    version,
    engines: { node: rootPackage.engines.node },
    components: Object.fromEntries(COMPONENTS.map((name) => [name, version])),
    breaking: notes.breaking === true,
    minUpgradeFrom: notes.minUpgradeFrom ?? '1.0.0',
    engineProtocol: ENGINE_PROTOCOL,
    newRequiredEnv: env(notes.newRequiredEnv),
    newOptionalEnv: env(notes.newOptionalEnv),
    removedEnv: (notes.removedEnv ?? []).map((entry) => ({ name: entry.name, component: entry.component, note: entry.note ?? '' })),
    migrations: (notes.migrations ?? []).map((name) => ({ name, ...migrationImpact(root, name) })),
    agent: { ...AGENT_PROTOCOLS },
    summary: notes.summary ?? '',
    notesUrl: `https://github.com/ChefTaco/magnus/releases/tag/v${version}`,
  };
}

async function documentedEnv(root) {
  const names = (file) => new Set([...readFileSync(join(root, file), 'utf8').matchAll(/name: '([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]));
  const { dashboardEnvironmentSchema } = await import(pathToFileURL(join(root, 'apps/dashboard/runtime-environment.mjs')).href);
  return {
    server: names('services/control-api/src/cli/env-catalog.ts'),
    agent: names('packages/agent/src/env-catalog.ts'),
    ui: new Set(Object.keys(dashboardEnvironmentSchema)),
  };
}

export function changelogSection(changelog, version) {
  const start = changelog.indexOf(`## [${version}]`);
  if (start < 0) return null;
  const next = changelog.indexOf('\n## [', start + 1);
  return changelog.slice(start, next < 0 ? undefined : next);
}

export async function checkRelease(root) {
  const problems = [];
  const manifest = buildManifest(root);
  const metaPath = join(root, 'packages/magnus/package.json');
  const meta = readJson(metaPath);
  if (!isDeepStrictEqual(meta.magnusRelease, manifest)) problems.push('packages/magnus/package.json#magnusRelease is out of date: run `npm run release:manifest`');

  const catalogues = await documentedEnv(root);
  for (const entry of [...manifest.newRequiredEnv, ...manifest.newOptionalEnv]) {
    const catalogue = catalogues[entry.component];
    if (catalogue && !catalogue.has(entry.name)) problems.push(`${entry.name} (${entry.component}) is not in that component's environment catalogue`);
  }
  const section = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), manifest.version);
  const newEnv = [...manifest.newRequiredEnv, ...manifest.newOptionalEnv];
  if (newEnv.length > 0 || manifest.migrations.some((m) => m.impact !== 'fast')) {
    if (!section) problems.push(`CHANGELOG.md has no "## [${manifest.version}]" section`);
    else {
      if (newEnv.length > 0 && !section.includes('### New environment variables')) problems.push(`CHANGELOG.md ${manifest.version} needs a "### New environment variables" heading`);
      for (const entry of newEnv) if (!section.includes(`\`${entry.name}\``)) problems.push(`CHANGELOG.md ${manifest.version} does not mention \`${entry.name}\``);
      const risky = manifest.migrations.filter((m) => m.impact !== 'fast');
      if (risky.length > 0 && !section.includes('### Migration impact')) problems.push(`CHANGELOG.md ${manifest.version} needs a "### Migration impact" heading for ${risky.map((m) => m.name).join(', ')}`);
    }
  }

  const migrations = existsSync(join(root, MIGRATIONS))
    ? readdirSync(join(root, MIGRATIONS), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  const owners = new Map();
  for (const [version, notes] of releaseFiles(root)) {
    for (const name of notes.migrations ?? []) {
      if (!migrations.includes(name)) problems.push(`release/${version}.json lists ${name}, which is not a migration`);
      if (owners.has(name)) problems.push(`${name} is listed by release/${owners.get(name)}.json and release/${version}.json`);
      owners.set(name, version);
    }
  }
  for (const name of migrations.slice(1)) {
    if (!owners.has(name)) problems.push(`migration ${name} is not listed in any release/<version>.json (add it to the release that ships it)`);
  }
  for (const name of migrations) migrationImpact(root, name);
  return { manifest, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = defaultRoot;
  try {
    if (process.argv.includes('--write')) {
      const path = join(root, 'packages/magnus/package.json');
      const meta = readJson(path);
      meta.magnusRelease = buildManifest(root);
      writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
      console.log(`Wrote magnusRelease ${meta.magnusRelease.version} to packages/magnus/package.json`);
    }
    const { manifest, problems } = await checkRelease(root);
    if (problems.length) {
      console.error(`Release manifest ${manifest.version}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`Release manifest ${manifest.version} is current (${manifest.migrations.length} migration(s), ${manifest.newRequiredEnv.length} new required setting(s)).`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
