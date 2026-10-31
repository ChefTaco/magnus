#!/usr/bin/env node
// Dry-runs `npm pack` for every publishable package and checks the file list:
// each bin, main, types and exports target, README.md and LICENSE must be in
// the tarball, and nothing that looks like a secret, local state or private
// notes. Build first (`npm run build`); scripts are skipped so this never
// rebuilds. Usage: node scripts/check-npm-packs.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PUBLISHABLE = [
  'packages/contracts',
  'packages/skills',
  'packages/ardent',
  'packages/agent',
  'services/control-api',
  'apps/dashboard',
];

// The UI ships Next.js standalone output, whose traced dependencies live in dist/app/node_modules.
// Runtime files a package needs beyond its bin, main, types and exports.
const EXTRA_REQUIRED = {
  'apps/dashboard': ['dist/app/apps/dashboard/server-tls.mjs', 'dist/app/apps/dashboard/server.js'],
};

const FORBIDDEN = /(^|\/)\.env($|\.(?!example$))|(^|\/)\.npmrc$|\.(pem|key|crt|p12|pfx|db|sqlite|sqlite3)$|(^|\/)[^/]+\.local\.md$|(^|\/)\.private-terms$|^(?!dist\/app\/)(.*\/)?node_modules\/|(^|\/)(certs|backups|state|artifacts|\.magnus)\//u;

function exportTargets(value) {
  if (typeof value === 'string') return value.includes('*') ? [] : [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  return [];
}

function requiredFiles(manifest) {
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  const targets = [...bins, manifest.main, manifest.types, ...exportTargets(manifest.exports)].filter((entry) => typeof entry === 'string');
  return [...new Set(['package.json', 'README.md', 'LICENSE', ...targets.map((entry) => normalize(entry).replace(/^\.\//u, ''))])];
}

let failures = 0;
for (const directory of PUBLISHABLE) {
  const cwd = join(root, directory);
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const problems = [];
  if (manifest.private) problems.push('package.json has "private": true');
  if (!String(manifest.name).startsWith('@hivemagnus/')) problems.push(`name ${manifest.name} is not in the @hivemagnus scope`);
  if (manifest.publishConfig?.access !== 'public') problems.push('publishConfig.access is not "public"');
  if (manifest.license !== 'Apache-2.0') problems.push(`license is ${manifest.license}, expected Apache-2.0`);
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let files = [];
  if (result.status !== 0) {
    problems.push(`npm pack --dry-run failed: ${(result.stderr || result.stdout).trim().split('\n').at(-1)}`);
  } else {
    try {
      const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
      files = (report[0]?.files ?? []).map((file) => file.path);
    } catch {
      problems.push('npm pack --dry-run --json did not print JSON');
    }
  }
  const listed = new Set(files);
  if (files.length > 0) {
    for (const file of [...requiredFiles(manifest), ...(EXTRA_REQUIRED[directory] ?? [])]) if (!listed.has(file)) problems.push(`missing ${file} (run npm run build first)`);
    for (const file of files) if (FORBIDDEN.test(file)) problems.push(`must not publish ${file}`);
  }
  if (problems.length === 0) {
    console.log(`ok    ${manifest.name}@${manifest.version} (${directory}, ${files.length} files)`);
  } else {
    failures += 1;
    console.log(`FAIL  ${manifest.name ?? directory} (${directory})`);
    for (const problem of problems) console.log(`        ${problem}`);
  }
}
process.exitCode = failures === 0 ? 0 : 1;
