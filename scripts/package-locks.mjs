#!/usr/bin/env node
// The standalone npm-shrinkwrap.json files of the server and console packages.
//
// A published package's own overrides and the workspace lock never reach a consumer: `npm install
// @hivemagnus/magnus-server` would resolve every semver range again (in 3.1.5 that brought back
// the effect release the server's override exists to avoid). A shrinkwrap in the tarball pins the
// whole graph for the image build and for a native npm install alike.
//
//   node scripts/package-locks.mjs --generate [server|ui]  regenerate from the workspace lock (network; review the diff)
//   node scripts/package-locks.mjs --refresh  [server|ui]  version-only update from the local packs (offline)
//   node scripts/package-locks.mjs --check    [server|ui]  fail when a lock is stale or does not honour the overrides
//
// Generation seeds a disposable standalone project with the versions the workspace lock (and so CI)
// resolved, lets npm prune and complete that graph for the package alone, and records the sibling
// workspace packages by their public registry URL and the SHA-512 of their local pack, as the
// agent's lock does. The server's bundled Oathweave package stays `inBundle`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org/';
export const LOCKED = {
  server: { directory: 'services/control-api', siblings: ['packages/contracts', 'packages/skills'] },
  // The console compiles the contracts into its build; it lists them as a development dependency.
  ui: { directory: 'apps/dashboard', siblings: ['packages/contracts'] },
};
export const SHRINKWRAP = 'npm-shrinkwrap.json';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeLock = (path, lock) => writeFileSync(path, JSON.stringify(lock, null, 2) + '\n');
export const registryUrl = (name, version) => `${REGISTRY}${name}/-/${name.split('/').at(-1)}-${version}.tgz`;

/** Packs a workspace without scripts; returns its manifest, tarball path and SHA-512 integrity. */
export function packWorkspace(directory, destination) {
  const [report] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: directory, encoding: 'utf8' }));
  const file = join(destination, report.filename);
  return { manifest: readJson(join(directory, 'package.json')), file,
    integrity: 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64') };
}

/** `node_modules/a/node_modules/@s/b` → `@s/b`. */
export const entryName = (path) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
/** `node_modules/a/node_modules/@s/b` → `node_modules/a`; top-level entries have the root ('') as parent. */
export const entryParent = (path) => path.replace(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/u, '');

/** The lock path Node would load `name` from when `from` (a lock path, '' for the root) requires it. */
export function resolveInLock(packages, from, name) {
  for (let base = from; ; base = entryParent(base)) {
    const candidate = `${base ? base + '/' : ''}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
  }
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * Every exact override in `overrides` that the lock does not honour. `{name: "1.2.3"}` holds for
 * every copy of name; `{parent: {child: "1.2.3"}}` for the child each copy of parent loads;
 * `{name: {".": "1.2.3"}}` for name itself. References ("$x") and ranges are not checked.
 */
export function overrideProblems(lock, overrides) {
  const packages = lock.packages ?? {};
  const paths = Object.keys(packages).filter(Boolean);
  const problems = [];
  const expect = (path, version, rule) => {
    if (packages[path]?.version !== version) problems.push(`${path} is ${packages[path]?.version ?? 'missing'}, but the override ${rule} requires ${version}`);
  };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    const copies = paths.filter((path) => entryName(path) === name && !packages[path].link);
    if (typeof value === 'string') {
      if (EXACT.test(value)) for (const path of copies) expect(path, value, name);
      continue;
    }
    for (const [child, version] of Object.entries(value ?? {})) {
      if (typeof version !== 'string' || !EXACT.test(version)) continue;
      if (child === '.') { for (const path of copies) expect(path, version, `${name}@.`); continue; }
      for (const parent of copies) {
        if (!packages[parent].dependencies?.[child] && !packages[parent].optionalDependencies?.[child]) continue;
        const path = resolveInLock(packages, parent, child);
        if (path) expect(path, version, `${name} > ${child}`);
      }
    }
  }
  return problems;
}

/** Structural problems: a registry artifact with an exact version, a public URL and a SHA-512 integrity. */
export function artifactProblems(lock, manifest) {
  const problems = [];
  const root = lock.packages?.[''];
  if (lock.lockfileVersion !== 3 || lock.name !== manifest.name || lock.version !== manifest.version || root?.name !== manifest.name ||
      root?.version !== manifest.version || JSON.stringify(root?.dependencies) !== JSON.stringify(manifest.dependencies))
    problems.push(`${manifest.name} shrinkwrap differs from its manifest; refresh it, or regenerate and review it after dependency changes`);
  const bundled = new Set(manifest.bundleDependencies ?? []);
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    if (entry.inBundle) {
      // A top-level entry is in this package's own tarball only when the manifest bundles it; a
      // nested one is a dependency's bundle, carried by that dependency's tarball.
      if (entryParent(path) === '' && !bundled.has(entryName(path))) problems.push(`${manifest.name} shrinkwrap ${path}: only a declared bundled dependency may be inBundle`);
      continue;
    }
    if (entry.link || !entry.version || !entry.resolved?.startsWith(REGISTRY) || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity ?? ''))
      problems.push(`${manifest.name} shrinkwrap ${path}: registry artifact must have an exact version, public URL and sha512 integrity`);
  }
  return problems;
}

const dependencyField = (manifest, name) => (manifest.dependencies?.[name] !== undefined ? 'dependencies' : 'devDependencies');

function siblingPacks(root, target, destination) {
  return LOCKED[target].siblings.map((directory) => packWorkspace(join(root, directory), destination));
}

/** The standalone project's starting lock: the workspace lock's versions, rebased onto the package. */
export function seedLock(workspaceLock, directory, manifest, bundledManifests) {
  const packages = {};
  for (const [path, entry] of Object.entries(workspaceLock.packages)) {
    if (path.startsWith('node_modules/') && !entry.link) packages[path] = entry;
  }
  // The package's own node_modules win over the hoisted root copies, as they do for Node.
  for (const [path, entry] of Object.entries(workspaceLock.packages)) {
    if (path.startsWith(`${directory}/node_modules/`)) packages[path.slice(directory.length + 1)] = entry;
  }
  for (const path of Object.keys(packages)) if (/^node_modules\/@hivemagnus\/magnus-/u.test(path)) delete packages[path];
  for (const bundled of bundledManifests) {
    packages[`node_modules/${bundled.name}`] = { version: bundled.version, inBundle: true, license: bundled.license,
      ...(bundled.engines ? { engines: bundled.engines } : {}), ...(bundled.dependencies ? { dependencies: bundled.dependencies } : {}),
      ...(bundled.peerDependencies ? { peerDependencies: bundled.peerDependencies } : {}) };
  }
  packages[''] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies };
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages };
}

/** Regenerates one package's shrinkwrap. Needs the npm registry; review the diff it leaves. */
export function generateLock(root, target) {
  const { directory } = LOCKED[target];
  const manifest = readJson(join(root, directory, 'package.json'));
  const work = mkdtempSync(join(tmpdir(), `magnus-${target}-lock-`));
  try {
    const packs = join(work, 'packs');
    mkdirSync(packs);
    const siblings = siblingPacks(root, target, packs);
    const project = join(work, 'package');
    mkdirSync(project);
    const standalone = structuredClone(manifest);
    delete standalone.scripts;
    for (const sibling of siblings) {
      const field = dependencyField(manifest, sibling.manifest.name);
      assert.equal(standalone[field][sibling.manifest.name], sibling.manifest.version, `Build the exact ${sibling.manifest.name} version ${manifest.name} pins`);
      standalone[field][sibling.manifest.name] = `file:${sibling.file}`;
    }
    const bundledManifests = (manifest.bundleDependencies ?? []).map((name) => {
      const source = join(root, 'node_modules', name);
      const copy = join(project, 'node_modules', name);
      mkdirSync(copy, { recursive: true });
      cpSync(join(source, 'package.json'), join(copy, 'package.json'));
      return readJson(join(source, 'package.json'));
    });
    writeFileSync(join(project, 'package.json'), JSON.stringify(standalone, null, 2) + '\n');
    const seed = seedLock(readJson(join(root, 'package-lock.json')), directory, standalone, bundledManifests);
    writeLock(join(project, 'package-lock.json'), seed);
    for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(work, name), '');
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
      `--registry=${REGISTRY}`, `--userconfig=${join(work, 'user.npmrc')}`, `--globalconfig=${join(work, 'global.npmrc')}`],
    { cwd: project, stdio: ['ignore', 'inherit', 'inherit'], timeout: 600_000 });
    const lock = readJson(join(project, 'package-lock.json'));
    // npm marks the peers of a bundled package inBundle too, although the tarball carries only the
    // bundled package itself; a consumer install would then never fetch them. They are ordinary
    // registry dependencies of the server, pinned with the seed's URL and integrity.
    const declared = new Set((manifest.bundleDependencies ?? []).map((name) => `node_modules/${name}`));
    for (const [path, entry] of Object.entries(lock.packages)) {
      // Below the top level, inBundle is a dependency's own bundle, which its tarball does carry.
      if (!entry.inBundle || declared.has(path) || entryParent(path) !== '') continue;
      const seeded = seed.packages[path];
      assert(seeded?.version === entry.version && seeded.resolved && seeded.integrity, `${path} is marked bundled but has no registry artifact to pin`);
      delete entry.inBundle;
      lock.packages[path] = { version: entry.version, resolved: seeded.resolved, integrity: seeded.integrity, ...entry };
    }
    for (const sibling of siblings) {
      const entry = lock.packages[`node_modules/${sibling.manifest.name}`];
      assert(entry, `The generated lock must include ${sibling.manifest.name}`);
      assert.equal(entry.integrity, sibling.integrity);
      entry.resolved = registryUrl(sibling.manifest.name, sibling.manifest.version);
    }
    lock.name = manifest.name;
    lock.version = manifest.version;
    lock.packages[''] = { ...lock.packages[''], name: manifest.name, version: manifest.version, dependencies: manifest.dependencies,
      ...(manifest.devDependencies ? { devDependencies: manifest.devDependencies } : {}) };
    const problems = [...artifactProblems(lock, manifest), ...overrideProblems(lock, manifest.overrides)];
    assert.deepEqual(problems, [], 'The generated lock is not publishable');
    writeLock(join(root, directory, SHRINKWRAP), lock);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Brings a lock up to the package's version and the local packs of its siblings and bundled
 * packages, without npm. Any other dependency change needs `--generate` and a review.
 */
export function refreshLock(root, target, { write = true, packs } = {}) {
  const { directory } = LOCKED[target];
  const path = join(root, directory, SHRINKWRAP);
  const manifest = readJson(join(root, directory, 'package.json'));
  const lock = readJson(path);
  const before = JSON.stringify(lock);
  const work = packs ? undefined : mkdtempSync(join(tmpdir(), `magnus-${target}-packs-`));
  try {
    const siblings = packs ?? siblingPacks(root, target, work);
    // Only the versions of the sibling and bundled packages may move without a regeneration.
    const moving = [...siblings.map((sibling) => sibling.manifest.name), ...(manifest.bundleDependencies ?? [])];
    for (const field of ['dependencies', 'devDependencies']) {
      const previous = { ...lock.packages[''][field] };
      for (const name of moving) if (manifest[field]?.[name] !== undefined) previous[name] = manifest[field][name];
      assert.deepEqual(previous, manifest[field] ?? {}, `${manifest.name} ${field} changed: regenerate and review its shrinkwrap (npm run locks:generate)`);
    }
    for (const sibling of siblings) {
      const entry = lock.packages[`node_modules/${sibling.manifest.name}`];
      assert(entry, `${manifest.name} shrinkwrap must include ${sibling.manifest.name}`);
      assert.deepEqual(entry.dependencies ?? {}, sibling.manifest.dependencies ?? {}, `${sibling.manifest.name} dependencies changed: regenerate and review the ${manifest.name} shrinkwrap`);
      Object.assign(entry, { version: sibling.manifest.version, resolved: registryUrl(sibling.manifest.name, sibling.manifest.version), integrity: sibling.integrity });
    }
    for (const name of manifest.bundleDependencies ?? []) {
      const bundled = readJson(join(root, 'node_modules', name, 'package.json'));
      // Inside a shrinkwrapped install npm treats whatever a bundled package depends on, peers
      // included, as part of the bundle, so it would never install them.
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'])
        assert(!Object.keys(bundled[field] ?? {}).length, `${name} is bundled into ${manifest.name} and must declare no ${field}; the consumer depends on them directly`);
      const entry = lock.packages[`node_modules/${name}`];
      assert(entry?.inBundle, `${manifest.name} shrinkwrap must list ${name} as bundled`);
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'])
        assert(!entry[field], `${manifest.name} shrinkwrap lists ${field} for bundled ${name}: regenerate it`);
      entry.version = bundled.version;
    }
    lock.name = manifest.name;
    lock.version = manifest.version;
    Object.assign(lock.packages[''], { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies,
      ...(manifest.devDependencies ? { devDependencies: manifest.devDependencies } : {}) });
    const changed = JSON.stringify(lock) !== before;
    if (changed && write) writeLock(path, lock);
    return { changed, lock, manifest };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

/** Every reason the committed lock is not what would be published. */
export function lockProblems(root, target, options) {
  let result;
  try {
    result = refreshLock(root, target, { ...options, write: false });
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const { changed, lock, manifest } = result;
  return [
    ...(changed ? [`${manifest.name} shrinkwrap is stale: run npm run locks:refresh after building the workspace packages`] : []),
    ...artifactProblems(lock, manifest),
    ...overrideProblems(lock, manifest.overrides),
  ];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(import.meta.dirname, '..');
  const [mode, ...names] = process.argv.slice(2);
  const targets = names.length ? names : Object.keys(LOCKED);
  for (const target of targets) if (!LOCKED[target]) throw new Error(`Unknown package ${target}; use ${Object.keys(LOCKED).join(' or ')}`);
  if (mode === '--generate') for (const target of targets) generateLock(root, target);
  else if (mode === '--refresh') for (const target of targets) refreshLock(root, target);
  else if (mode === '--check') {
    const problems = targets.flatMap((target) => lockProblems(root, target));
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log(`Package locks: ${targets.join(', ')} current, published URLs and integrities, overrides honoured`);
  } else throw new Error('Use --generate, --refresh or --check');
}
