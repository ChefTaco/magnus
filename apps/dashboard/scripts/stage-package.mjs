#!/usr/bin/env node
/**
 * Stage the Next.js standalone build as the npm package payload (`dist/app`).
 *
 * Runs from `prepack` after `npm run build`. In this monorepo Next.js nests the
 * app under `.next/standalone/apps/dashboard`; the staged copy keeps that
 * layout and adds what the standalone server needs at runtime:
 *
 *   - `.next/static` and `public` next to `server.js`
 *   - the TLS wrapper (`server-tls.mjs`) and its `runtime-*.mjs` helpers
 *   - real directories instead of the symlinks Next.js creates for server
 *     external packages (npm pack drops symlinks)
 *
 * Packages the TLS wrapper and runtime helpers import directly, and native
 * modules (argon2, ssh2), are removed from the traced copy and resolved from
 * the package's own dependencies instead: the trace may hold only partial
 * copies, and npm installs the right native binary for the target platform.
 * The unused image optimizer (sharp) is dropped.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = join(appDir, '.next/standalone');
const stageRoot = join(appDir, 'dist/app');

/** Packages resolved from the installed package dependencies, not the traced build. */
export const DEPENDENCY_PACKAGES = ['argon2', 'ioredis', 'jose', 'ssh2', 'ws'];
/** Optional native helpers of DEPENDENCY_PACKAGES, also resolved from the install. */
const NATIVE_HELPERS = ['cpu-features'];
/** Traced packages the dashboard never loads at runtime. */
export const DROPPED_PACKAGES = ['sharp', '@img'];
/** The NEXT_PUBLIC_API_URL default in next.config.ts. */
const PUBLIC_API_URL_DEFAULT = 'https://localhost:4000';

function fail(message) {
  console.error(`stage-package: ${message}`);
  process.exit(1);
}

/** Locate the directory that holds the standalone server.js. */
export function findServerDir(root) {
  if (existsSync(join(root, 'server.js'))) return root;
  const nested = join(root, 'apps/dashboard');
  if (existsSync(join(nested, 'server.js'))) return nested;
  return null;
}

/**
 * Replace a Next.js external-package symlink (`<name>-<hash>`) with a shim
 * that re-exports the real package by name.
 */
function writeExternalShim(linkPath, packageName) {
  rmSync(linkPath, { force: true });
  mkdirSync(linkPath, { recursive: true });
  const name = linkPath.split('/').pop();
  writeFileSync(join(linkPath, 'package.json'), `${JSON.stringify({ name, private: true, main: 'index.cjs' }, null, 2)}\n`);
  writeFileSync(join(linkPath, 'index.cjs'), `module.exports = require(${JSON.stringify(packageName)});\n`);
}

/** Copy a symlinked directory's contents in place of the link. */
function dereference(linkPath) {
  const target = resolve(dirname(linkPath), readlinkSync(linkPath));
  rmSync(linkPath, { force: true });
  cpSync(target, linkPath, { recursive: true, dereference: true });
}

function packageNameFromLink(linkPath) {
  const target = readlinkSync(linkPath).split('/').filter(Boolean);
  const index = target.lastIndexOf('node_modules');
  const parts = target.slice(index + 1);
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function walkSymlinks(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) visit(path);
    else if (entry.isDirectory()) walkSymlinks(path, visit);
  }
}

function walkFiles(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, visit);
    else if (entry.isFile()) visit(path);
  }
}

function main() {
  const serverDir = findServerDir(standalone);
  if (!serverDir) fail('no standalone build found; run `npm run build` first');
  rmSync(join(appDir, 'dist'), { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  cpSync(standalone, stageRoot, {
    recursive: true,
    verbatimSymlinks: true,
    // Never ship local environment files or operator state from the build host.
    filter: (source) => !/(?:^|\/)(?:\.env(?:\..*)?|\.magnus|terminal-audit)$/.test(source),
  });
  const stagedServer = join(stageRoot, relative(standalone, serverDir));

  cpSync(join(appDir, '.next/static'), join(stagedServer, '.next/static'), { recursive: true });
  if (existsSync(join(appDir, 'public'))) cpSync(join(appDir, 'public'), join(stagedServer, 'public'), { recursive: true });
  for (const file of readdirSync(appDir)) {
    if (file === 'server-tls.mjs' || /^runtime-[a-z0-9-]+\.mjs$/.test(file)) cpSync(join(appDir, file), join(stagedServer, file));
  }

  const modules = join(stageRoot, 'node_modules');
  for (const name of [...DEPENDENCY_PACKAGES, ...NATIVE_HELPERS, ...DROPPED_PACKAGES]) rmSync(join(modules, name), { recursive: true, force: true });

  walkSymlinks(stageRoot, (link) => {
    const name = packageNameFromLink(link);
    if (name && DEPENDENCY_PACKAGES.includes(name)) writeExternalShim(link, name);
    else dereference(link);
  });

  // Next.js embeds the absolute build root in its runtime config. It is not
  // needed at runtime, so replace it rather than publish build-host paths.
  const buildRoot = resolve(appDir, '../..');
  for (const file of [join(stagedServer, 'server.js'), join(stagedServer, '.next/required-server-files.json')]) {
    if (existsSync(file)) writeFileSync(file, readFileSync(file, 'utf8').split(buildRoot).join('/opt/magnus-ui-build'));
  }
  const pathLeaks = [];
  walkFiles(stageRoot, (file) => {
    if (/\.(?:js|mjs|cjs|json|html|rsc|txt)$/.test(file) && readFileSync(file, 'utf8').includes(buildRoot)) pathLeaks.push(relative(stageRoot, file));
  });
  if (pathLeaks.length) fail(`build-host paths remain in: ${pathLeaks.slice(0, 10).join(', ')}`);

  // Next.js inlines NEXT_PUBLIC_* values at build time, including values from a local .env file.
  // A published build must carry only the defaults from next.config.ts.
  const inlined = [];
  walkFiles(stageRoot, (file) => {
    if (!/\.(?:js|mjs|cjs|json|html)$/.test(file) || file.includes(`${join(stageRoot, 'node_modules')}`)) return;
    for (const match of readFileSync(file, 'utf8').matchAll(/"NEXT_PUBLIC_API_URL":"([^"]*)"/g)) {
      if (match[1] !== PUBLIC_API_URL_DEFAULT) inlined.push(`${relative(stageRoot, file)} (${match[1]})`);
    }
  });
  if (inlined.length) fail(`the build inlined a local NEXT_PUBLIC_API_URL; rebuild without local .env files: ${inlined.slice(0, 3).join(', ')}`);

  const leftovers = [];
  walkSymlinks(stageRoot, (link) => leftovers.push(relative(stageRoot, link)));
  if (leftovers.length) fail(`symlinks remain in the staged app: ${leftovers.join(', ')}`);
  if (!lstatSync(join(stagedServer, '.next/static')).isDirectory()) fail('static assets were not staged');
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
  for (const name of DEPENDENCY_PACKAGES) {
    if (!pkg.dependencies?.[name]) fail(`${name} must be a runtime dependency of the package`);
  }
  console.log(`stage-package: staged ${relative(appDir, stagedServer)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
