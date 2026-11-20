#!/usr/bin/env node
// Writes the project an image installs a packed, shrinkwrapped package into, so `npm ci` lays the
// package out exactly as `npm install <name>@<version>` from the registry does: the package's
// npm-shrinkwrap.json graph nested under node_modules/<name>. npm only honours a dependency's
// shrinkwrap when the registry says it has one, never for a local tarball, so the images (and the
// pack checks) spell the layout out in a lockfile instead of trusting `npm install ./x.tgz`.
// Sibling workspace tarballs built alongside replace their registry URLs.
//
//   node scripts/shrinkwrap-install-lock.mjs --out DIR --name RUNTIME --package X.tgz [--local Y.tgz ...]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const integrity = (file) => 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64');
const member = (tarball, path) => JSON.parse(execFileSync('tar', ['-xzOf', tarball, `package/${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

/** Returns the package.json and package-lock.json of a project that installs `tarball`. */
export function shrinkwrapInstallProject({ out, name, tarball, locals = [] }) {
  const spec = (file) => `file:${relative(out, file) || '.'}`;
  const manifest = member(tarball, 'package.json');
  const lock = member(tarball, 'npm-shrinkwrap.json');
  const siblings = new Map(locals.map((file) => [member(file, 'package.json').name, file]));
  const base = `node_modules/${manifest.name}`;
  const packages = {
    '': { name, dependencies: { [manifest.name]: spec(tarball) } },
    [base]: {
      // No hasShrinkwrap: npm would then rebuild this subtree from the tarball's own lock and fetch
      // the siblings from the registry instead of the local tarballs named here.
      version: manifest.version, resolved: spec(tarball), integrity: integrity(tarball),
      ...Object.fromEntries(['license', 'bin', 'engines', 'dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']
        .filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]])),
    },
  };
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    // A production install has no development entries; an image never needs them.
    if (!path || entry.dev) continue;
    const copy = { ...entry };
    const sibling = siblings.get(path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length));
    if (sibling && !entry.inBundle) Object.assign(copy, { resolved: spec(sibling), integrity: integrity(sibling) });
    packages[`${base}/${path}`] = copy;
  }
  return {
    // The package's own overrides produced its lock; without them npm ci would call the locked
    // security pins (effect under @prisma/config) out of sync with the declared ranges.
    manifest: { name, private: true, dependencies: { [manifest.name]: spec(tarball) }, ...(manifest.overrides ? { overrides: manifest.overrides } : {}) },
    lock: { name, lockfileVersion: 3, requires: true, packages },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error(`${flag} required`); return args[index + 1]; };
  const locals = args.flatMap((arg, index) => (arg === '--local' && args[index + 1] ? [resolve(args[index + 1])] : []));
  const out = resolve(value('--out'));
  const project = shrinkwrapInstallProject({ out, name: value('--name'), tarball: resolve(value('--package')), locals });
  writeFileSync(resolve(out, 'package.json'), JSON.stringify(project.manifest, null, 2) + '\n');
  writeFileSync(resolve(out, 'package-lock.json'), JSON.stringify(project.lock, null, 2) + '\n');
}
