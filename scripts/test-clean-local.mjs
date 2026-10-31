import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupCandidates, removeCandidates } from './clean-local.mjs';

test('cleanup preserves retained evidence, tracked files, dependencies, builds, and authentication', t => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-clean-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const disposable = ['.pytest_cache', 'scripts/__pycache__', 'apps/dashboard/test-results'];
  const protectedPaths = ['artifacts/release/__pycache__', 'output/ardent/__pycache__',
    'packages/ardent/state/__pycache__', 'apps/dashboard/.next/__pycache__',
    'scripts/node_modules/__pycache__', 'packages/ardent/test/fixtures/__pycache__',
    'apps/dashboard/tests/.auth', 'services/control-api/state', '.magnus', 'certs'];
  for (const path of [...disposable, ...protectedPaths]) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, 'retained'), 'keep');
  }
  const tracked = ['packages/ardent/test/fixtures/__pycache__/retained'];
  const candidates = cleanupCandidates(root, tracked);
  assert.deepEqual(new Set(candidates), new Set(disposable.map(path => join(root, path))));
  removeCandidates(root, candidates, tracked);
  for (const path of disposable) assert.equal(existsSync(join(root, path)), false);
  for (const path of protectedPaths) assert.equal(existsSync(join(root, path, 'retained')), true);
});

test('cleanup never traverses a linked workspace or cache', t => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-clean-'));
  const outside = mkdtempSync(join(tmpdir(), 'magnus-clean-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  mkdirSync(join(outside, '__pycache__'));
  writeFileSync(join(outside, '__pycache__', 'keep'), 'keep');
  mkdirSync(join(root, 'apps'));
  symlinkSync(outside, join(root, 'apps', 'linked'));
  symlinkSync(outside, join(root, '.pytest_cache'));
  assert.deepEqual(cleanupCandidates(root), []);
  assert.throws(() => removeCandidates(root, [join(outside, '__pycache__')]), /eligible/);
  assert.equal(existsSync(join(outside, '__pycache__', 'keep')), true);
});

test('cleanup rejects a cache replaced by a link after preview', t => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-clean-'));
  const outside = mkdtempSync(join(tmpdir(), 'magnus-clean-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const path = join(root, '.pytest_cache');
  mkdirSync(path);
  const candidates = cleanupCandidates(root);
  rmSync(path, { recursive: true });
  symlinkSync(outside, path);
  assert.throws(() => removeCandidates(root, candidates), /eligible/);
  assert.equal(existsSync(outside), true);
});

test('cleanup rejects a cache that acquired a tracked file after preview', t => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-clean-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pytest_cache'));
  const candidates = cleanupCandidates(root);
  writeFileSync(join(root, '.pytest_cache', 'source'), 'retain');
  assert.throws(() => removeCandidates(root, candidates, ['.pytest_cache/source']), /eligible/);
  assert.equal(existsSync(join(root, '.pytest_cache', 'source')), true);
});
