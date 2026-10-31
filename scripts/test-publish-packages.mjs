import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PACKAGE_DIRECTORIES, publishedVersionExists, publishPackages } from './publish-packages.mjs';

function releaseFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'magnus-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.1","private":true}');
  for (const [index, directory] of PACKAGE_DIRECTORIES.entries()) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify({
      name: `@example/package-${index}`, version: '1.0.1', publishConfig: { access: 'public' },
      ...(index ? { dependencies: { '@example/package-0': '1.0.1' } } : {}),
    }));
  }
  writeFileSync(join(root, 'services/control-api/agent-version.json'), '{"version":"1.0.1"}');
  return root;
}

test('only an explicit 404 means a version is absent; other registry failures stop publication', async () => {
  assert.equal(await publishedVersionExists('@example/package', '1.0.1', async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40example%2Fpackage/1.0.1');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    return new Response('', { status: 404 });
  }), false);
  assert.equal(await publishedVersionExists('@example/package', '1.0.1', async () =>
    Response.json({ name: '@example/package', version: '1.0.1' })), true);
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(publishedVersionExists('@example/package', '1.0.1', async () => new Response('', { status })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(publishedVersionExists('@example/package', '1.0.1', async () => Response.json({})), /Unexpected npm metadata/);
  await assert.rejects(publishedVersionExists('@example/package', '1.0.1', async () => { throw new Error('connection failed'); }), /connection failed/);
});

test('real publication requires the version tag and checks all packages before any mutation', async t => {
  const root = releaseFixture(t);
  const options = { root, dryRun: false, ref: 'refs/tags/v1.0.1' };
  let lookups = 0;
  let publications = 0;
  const run = () => { publications++; };
  await assert.rejects(publishPackages({ ...options, ref: 'refs/heads/main', run }), /matching release tag/);
  await assert.rejects(publishPackages({ ...options, ref: 'refs/tags/v1.0.0', run }), /matching release tag/);
  await assert.rejects(publishPackages({ ...options, run, fetcher: async () => {
    lookups++;
    return new Response('', { status: lookups === 6 ? 503 : 404 });
  } }), /HTTP 503/);
  assert.equal(lookups, 6);
  assert.equal(publications, 0);
});

test('dry runs validate all packages without registry access or provenance publication', async t => {
  const root = releaseFixture(t);
  const calls = [];
  await publishPackages({ root, dryRun: true, ref: 'refs/heads/main', fetcher: () => { throw new Error('unexpected registry lookup'); },
    run: (...args) => calls.push(args) });
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[0][1], ['publish', '--dry-run', '--ignore-scripts', '--access', 'public', '--registry', 'https://registry.npmjs.org/']);
  assert.equal(calls[0][2].cwd, join(root, PACKAGE_DIRECTORIES[0]));
});

test('release metadata mismatches stop before calling npm', async t => {
  const root = releaseFixture(t);
  const options = { root, dryRun: true, run: () => assert.fail('npm must not run') };
  writeFileSync(join(root, 'services/control-api/agent-version.json'), '{"version":"0.0.0"}');
  await assert.rejects(publishPackages(options), /bundled agent version/);
  writeFileSync(join(root, 'services/control-api/agent-version.json'), '{"version":"1.0.1"}');
  writeFileSync(join(root, 'apps/dashboard/package.json'), JSON.stringify({
    name: '@example/package-5', version: '1.0.1', publishConfig: { access: 'public' },
    devDependencies: { '@example/package-0': '1.0.0' },
  }));
  await assert.rejects(publishPackages(options), /must depend on/);
  writeFileSync(join(root, 'apps/dashboard/package.json'), JSON.stringify({
    name: '@example/package-5', version: '1.0.1', publishConfig: { access: 'public' },
  }));
  writeFileSync(join(root, 'packages/contracts/package.json'), JSON.stringify({
    name: '@example/package-0', version: '1.0.0', publishConfig: { access: 'public' },
  }));
  await assert.rejects(publishPackages(options), /same valid version/);
  await assert.rejects(publishPackages({ ...options, dryRun: undefined }), /explicit boolean/);
});

test('real publication skips existing versions and stops on the first publish failure', async t => {
  const root = releaseFixture(t);
  const calls = [];
  await assert.rejects(publishPackages({ root, dryRun: false, ref: 'refs/tags/v1.0.1', fetcher: async url =>
    url.includes('package-0/') ? Response.json({ name: '@example/package-0', version: '1.0.1' }) : new Response('', { status: 404 }),
  run: (...args) => { calls.push(args); throw new Error('publish failed'); } }), /publish failed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].cwd, join(root, PACKAGE_DIRECTORIES[1]));
  assert.ok(calls[0][1].includes('--provenance'));
});
