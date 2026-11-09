// Freeze the exact locally built contracts tarball, including same-version rebuilds.
// All other dependency changes require an explicit, reviewed standalone lock refresh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function contractsIntegrity(root) {
  const directory = mkdtempSync(join(tmpdir(), 'magnus-contracts-lock-'));
  try {
    const report = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: join(root, 'packages/contracts'), encoding: 'utf8' }));
    return 'sha512-' + createHash('sha512').update(readFileSync(join(directory, report[0].filename))).digest('base64');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function assertAgentContractsIntegrity(root) {
  const lock = JSON.parse(readFileSync(join(root, 'packages/agent/npm-shrinkwrap.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@hivemagnus/magnus-contracts'].integrity, contractsIntegrity(root),
    'Agent lock does not pin the contracts tarball being published; rebuild the agent and review its lock');
}

export function refreshAgentLock(root) {
  const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const manifest = read('packages/agent/package.json');
  const contracts = read('packages/contracts/package.json');
  const lock = read('packages/agent/npm-shrinkwrap.json');
  const name = contracts.name;
  assert.equal(manifest.dependencies[name], contracts.version, 'Build the exact contracts version selected by the agent');
  const previous = { ...lock.packages[''].dependencies };
  previous[name] = manifest.dependencies[name];
  assert.deepEqual(previous, manifest.dependencies, 'Regenerate and review the standalone agent lock after dependency changes');
  const entry = lock.packages[`node_modules/${name}`];
  assert(entry, 'The standalone lock must include contracts');
  assert.deepEqual(entry.dependencies ?? {}, contracts.dependencies ?? {}, 'Regenerate and review the standalone graph when contracts dependencies change');
  let changed = false;
  const integrity = contractsIntegrity(root);
  if (entry.version !== contracts.version || entry.integrity !== integrity) {
    entry.version = contracts.version;
    entry.resolved = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${contracts.version}.tgz`;
    entry.integrity = integrity;
    entry.dependencies = contracts.dependencies;
    changed = true;
  }
  if (lock.version !== manifest.version || lock.packages[''].version !== manifest.version || changed) {
    lock.version = manifest.version;
    Object.assign(lock.packages[''], { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies });
    writeFileSync(join(root, 'packages/agent/npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n');
    changed = true;
  }
  return changed;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(import.meta.dirname, '..');
  if (process.argv.includes('--check')) assertAgentContractsIntegrity(root);
  else refreshAgentLock(root);
}
