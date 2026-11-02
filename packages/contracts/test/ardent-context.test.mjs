import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArdentContextAdoptionInputSchema, ArdentContextReleaseSchema } from '../src/ardent.ts';

test('context adoption is pinned to a release, source tree and current policy without executable configuration', () => {
  const input = { release_id: '11111111-1111-4111-8111-111111111111', expected_bundle_sha256: 'a'.repeat(64),
    expected_base_sha256: 'b'.repeat(64), expected_policy_sha256: 'c'.repeat(64), expected_config_sha256: 'd'.repeat(64) };
  assert.deepEqual(ArdentContextAdoptionInputSchema.parse(input), input);
  for (const extra of [{ command: 'arbitrary' }, { provider_url: 'https://example.com' }, { password: 'fixture' }, { release_id: '../other' }])
    assert.equal(ArdentContextAdoptionInputSchema.safeParse({ ...input, ...extra }).success, false);
  assert.equal(ArdentContextReleaseSchema.safeParse({ schema_version: 1, engine_version: '0.1.0', bundle_sha256: 'a'.repeat(64),
    base_sha256: 'b'.repeat(64), policy_sha256: 'c'.repeat(64), config_sha256: 'd'.repeat(64), single_profile: true, service_unit_matches: true }).success, true);
});
