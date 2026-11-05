import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildManifest, changelogSection, checkRelease } from './check-release-manifest.mjs';
import { bumpVersion } from './bump-version.mjs';
import { PACKAGE_DIRECTORIES, UNPUBLISHED_DIRECTORIES } from './publish-packages.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** A copy of just the files the release tooling reads. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'magnus-release-tooling-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['package.json', 'CHANGELOG.md', 'services/control-api/agent-version.json', 'packages/ardent/openapi/ardent.json',
    'services/control-api/src/cli/env-catalog.ts', 'packages/agent/src/env-catalog.ts', 'apps/dashboard/runtime-environment.mjs', 'packages/magnus/src/templates.ts',
    ...[...PACKAGE_DIRECTORIES, ...UNPUBLISHED_DIRECTORIES].map((directory) => `${directory}/package.json`)]) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    cpSync(join(repo, file), join(root, file));
  }
  const migrations = join(root, 'services/control-api/prisma/migrations');
  mkdirSync(join(migrations, '20261031000000_baseline'), { recursive: true });
  writeFileSync(join(migrations, '20261031000000_baseline', 'migration.sql'), 'SELECT 1;');
  return root;
}

test('the committed release manifest is current', async () => {
  const { problems } = await checkRelease(repo);
  assert.deepEqual(problems, []);
});

test('bumping sets every version and pin, and the manifest follows', async (t) => {
  const root = fixture(t);
  const workspaces = [...PACKAGE_DIRECTORIES, ...UNPUBLISHED_DIRECTORIES];
  const originals = new Map(workspaces.map(directory => [directory,
    JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'))]));
  const workspaceNames = new Set([...originals.values()].map(pkg => pkg.name));
  bumpVersion(root, '9.8.7', { today: '2026-11-01' });
  for (const directory of workspaces) {
    const pkg = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '9.8.7', directory);
    for (const category of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, pinned] of Object.entries(pkg[category] ?? {})) {
        assert.equal(pinned, workspaceNames.has(name) ? '9.8.7' : originals.get(directory)[category][name], `${directory} ${name}`);
      }
    }
  }
  assert.equal(JSON.parse(readFileSync(join(root, 'services/control-api/agent-version.json'), 'utf8')).version, '9.8.7');
  const meta = JSON.parse(readFileSync(join(root, 'packages/magnus/package.json'), 'utf8'));
  assert.equal(meta.magnusRelease.version, '9.8.7');
  assert.ok(Object.values(meta.magnusRelease.components).every((version) => version === '9.8.7'));
  assert.match(changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), '9.8.7'), /## \[9\.8\.7\] - 2026-11-01/);
  assert.throws(() => bumpVersion(root, 'next'), /not an X\.Y\.Z/);
});

test('new settings and risky migrations must be documented', async (t) => {
  const root = fixture(t);
  bumpVersion(root, '9.8.7', { today: '2026-11-01' });
  const migration = join(root, 'services/control-api/prisma/migrations/20270101000000_example');
  mkdirSync(migration);
  writeFileSync(join(migration, 'migration.sql'), 'SELECT 1;');
  writeFileSync(join(migration, 'magnus-impact.json'), JSON.stringify({ impact: 'one-way', note: 'drops a column' }));
  let { problems } = await checkRelease(root);
  assert.ok(problems.some((problem) => /20270101000000_example is not listed/.test(problem)));

  mkdirSync(join(root, 'release'));
  writeFileSync(join(root, 'release/9.8.7.json'), JSON.stringify({
    summary: 'Example', migrations: ['20270101000000_example'],
    newRequiredEnv: [{ name: 'MAGNUS_AUTO_MIGRATE', component: 'server', secret: false, description: 'x' },
      { name: 'EXAMPLE_UNDOCUMENTED', component: 'server', secret: true, description: 'y' }],
  }));
  ({ problems } = await checkRelease(root));
  assert.ok(problems.some((problem) => /out of date/.test(problem)));
  assert.ok(problems.some((problem) => /EXAMPLE_UNDOCUMENTED \(server\) is not in that component's environment catalogue/.test(problem)));
  assert.ok(problems.some((problem) => /New environment variables/.test(problem)));
  assert.ok(problems.some((problem) => /Migration impact/.test(problem)));
  assert.deepEqual(buildManifest(root).migrations, [{ name: '20270101000000_example', impact: 'one-way', note: 'drops a column' }]);
});

test('the manifest carries the install scripts the release needs', () => {
  const { allowScripts } = buildManifest(repo);
  assert.equal(allowScripts.argon2, true);
  assert.equal(allowScripts.prisma, true);
});
