#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIRECTORIES = [
  'packages/contracts', 'packages/skills', 'packages/agent',
  'services/control-api', 'apps/dashboard',
  // Last: the installer pins every component above at this exact version.
  'packages/magnus',
];

// Workspaces that never reach npm, but keep the release version. The Oathweave verifier travels inside
// the tarballs of the packages that bundle it; the fleet gateway ships as a container image.
export const UNPUBLISHED_DIRECTORIES = ['packages/oathweave', 'services/fleet-gateway'];

export function assertBootstrapMode(dryRun, bootstrap, credential) {
  if (bootstrap && dryRun) throw new Error('Bootstrap requires a real publication from the release tag; disable dry_run explicitly');
  if (bootstrap && !credential) throw new Error('Configure the temporary NPM_BOOTSTRAP_TOKEN secret in the npm-publish environment before bootstrap publication');
}

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
  const unpublished = UNPUBLISHED_DIRECTORIES.map(directory => JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')));
  for (const pkg of unpublished) {
    if (!pkg.private || pkg.version !== version) throw new Error(`${pkg.name} must be private, at the release version ${version}`);
  }
  const names = new Set([...packages, ...unpublished].map(pkg => pkg.name));
  for (const pkg of [...packages, ...unpublished]) {
    for (const category of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, dependencyVersion] of Object.entries(pkg[category] ?? {})) {
        if (names.has(name) && dependencyVersion !== version) throw new Error(`${pkg.name} must depend on ${name}@${version}`);
      }
    }
  }
  // A published package that needs an unpublished one would fail to install with a 404.
  for (const pkg of packages) {
    for (const { name } of unpublished) {
      if (pkg.dependencies?.[name] && !pkg.bundleDependencies?.includes(name)) throw new Error(`${pkg.name} must bundle ${name}, which is not published`);
    }
  }
  const agentVersion = JSON.parse(readFileSync(join(root, 'services/control-api/agent-version.json'), 'utf8')).version;
  if (agentVersion !== version) throw new Error(`The server's bundled agent version must be ${version}`);
  const meta = packages.find(pkg => pkg.directory === 'packages/magnus');
  const release = meta?.magnusRelease;
  if (!release || release.version !== version || Object.values(release.components ?? {}).some(pinned => pinned !== version)) {
    throw new Error(`packages/magnus magnusRelease must describe ${version} and pin every component at ${version} (npm run release:manifest)`);
  }
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

/** The version npm installs by default for `name`, or null when the package has no `latest` yet. */
export async function latestDistTag(name, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read the dist-tags of ${name} on npm (HTTP ${response.status}); publication stopped`);
  const tags = await response.json();
  if (tags?.latest !== undefined && (typeof tags.latest !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tags.latest)))
    throw new Error(`Unexpected npm dist-tags for ${name}; publication stopped`);
  return tags?.latest ?? null;
}

const releaseParts = version => version.split('-')[0].split('.').map(Number);

/**
 * `latest`, unless npm's `latest` is already a newer release: a patch of an older line (a maintenance
 * branch) is published as `maintenance-<major>.<minor>`, so it never becomes the default install.
 */
export function distTagFor(version, latest) {
  if (!latest) return 'latest';
  const [a, b] = [releaseParts(version), releaseParts(latest)];
  const older = a.findIndex((part, index) => part !== b[index]);
  if (older === -1 || a[older] > b[older]) return 'latest';
  return `maintenance-${a[0]}.${a[1]}`;
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
  // Dry runs too: npm refuses to apply `latest` implicitly to a version below the current one, even with --dry-run.
  const tags = await Promise.all(packages.map(async pkg => distTagFor(pkg.version, await latestDistTag(pkg.name, fetcher))));
  for (const [index, pkg] of packages.entries()) {
    if (existing[index]) { console.log(`${pkg.name}@${pkg.version} is already on npm; skipping`); continue; }
    if (tags[index] && tags[index] !== 'latest') console.log(`${pkg.name}@${pkg.version} is older than npm's latest; publishing it as ${tags[index]}`);
    // Build, test and inspect every payload first; never run lifecycle scripts here.
    run('npm', ['publish', dryRun ? '--dry-run' : '--provenance', ...(tags[index] ? ['--tag', tags[index]] : []), '--ignore-scripts', '--access', 'public',
      '--registry', 'https://registry.npmjs.org/'], { cwd: join(root, pkg.directory), stdio: 'inherit' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!['true', 'false'].includes(process.env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
    if (process.env.NPM_BOOTSTRAP && !['true', 'false'].includes(process.env.NPM_BOOTSTRAP)) throw new Error('NPM_BOOTSTRAP must be true or false');
    assertBootstrapMode(process.env.DRY_RUN === 'true', process.env.NPM_BOOTSTRAP === 'true', process.env.NODE_AUTH_TOKEN);
    await publishPackages({ root: resolve(import.meta.dirname, '..'), dryRun: process.env.DRY_RUN === 'true', ref: process.env.GITHUB_REF });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
