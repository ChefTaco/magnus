#!/usr/bin/env node
// Sets one release version everywhere it is recorded: the root and every
// published package.json, exact internal dependency pins, the server's
// bundled agent version, the Ardent OpenAPI document, the release manifest
// and package-lock.json. Adds a CHANGELOG.md stub when the version has none.
//
//   node scripts/bump-version.mjs 1.1.0 [--no-lockfile]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_DIRECTORIES } from './publish-packages.mjs';
import { buildManifest } from './check-release-manifest.mjs';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function bumpVersion(root, version, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!VERSION.test(version)) throw new Error(`${version} is not an X.Y.Z version`);
  const changed = [];
  const rootPath = join(root, 'package.json');
  const rootPackage = readJson(rootPath);
  rootPackage.version = version;
  writeJson(rootPath, rootPackage);
  changed.push('package.json');

  const manifests = PACKAGE_DIRECTORIES.map((directory) => ({ directory, path: join(root, directory, 'package.json') }));
  const names = new Set(manifests.map(({ path }) => readJson(path).name));
  for (const { directory, path } of manifests) {
    const pkg = readJson(path);
    pkg.version = version;
    for (const category of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg[category] ?? {})) if (names.has(name)) pkg[category][name] = version;
    }
    writeJson(path, pkg);
    changed.push(`${directory}/package.json`);
  }

  writeJson(join(root, 'services/control-api/agent-version.json'), { version });
  changed.push('services/control-api/agent-version.json');
  const openapiPath = join(root, 'packages/ardent/openapi/ardent.json');
  const openapi = readJson(openapiPath);
  openapi.info.version = version;
  writeJson(openapiPath, openapi);
  changed.push('packages/ardent/openapi/ardent.json');

  const metaPath = join(root, 'packages/magnus/package.json');
  const meta = readJson(metaPath);
  meta.magnusRelease = buildManifest(root);
  writeJson(metaPath, meta);

  const changelogPath = join(root, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  if (!changelog.includes(`## [${version}]`)) {
    const first = changelog.indexOf('\n## [');
    const stub = `\n## [${version}] - ${today}\n\n### Added\n\n- \n`;
    writeFileSync(changelogPath, first < 0 ? `${changelog}${stub}` : `${changelog.slice(0, first)}${stub}${changelog.slice(first)}`);
    changed.push('CHANGELOG.md (stub: fill it in)');
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, ...flags] = process.argv.slice(2);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  try {
    const changed = bumpVersion(root, version ?? '');
    if (!flags.includes('--no-lockfile')) {
      execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
      changed.push('package-lock.json');
    }
    console.log(`Set ${version} in:\n${changed.map((file) => `  ${file}`).join('\n')}\nNext: release/${version}.json (notes, new settings, migrations), CHANGELOG.md, then npm run release:manifest.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
