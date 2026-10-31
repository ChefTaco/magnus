// Runs on Node's built-in test runner; Node strips the types of the imported
// .ts sources, so these tests need no build step.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { magnusObservationSchema } from '../src/magnus-observations.ts';
import { ArdentNodeStateSchema, ArdentProfileSummarySchema } from '../src/ardent.ts';

test('the observations v1 fixture matches its schema', async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/magnus-observations-v1.json', import.meta.url), 'utf8'));
  const parsed = magnusObservationSchema.parse(fixture);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.nodes.length, 1);
});

test('Ardent profile summaries carry any declared channel', () => {
  const profile = { id: 'example', name: 'Example', backend: 'codex', apiPort: 4310, running: true,
    a2aEnabled: false, channels: { telegram: false, mattermost: true }, error: null };
  assert.deepEqual(ArdentProfileSummarySchema.parse(profile).channels, { telegram: false, mattermost: true });
  assert.throws(() => ArdentProfileSummarySchema.parse({ ...profile, channels: { telegram: 'yes' } }));
});

test('Ardent node state requires an ISO timestamp', () => {
  const state = { installed: false, version: null, owner: 'operator', profiles: [], checkedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(ArdentNodeStateSchema.parse(state).owner, 'operator');
  assert.throws(() => ArdentNodeStateSchema.parse({ ...state, checkedAt: 'yesterday' }));
});
