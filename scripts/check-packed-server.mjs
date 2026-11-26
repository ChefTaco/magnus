#!/usr/bin/env node
// Installs the packed server and console the way their images do (scripts/shrinkwrap-install-lock.mjs:
// the npm-shrinkwrap.json graph nested under the package, as a registry install lays it out), then
// asks the server's own installation report whether the result matches the shipped lock.
// `package-locks.mjs --check` already proves the lock honours each exact override (in 3.1.5 a
// native install resolved effect 3.20.0 under @prisma/config although the server overrides it to
// 3.22.1); this proves the installed tree is that lock.
// Build first (`npm run build`). Needs the public npm registry, like check-packed-agent.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOCKED, REGISTRY, packWorkspace } from './package-locks.mjs';
import { shrinkwrapInstallProject } from './shrinkwrap-install-lock.mjs';

/** Installs `tarball` with its sibling tarballs into a fresh project; returns the installed package root. */
export function installShrinkwrapped(work, tarball, locals) {
  const out = join(work, 'install');
  mkdirSync(out);
  const project = shrinkwrapInstallProject({ out, name: 'packed-check', tarball, locals });
  writeFileSync(join(out, 'package.json'), JSON.stringify(project.manifest, null, 2) + '\n');
  writeFileSync(join(out, 'package-lock.json'), JSON.stringify(project.lock, null, 2) + '\n');
  for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(work, name), '');
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${REGISTRY}`,
    `--userconfig=${join(work, 'user.npmrc')}`, `--globalconfig=${join(work, 'global.npmrc')}`, `--cache=${join(work, 'npm-cache')}`],
  { cwd: out, stdio: ['ignore', 'ignore', 'inherit'], timeout: 600_000 });
  return join(out, 'node_modules', Object.keys(project.manifest.dependencies)[0]);
}

export async function checkPackedServerAndConsole(root) {
  const work = mkdtempSync(join(tmpdir(), 'magnus-packed-server-'));
  try {
    const { buildInstallationReport } = await import(pathToFileURL(join(root, 'services/control-api/dist/services/installation-report-service.js')).href);
    for (const [target, { directory, siblings, installationReport = true }] of Object.entries(LOCKED)) {
      const packs = join(work, target, 'packs');
      mkdirSync(packs, { recursive: true });
      const locals = siblings.map((sibling) => packWorkspace(join(root, sibling), packs).file);
      const { file, manifest } = packWorkspace(join(root, directory), packs);
      const installed = installShrinkwrapped(join(work, target), file, locals);
      if (!installationReport) {
        // The image-only gateway: its shrinkwrap installs with `npm ci` and yields this exact version.
        assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, manifest.version);
        console.log(`Packed ${manifest.name}: shrinkwrapped install succeeds`);
        continue;
      }
      const report = buildInstallationReport(installed);
      assert.equal(report.magnus.layout, 'package');
      assert.equal(report.resolution.reference, 'npm-shrinkwrap', `${manifest.name} tarball must carry its shrinkwrap`);
      assert(report.resolution.checked > 0, `${manifest.name}: nothing was compared`);
      assert.deepEqual(report.resolution.differences, [], `${manifest.name} installed differently from its shrinkwrap`);
      console.log(`Packed ${manifest.name}: shrinkwrapped install matches its lock (${report.resolution.checked} runtime packages)`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await checkPackedServerAndConsole(resolve(import.meta.dirname, '..'));
}
