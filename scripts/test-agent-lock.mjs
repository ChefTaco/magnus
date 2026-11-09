import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertAgentContractsIntegrity, refreshAgentLock } from './refresh-agent-lock.mjs';

const repo = resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'magnus-agent-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['package-lock.json', 'packages/agent/npm-shrinkwrap.json',
    ...['apps/dashboard', 'services/control-api', 'services/fleet-gateway', 'packages/agent', 'packages/contracts', 'packages/oathweave', 'packages/skills'].map(p => `${p}/package.json`)]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    cpSync(join(repo, path), join(root, path));
  }
  return root;
}
function run(root) { return spawnSync(process.execPath, [join(repo, 'scripts/validate-lockfile.mjs')], { cwd: root, encoding: 'utf8' }); }
function mutate(root, change) {
  const path = join(root, 'packages/agent/npm-shrinkwrap.json');
  const lock = JSON.parse(readFileSync(path));
  change(lock);
  writeFileSync(path, JSON.stringify(lock));
}
test('the packaged agent graph is closed and integrity-bearing', t => {
  const root = fixture(t);
  assert.equal(run(root).status, 0);
  mutate(root, lock => { delete lock.packages['node_modules/hono'].integrity; });
  assert.notEqual(run(root).status, 0);
});
test('a workspace link cannot replace a pinned registry dependency', t => {
  const root = fixture(t);
  mutate(root, lock => { lock.packages['node_modules/hono'].link = true; });
  assert.notEqual(run(root).status, 0);
});
test('changed agent declarations and versions require a reviewed lock refresh', t => {
  const root = fixture(t);
  mutate(root, lock => { lock.version = '9.9.9'; lock.packages[''].dependencies.hono = '*'; });
  assert.notEqual(run(root).status, 0);
});

test('a release bump pins the exact locally built contracts bytes before registry publication', t => {
  const root = fixture(t);
  for (const name of ['agent', 'contracts']) {
    const file = join(root, `packages/${name}/package.json`);
    const manifest = JSON.parse(readFileSync(file));
    manifest.version = '9.9.9';
    if (name === 'agent') manifest.dependencies['@hivemagnus/magnus-contracts'] = '9.9.9';
    writeFileSync(file, JSON.stringify(manifest));
  }
  assert.equal(refreshAgentLock(root), true);
  const lock = JSON.parse(readFileSync(join(root, 'packages/agent/npm-shrinkwrap.json')));
  const entry = lock.packages['node_modules/@hivemagnus/magnus-contracts'];
  assert.equal(lock.version, '9.9.9');
  assert.equal(entry.version, '9.9.9');
  assert.match(entry.resolved, /magnus-contracts-9\.9\.9\.tgz$/);
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(refreshAgentLock(root), false);
});


test('same-version contract rebuilds refresh the lock and publication rejects stale bytes', t => {
  const root = fixture(t);
  const directory = join(root, 'packages/contracts/dist');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'index.js'), 'export const example = 1;\n');
  assert.equal(refreshAgentLock(root), true);
  assert.doesNotThrow(() => assertAgentContractsIntegrity(root));
  assert.equal(refreshAgentLock(root), false);
  writeFileSync(join(directory, 'index.js'), 'export const example = 2;\n');
  assert.throws(() => assertAgentContractsIntegrity(root), /does not pin the contracts tarball/);
  assert.equal(refreshAgentLock(root), true);
  assert.doesNotThrow(() => assertAgentContractsIntegrity(root));
  assert.equal(refreshAgentLock(root), false);
});
