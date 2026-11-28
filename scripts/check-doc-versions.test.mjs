import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { repositoryConfig, rulesFor, staleReferences } from './check-doc-versions.mjs';

const config = {
  product: 'Widget',
  version: '2.0.0',
  images: ['widget'],
  packages: ['@hivemagnus/widget'],
  known: { Ardent: '3.6.0' },
  exempt: [],
  extra: [],
};
const stale = (text) => staleReferences(text, rulesFor({ ...config, product: 'HiveMem' }));
const widget = (text) => staleReferences(text, rulesFor(config));

test('own image and package references must name the current version', () => {
  assert.deepEqual(widget('docker run ghcr.io/cheftaco/widget:2.0.0\nnpm i @hivemagnus/widget@2.0.0'), []);
  assert.deepEqual(widget('a\nghcr.io/cheftaco/widget:1.9.1\n@hivemagnus/widget@1.0.0'), [
    '2: image "ghcr.io/cheftaco/widget:1.9.1" (allowed: 2.0.0)',
    '3: package "@hivemagnus/widget@1.0.0" (allowed: 2.0.0)',
  ]);
});

test('suite release links and claims name no version, except the retired 1.x launcher documents', () => {
  assert.deepEqual(widget('[guide](https://github.com/ChefTaco/hive/blob/v1.2.2/UPGRADING.md)'), []);
  assert.deepEqual(widget('[guide](https://github.com/ChefTaco/hive/blob/HEAD/README.md)'), []);
  assert.deepEqual(widget('[x](https://github.com/ChefTaco/hive/blob/v3.14.3/README.md)\nsigned Hive 3.14.3 pins Widget 1.0.0.'), [
    '1: Hive suite release link "ChefTaco/hive/blob/v3.14.3/" (allowed: 1.2.2)',
    '2: release claim "Hive 3.14.3 pins" (name no version)',
    '2: pin claim "pins Widget 1.0.0" (allowed: 2.0.0)',
  ]);
  assert.deepEqual(widget('https://github.com/ChefTaco/hive/releases/tag/v3.16.0'), [
    '1: Hive suite release link "ChefTaco/hive/releases/tag/v3.16.0" (name no version)',
  ]);
});

test('pins of other products pass only when this repository holds the pin', () => {
  assert.deepEqual(widget('Widget pins Ardent 3.6.0 and Widget 2.0.0 ships it.'), []);
  assert.deepEqual(widget('Widget pins Ardent 3.5.1; Magnus 3.6.0 pins it too.'), [
    '1: release claim "Magnus 3.6.0 pins" (name no version)',
    '1: pin claim "pins Ardent 3.5.1" (allowed: 3.6.0)',
  ]);
  // A bundled part of this repository may pin an older release of its own package.
  const plugin = rulesFor({ ...config, known: { Widget: ['1.5.0'] } });
  assert.deepEqual(staleReferences('The plugin pins @hivemagnus/widget@1.5.0.', plugin), []);
  assert.deepEqual(staleReferences('The plugin pins @hivemagnus/widget@1.4.0.', plugin), [
    '1: pin claim "pins @hivemagnus/widget@1.4.0" (allowed: 2.0.0, 1.5.0)',
    '1: package "@hivemagnus/widget@1.4.0" (allowed: 2.0.0, 1.5.0)',
  ]);
  // Minimum versions are not claims about the current release.
  assert.deepEqual(stale('Needs Magnus 3.3.0 or later; from Ardent 3.4.0 the list pages.'), []);
});

test('history blocks are exempt', () => {
  assert.deepEqual(widget('<!-- doc-versions: history -->\nHive 3.2.2 installs Widget 0.1.0.\n<!-- /doc-versions -->\nHive 3.2.2 installs it.'), [
    '4: release claim "Hive 3.2.2 installs" (name no version)',
  ]);
});

test('the repository documents name only current versions', () => {
  assert.equal(typeof repositoryConfig().version, 'string');
  execFileSync(process.execPath, [new URL('./check-doc-versions.mjs', import.meta.url).pathname], { stdio: 'pipe' });
});
