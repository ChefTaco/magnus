import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkUpgradeAllowed,
  classifyUpgrade,
  compareVersions,
  latestVersion,
  manifestsFromPackument,
  releaseManifestSchema,
  satisfiesRange,
  summarizeUpgradePath,
} from '../src/release.ts';

const manifest = (version, extra = {}) => releaseManifestSchema.parse({
  schema: 1,
  version,
  engines: { node: '^24.22.1 || ^26.13.0' },
  components: { '@hivemagnus/magnus-server': version },
  engineProtocol: 1,
  agent: { selfUpgradeProtocol: 1, minLauncher: 1 },
  ...extra,
});

test('versions compare by semver precedence, including prereleases', () => {
  assert.equal(compareVersions('1.0.3', '1.1.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.1.0-rc.1', '1.1.0'), -1);
  assert.equal(compareVersions('1.1.0-rc.2', '1.1.0-rc.10'), -1);
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0);
  assert.throws(() => compareVersions('latest', '1.0.0'));
});

test('engine ranges accept only the declared Node lines', () => {
  const range = '^24.22.1 || ^26.13.0';
  assert.ok(satisfiesRange('24.22.1', range));
  assert.ok(satisfiesRange('v26.14.0', range));
  assert.ok(!satisfiesRange('24.22.0', range));
  assert.ok(!satisfiesRange('25.0.0', range));
  assert.ok(!satisfiesRange('22.11.0', range));
  assert.ok(satisfiesRange('1.0.3', '1.0.3'));
});

test('upgrades never downgrade or cross a major without an explicit opt-in', () => {
  assert.equal(classifyUpgrade('1.0.3', '1.0.4'), 'patch');
  assert.equal(classifyUpgrade('1.0.3', '1.1.0'), 'minor');
  assert.deepEqual(checkUpgradeAllowed('1.0.3', '1.1.0'), { allowed: true, kind: 'minor' });
  assert.equal(checkUpgradeAllowed('1.1.0', '1.0.3').allowed, false);
  assert.equal(checkUpgradeAllowed('1.9.0', '2.0.0').allowed, false);
  assert.equal(checkUpgradeAllowed('1.9.0', '2.0.0', { allowMajor: true }).allowed, true);
});

test('latestVersion can stay inside the current major and skips prereleases', () => {
  const versions = ['1.0.3', '1.1.0', '1.2.0-rc.1', '2.0.0', 'nonsense'];
  assert.equal(latestVersion(versions), '2.0.0');
  assert.equal(latestVersion(versions, { sameMajorAs: '1.0.3' }), '1.1.0');
  assert.equal(latestVersion(versions, { sameMajorAs: '1.0.3', includePrerelease: true }), '1.2.0-rc.1');
});

test('an upgrade path merges env changes and flags slow or one-way migrations', () => {
  const env = (name) => ({ name, component: 'server', description: 'example' });
  const path = summarizeUpgradePath([
    manifest('1.0.3'),
    manifest('1.1.0', { newRequiredEnv: [env('EXAMPLE_ONE'), env('EXAMPLE_GONE')], migrations: [{ name: 'a', impact: 'fast' }] }),
    manifest('1.2.0', { removedEnv: [{ name: 'EXAMPLE_GONE', component: 'server' }], migrations: [{ name: 'b', impact: 'one-way', note: 'drops a column' }] }),
    manifest('1.3.0'),
  ], '1.0.3', '1.2.0');
  assert.deepEqual(path.releases.map((r) => r.version), ['1.1.0', '1.2.0']);
  assert.deepEqual(path.newRequiredEnv.map((e) => e.name), ['EXAMPLE_ONE']);
  assert.deepEqual(path.attention.map((m) => `${m.version}:${m.name}`), ['1.2.0:b']);
  assert.equal(path.blockedBy, undefined);
});

test('minUpgradeFrom blocks a path that skips a required stepping stone', () => {
  const path = summarizeUpgradePath([manifest('1.5.0', { minUpgradeFrom: '1.2.0' })], '1.0.3', '1.5.0');
  assert.match(path.blockedBy, /1\.2\.0/);
});

test('manifests are read from a full packument and invalid entries are ignored', () => {
  const found = manifestsFromPackument({ versions: {
    '1.0.3': {},
    '1.1.0': { magnusRelease: manifest('1.1.0') },
    '1.1.1': { magnusRelease: { schema: 99 } },
  } });
  assert.deepEqual(found.map((m) => m.version), ['1.1.0']);
});
