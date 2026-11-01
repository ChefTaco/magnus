#!/usr/bin/env node
// Re-versions packed @hivemagnus tarballs into a synthetic release for the
// upgrade end-to-end test, optionally broken in a specific way:
//
//   node scripts/e2e/synthetic-release.mjs --from DIR --version 1.1.1-ci --out DIR
//        [--broken-server] [--migration NAME] [--agent-never-heartbeats] [--only name,name]
//
// Internal pins, the server's bundled agent version and the meta package's
// magnusRelease follow the new version. Test tooling only; never published.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  from: { type: 'string' }, version: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' },
  'broken-server': { type: 'boolean', default: false }, migration: { type: 'string' },
  'agent-never-heartbeats': { type: 'boolean', default: false },
} });
if (!values.from || !values.version || !values.out) throw new Error('--from, --version and --out are required');
const version = values.version;
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const only = values.only ? new Set(values.only.split(',').map((name) => `@hivemagnus/${name}`)) : null;

for (const file of readdirSync(values.from).filter((name) => name.endsWith('.tgz'))) {
  const work = mkdtempSync(join(tmpdir(), 'magnus-synthetic-'));
  execFileSync('tar', ['-xzf', join(values.from, file), '-C', work]);
  const manifestPath = join(work, 'package', 'package.json');
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (only && !only.has(pkg.name)) { rmSync(work, { recursive: true, force: true }); continue; }
  pkg.version = version;
  for (const category of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    // Siblings outside --only keep their original pins (they are not re-versioned).
    for (const name of Object.keys(pkg[category] ?? {})) if (name.startsWith('@hivemagnus/') && (!only || only.has(name))) pkg[category][name] = version;
  }
  if (pkg.magnusRelease) {
    pkg.magnusRelease.version = version;
    for (const name of Object.keys(pkg.magnusRelease.components)) pkg.magnusRelease.components[name] = version;
    pkg.magnusRelease.summary = `Synthetic ${version} for the upgrade end-to-end test.`;
    if (values.migration) pkg.magnusRelease.migrations = [{ name: values.migration, impact: 'fast', note: '' }];
  }
  if (pkg.name === '@hivemagnus/magnus-server') {
    writeFileSync(join(work, 'package', 'agent-version.json'), `${JSON.stringify({ version })}\n`);
    if (values.migration) {
      const dir = join(work, 'package', 'prisma', 'migrations', values.migration);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'migration.sql'), 'CREATE TABLE IF NOT EXISTS "e2e_probe" ("id" INTEGER PRIMARY KEY);\n');
    }
    if (values['broken-server']) {
      const entry = join(work, 'package', 'dist', 'index.js');
      writeFileSync(entry, `throw new Error('synthetic broken release ${version}');\n${readFileSync(entry, 'utf8')}`);
    }
  }
  if (pkg.name === '@hivemagnus/magnus-agent' && values['agent-never-heartbeats']) {
    // Starts and reports its version, but never sends a heartbeat.
    writeFileSync(join(work, 'package', 'dist', 'index.js'),
      `if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }\nsetInterval(() => {}, 1 << 30);\n`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const name = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  execFileSync('tar', ['-czf', join(out, name), '-C', work, 'package']);
  rmSync(work, { recursive: true, force: true });
  console.log(join(out, name));
}
