import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { checkArdentPins, compareVersions, pinnedArdentVersions } from './check-ardent-latest.mjs';

const pins = version => ({ 'package.json': version, 'packages/agent/package.json': version, 'packages/agent/npm-shrinkwrap.json': version });

test('compares exact versions numerically', () => {
  assert.equal(compareVersions('2.1.2', '2.1.10'), -1);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('2.1.2', '2.1.2'), 0);
  assert.throws(() => compareVersions('^2.1.2', '2.1.2'));
});

test('accepts pins that equal the latest release', () => {
  assert.deepEqual(checkArdentPins(pins('2.1.2'), '2.1.2'), []);
});

test('fails when Magnus is behind the latest Ardent release', () => {
  const [problem] = checkArdentPins(pins('2.1.1'), '2.2.0');
  assert.match(problem, /2\.1\.1.*2\.2\.0 is the latest/);
});

test('fails when the pins disagree or are ranges', () => {
  assert.match(checkArdentPins({ ...pins('2.1.2'), 'packages/agent/package.json': '2.1.1' }, '2.1.2')[0], /disagree/);
  assert.match(checkArdentPins({ ...pins('2.1.2'), 'package.json': '^2.1.2' }, '2.1.2')[0], /exact version/);
});

test('the repository pins agree with each other', () => {
  const found = pinnedArdentVersions(resolve(import.meta.dirname, '..'));
  assert.equal(new Set(Object.values(found)).size, 1, JSON.stringify(found));
});
