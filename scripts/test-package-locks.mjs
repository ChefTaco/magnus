import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOCKED, SHRINKWRAP, artifactProblems, entryName, entryParent, lockProblems, overrideProblems, refreshLock, resolveInLock, seedLock } from './package-locks.mjs';

const repo = resolve(import.meta.dirname, '..');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const artifact = (name, version) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`, integrity: `sha512-${'A'.repeat(86)}==` });

test('lock paths name the package and its parent', () => {
  assert.equal(entryName('node_modules/a/node_modules/@s/b'), '@s/b');
  assert.equal(entryParent('node_modules/a/node_modules/@s/b'), 'node_modules/a');
  assert.equal(entryParent('node_modules/@s/b'), '');
  const packages = { 'node_modules/a': {}, 'node_modules/a/node_modules/b': {}, 'node_modules/b': {}, 'node_modules/c': {} };
  assert.equal(resolveInLock(packages, 'node_modules/a', 'b'), 'node_modules/a/node_modules/b');
  assert.equal(resolveInLock(packages, 'node_modules/c', 'b'), 'node_modules/b');
  assert.equal(resolveInLock(packages, '', 'missing'), null);
});

test('an override the lock does not honour is reported, as the 3.1.5 native install would have been', () => {
  const lock = { packages: {
    '': {},
    'node_modules/@prisma/config': { version: '7.10.1', dependencies: { effect: '3.20.0' } },
    'node_modules/effect': { version: '3.20.0' },
    'node_modules/fast-uri': { version: '3.1.9' },
  } };
  const overrides = { '@prisma/config': { effect: '3.22.1' }, 'fast-uri': '3.1.9', typescript: '$typescript', other: '^1.0.0' };
  assert.deepEqual(overrideProblems(lock, overrides), ['node_modules/effect is 3.20.0, but the override @prisma/config > effect requires 3.22.1']);
  lock.packages['node_modules/effect'].version = '3.22.1';
  assert.deepEqual(overrideProblems(lock, overrides), []);
  // A nested copy is the one @prisma/config loads, so it is the one that must be pinned.
  lock.packages['node_modules/@prisma/config/node_modules/effect'] = { version: '3.20.0' };
  assert.equal(overrideProblems(lock, overrides).length, 1);
});

test('every shipped lock entry is a pinned public registry artifact, and only declared bundles are inBundle', () => {
  const manifest = { name: '@hivemagnus/fixture', version: '1.0.0', dependencies: { a: '^1.0.0', b: '1.0.0' }, bundleDependencies: ['b'] };
  const lock = { name: manifest.name, version: '1.0.0', lockfileVersion: 3, packages: {
    '': { name: manifest.name, version: '1.0.0', dependencies: manifest.dependencies },
    'node_modules/a': artifact('a', '1.2.0'),
    'node_modules/b': { version: '1.0.0', inBundle: true },
    'node_modules/a/node_modules/c': { version: '2.0.0', inBundle: true },
  } };
  assert.deepEqual(artifactProblems(lock, manifest), []);
  lock.packages['node_modules/d'] = { version: '1.0.0', inBundle: true };
  lock.packages['node_modules/e'] = { ...artifact('e', '1.0.0'), resolved: 'file:../e.tgz' };
  lock.packages['node_modules/f'] = { version: '1.0.0', link: true, resolved: 'packages/f' };
  assert.equal(artifactProblems(lock, manifest).length, 3);
  assert.match(artifactProblems({ ...lock, version: '2.0.0' }, manifest)[0], /differs from its manifest/);
});

test('the seed takes the workspace versions, with the package\'s own node_modules first and workspace links dropped', () => {
  const workspace = { packages: {
    '': {},
    'node_modules/x': { version: '1.0.0' },
    'node_modules/@hivemagnus/magnus-contracts': { link: true, resolved: 'packages/contracts' },
    'node_modules/@hivemagnus/magnus-skills': { version: '1.0.0' },
    'services/control-api/node_modules/x': { version: '2.0.0' },
    'packages/contracts': { version: '1.0.0' },
  } };
  const seed = seedLock(workspace, 'services/control-api', { name: 's', version: '1.0.0', dependencies: { x: '2' } },
    [{ name: '@hivemagnus/b', version: '1.0.0', license: 'MIT' }]);
  assert.deepEqual(Object.keys(seed.packages).sort(), ['', 'node_modules/@hivemagnus/b', 'node_modules/x']);
  assert.equal(seed.packages['node_modules/x'].version, '2.0.0');
  assert.equal(seed.packages['node_modules/@hivemagnus/b'].inBundle, true);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'magnus-package-locks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const { directory } of Object.values(LOCKED))
    for (const file of ['package.json', SHRINKWRAP]) {
      mkdirSync(join(root, directory), { recursive: true });
      cpSync(join(repo, directory, file), join(root, directory, file));
    }
  const oathweave = read(join(repo, 'packages/oathweave/package.json'));
  mkdirSync(join(root, 'node_modules/@hivemagnus/magnus-oathweave'), { recursive: true });
  writeFileSync(join(root, 'node_modules/@hivemagnus/magnus-oathweave/package.json'), JSON.stringify(oathweave));
  return root;
}
/** Stand-ins for the local packs, at the versions and integrities the committed locks record. */
function packsFor(root, target, version) {
  const lock = read(join(root, LOCKED[target].directory, SHRINKWRAP));
  return LOCKED[target].siblings.map((directory) => {
    const manifest = read(join(repo, directory, 'package.json'));
    const entry = lock.packages[`node_modules/${manifest.name}`];
    return { manifest: { ...manifest, version: version ?? manifest.version }, integrity: entry.integrity };
  });
}

test('the committed server and console locks are current', (t) => {
  const root = fixture(t);
  for (const target of Object.keys(LOCKED)) assert.deepEqual(lockProblems(root, target, { packs: packsFor(root, target) }), [], target);
});

test('a release bump is a version-only refresh; any other dependency change needs a regeneration', (t) => {
  const root = fixture(t);
  const path = join(root, LOCKED.server.directory, 'package.json');
  const manifest = read(path);
  manifest.version = '9.8.7';
  for (const name of ['@hivemagnus/magnus-contracts', '@hivemagnus/magnus-skills']) manifest.dependencies[name] = '9.8.7';
  writeFileSync(path, JSON.stringify(manifest));
  assert.match(lockProblems(root, 'server', { packs: packsFor(root, 'server', '9.8.7') })[0], /stale/);
  const { changed, lock } = refreshLock(root, 'server', { packs: packsFor(root, 'server', '9.8.7') });
  assert.equal(changed, true);
  assert.equal(lock.version, '9.8.7');
  assert.equal(lock.packages['node_modules/@hivemagnus/magnus-contracts'].resolved,
    'https://registry.npmjs.org/@hivemagnus/magnus-contracts/-/magnus-contracts-9.8.7.tgz');
  assert.deepEqual(lockProblems(root, 'server', { packs: packsFor(root, 'server', '9.8.7') }), []);

  manifest.dependencies.jose = '^7.0.0';
  writeFileSync(path, JSON.stringify(manifest));
  assert.match(lockProblems(root, 'server', { packs: packsFor(root, 'server', '9.8.7') })[0], /regenerate/);
});

test('a bundled package that declares peers is refused: a shrinkwrapped install would never fetch them', (t) => {
  const root = fixture(t);
  const path = join(root, 'node_modules/@hivemagnus/magnus-oathweave/package.json');
  writeFileSync(path, JSON.stringify({ ...read(path), peerDependencies: { jose: '^6.0.0' } }));
  assert.match(lockProblems(root, 'server', { packs: packsFor(root, 'server') })[0], /must declare no peerDependencies/);
});
