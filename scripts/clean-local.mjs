#!/usr/bin/env node
/** Remove only regenerable local caches and test reports, never release evidence. */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const caches = new Set(['__pycache__', '.pytest_cache']);
const reports = new Set(['test-results', 'playwright-report', 'playwright-report-ci', 'blob-report']);
const protectedDirectories = new Set(['node_modules', '.next', 'dist', 'out', 'artifacts',
  'output', 'state', 'audit-logs', '.magnus', '.git', '.hermes', '.ardent', '.codex',
  '.auth', '.playwright-cli', 'certs', 'grants', 'checkpoints', 'maintenance']);

function regularDirectory(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function cleanupCandidates(root, tracked = []) {
  root = resolve(root);
  const candidates = [];
  const add = path => {
    const name = relative(root, path).split('\\').join('/');
    if (!tracked.some(file => file === name || file.startsWith(`${name}/`))) candidates.push(path);
  };
  function visit(directory) {
    if (!regularDirectory(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (caches.has(entry.name)) add(path);
      else if (!protectedDirectories.has(entry.name) && !reports.has(entry.name)) visit(path);
    }
  }
  for (const name of caches) if (regularDirectory(join(root, name))) add(join(root, name));
  for (const scope of ['apps', 'services', 'packages', 'scripts']) visit(join(root, scope));
  // Test reports are accepted only at the root or directly inside a workspace.
  for (const base of [root, ...['apps', 'services', 'packages'].flatMap(scope => {
    const path = join(root, scope);
    return regularDirectory(path) ? readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => join(path, entry.name)) : [];
  })]) {
    for (const name of reports) if (regularDirectory(join(base, name))) add(join(base, name));
  }
  return [...new Set(candidates)].sort();
}

export function removeCandidates(root, candidates, tracked = []) {
  root = resolve(root);
  // Re-discover allowed paths immediately before deletion. Arbitrary caller paths
  // and caches newly containing tracked files cannot become cleanup targets.
  const allowed = new Set(cleanupCandidates(root, tracked));
  for (const path of candidates) {
    if (!allowed.has(path)) throw new Error('Cleanup target is no longer eligible');
    let parent = path;
    while (parent !== root) {
      if (!regularDirectory(parent)) throw new Error('Unsafe cleanup directory');
      parent = resolve(parent, '..');
    }
    rmSync(path, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--apply', '--help'].includes(arg))) {
    throw new Error('Usage: npm run clean:local -- [--apply|--help]');
  }
  if (args[0] === '--help') {
    console.log('Preview Python caches and test reports with npm run clean:local; remove with --apply.');
  } else {
    const root = resolve(import.meta.dirname, '..');
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
    const candidates = cleanupCandidates(root, tracked);
    for (const path of candidates) console.log(relative(root, path));
    if (args[0] === '--apply') {
      const currentTracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
      removeCandidates(root, candidates, currentTracked);
    }
    console.log(`${args[0] === '--apply' ? 'Removed' : 'Would remove'} ${candidates.length} generated directories.`);
  }
}
