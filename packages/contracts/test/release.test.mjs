import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UPGRADE_REMEDIES, upgradeFailureClass, upgradeRemedy } from '../src/upgrade-remedies.ts';
import {
  agentSelfUpgradeStatusSchema,
  agentUpgradePreflightSchema,
  checkUpgradeAllowed,
  classifyUpgrade,
  compareVersions,
  latestVersion,
  manifestsFromPackument,
  readPackument,
  releaseManifestSchema,
  satisfiesRange,
  summarizeUpgradePath,
} from '../src/release.ts';

const manifest = (version, extra = {}) => releaseManifestSchema.parse({
  schema: 1,
  version,
  engines: { node: '^24.22.3 || ^26.13.1' },
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
  const range = '^24.22.3 || ^26.13.1';
  assert.ok(satisfiesRange('24.22.3', range));
  assert.ok(satisfiesRange('v26.14.0', range));
  assert.ok(!satisfiesRange('24.22.2', range));
  assert.ok(!satisfiesRange('26.13.0', range));
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

test('a manifest that is present but unparsable is reported, not dropped silently', () => {
  const found = readPackument({
    'dist-tags': { latest: '1.1.0' },
    versions: {
      '1.0.3': {},
      '1.1.0': { magnusRelease: manifest('1.1.0') },
      '1.1.1': { magnusRelease: { schema: 2 }, deprecated: 'broken build' },
    },
  });
  assert.deepEqual(found.manifests.map((m) => m.version), ['1.1.0']);
  assert.deepEqual(found.unparsable, ['1.1.1']);
  assert.deepEqual(found.deprecated, ['1.1.1']);
  assert.equal(found.latest, '1.1.0');
});

test('manifests tolerate fields and migration impacts added by newer releases', () => {
  const parsed = releaseManifestSchema.parse({
    ...manifest('1.2.0'),
    futureField: { anything: true },
    allowScripts: { argon2: true },
    migrations: [{ name: 'x', impact: 'online-rewrite' }],
  });
  assert.equal(parsed.migrations[0].impact, 'one-way');
  assert.deepEqual(parsed.allowScripts, { argon2: true });
  assert.equal('futureField' in parsed, false);
});

test('a malformed drift field drops alone and never costs the self-upgrade report', () => {
  const base = { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true };
  const parsed = agentSelfUpgradeStatusSchema.parse({ ...base, fenceHighWater: { 'node:n1': 'not-a-number' }, ledger: { readable: 'yes' }, disk: 7, npm: { present: true, version: '11.0.0' } });
  assert.equal(parsed.fenceHighWater, undefined);
  assert.equal(parsed.ledger, undefined);
  assert.equal(parsed.disk, undefined);
  assert.deepEqual(parsed.npm, { present: true, version: '11.0.0' });
  assert.deepEqual(agentSelfUpgradeStatusSchema.parse({ ...base, fenceHighWater: { 'node:n1': '1789962351090' } }).fenceHighWater, { 'node:n1': '1789962351090' });
  assert.equal(agentSelfUpgradeStatusSchema.parse(base).ledger, undefined);
});

test('a preflight report tolerates fields it does not know and drops ones it cannot read', () => {
  const report = agentUpgradePreflightSchema.parse({ preflightProtocol: 1, version: '1.1.8', futureField: true, disk: 'lots', fenceHighWater: { 'node:n1': '5' } });
  assert.equal(report.disk, undefined);
  assert.deepEqual(report.fenceHighWater, { 'node:n1': '5' });
});

test('the remedies catalogue classes the codes the wave policy depends on', () => {
  for (const code of ['SELF_UPGRADE_INTEGRITY', 'SELF_UPGRADE_SOURCE']) assert.deepEqual([upgradeFailureClass(code), upgradeRemedy(code).stopsRun], ['release', true]);
  for (const code of ['SELF_UPGRADE_FAILED', 'SELF_UPGRADE_REVERTED', 'CONFIRM_TIMEOUT', 'AGENT_SILENT']) assert.equal(upgradeFailureClass(code), 'release');
  for (const code of ['STALE_FENCE', 'RESOURCE_BUSY', 'AGENT_UNREACHABLE', 'MANAGED_MUTATION_UNCERTAIN', 'UNMANAGED_MUTATION', 'HTTP_418', 'FROM_A_NEWER_AGENT']) assert.equal(upgradeFailureClass(code), 'node');
  for (const code of Object.keys(UPGRADE_REMEDIES)) {
    const entry = upgradeRemedy(code);
    assert.ok(entry.cause.length > 10 && entry.remedy.length > 5, code);
    assert.ok(!(entry.ambiguous && entry.transient), `${code} is ambiguous and must not be retried automatically`);
    assert.ok(!(entry.class === 'release' && entry.transient), `${code} is release evidence and must not be retried automatically`);
  }
});
