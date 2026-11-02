import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentSelfUpgradeStatusSchema } from '../src/release.ts';

const base = { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, reason: null };

test('an old agent report without the newer fields still parses', () => {
  assert.equal(agentSelfUpgradeStatusSchema.safeParse({ ...base, upgrade: { state: 'idle' } }).success, true);
});

test('the trial window and the sticky enrollment marker are optional fields', () => {
  const parsed = agentSelfUpgradeStatusSchema.parse({ ...base, confirmSeconds: 240,
    managedEnrollment: { nodeId: 'n1', nodeFqdn: 'node-a.example.com' } });
  assert.equal(parsed.confirmSeconds, 240);
  assert.deepEqual(parsed.managedEnrollment, { nodeId: 'n1', nodeFqdn: 'node-a.example.com' });
  assert.equal(agentSelfUpgradeStatusSchema.safeParse({ ...base, managedEnrollment: null }).success, true);
});

test('a future upgrade state and a long reason do not drop the report', () => {
  const parsed = agentSelfUpgradeStatusSchema.parse({ ...base, reason: 'x'.repeat(1000),
    upgrade: { state: 'verifying', reason: 'y'.repeat(1000), requestId: 'r1' } });
  assert.equal(parsed.upgrade?.state, 'verifying');
  assert.equal(agentSelfUpgradeStatusSchema.safeParse({ ...base, upgrade: { state: 'Bad State' } }).success, false);
});
