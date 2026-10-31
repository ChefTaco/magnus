#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIRECTORIES = [
  'packages/contracts', 'packages/skills', 'packages/ardent', 'packages/agent',
  'services/control-api', 'apps/dashboard',
];

export function readReleasePackages(root) {
  const packages = PACKAGE_DIRECTORIES.map(directory => ({
    ...JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')), directory,
  }));
  const version = packages[0].version;
  const rootVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    || rootVersion !== version || packages.some(pkg => pkg.version !== version || pkg.private || pkg.publishConfig?.access !== 'public')) {
    throw new Error('Every release package must have the same valid version and public publication settings');
  }
  const names = new Set(packages.map(pkg => pkg.name));
  for (const pkg of packages) {
    for (const category of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, dependencyVersion] of Object.entries(pkg[category] ?? {})) {
        if (names.has(name) && dependencyVersion !== version) throw new Error(`${pkg.name} must depend on ${name}@${version}`);
      }
    }
  }
  const agentVersion = JSON.parse(readFileSync(join(root, 'services/control-api/agent-version.json'), 'utf8')).version;
  if (agentVersion !== version) throw new Error(`The server's bundled agent version must be ${version}`);
  return packages;
}

export async function publishedVersionExists(name, version, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Could not check ${name}@${version} on npm (HTTP ${response.status}); publication stopped`);
  const metadata = await response.json();
  if (metadata.name !== name || metadata.version !== version) throw new Error(`Unexpected npm metadata for ${name}@${version}; publication stopped`);
  return true;
}

export async function publishPackages({ root, dryRun, ref, fetcher = fetch, run = execFileSync }) {
  if (typeof dryRun !== 'boolean') throw new Error('An explicit boolean dryRun is required');
  const packages = readReleasePackages(root);
  if (!dryRun && ref !== `refs/tags/v${packages[0].version}`) {
    throw new Error('Real publication must run from the matching release tag');
  }
  // Finish every registry lookup before the first mutation. A registry or authentication
  // failure must not be mistaken for an unpublished version or leave a partial release.
  const existing = dryRun ? [] : await Promise.all(packages.map(pkg => publishedVersionExists(pkg.name, pkg.version, fetcher)));
  for (const [index, pkg] of packages.entries()) {
    if (existing[index]) { console.log(`${pkg.name}@${pkg.version} is already on npm; skipping`); continue; }
    // Build, test and inspect every payload first; never run lifecycle scripts here.
    run('npm', ['publish', dryRun ? '--dry-run' : '--provenance', '--ignore-scripts', '--access', 'public',
      '--registry', 'https://registry.npmjs.org/'], { cwd: join(root, pkg.directory), stdio: 'inherit' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!['true', 'false'].includes(process.env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
    await publishPackages({ root: resolve(import.meta.dirname, '..'), dryRun: process.env.DRY_RUN === 'true', ref: process.env.GITHUB_REF });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
