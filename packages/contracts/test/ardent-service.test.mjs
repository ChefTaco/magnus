import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARDENT_SERVICE_ADMIN_ACTIONS, ARDENT_SERVICE_CONFIG_PATHS, ARDENT_SERVICE_SUBJECT_ACTIONS, ardentConfigFileSchema,
  ardentServiceActionRequestSchema, ardentServiceRoutes,
} from '../dist/ardent-service.js';

const revision = 'a'.repeat(64);

test('agent changes are separate from the actions any linked person may run', () => {
  assert.deepEqual([...ARDENT_SERVICE_ADMIN_ACTIONS], ['identity-save', 'skill-set', 'config-save', 'skill-install']);
  assert.equal(ARDENT_SERVICE_ADMIN_ACTIONS.some((action) => ARDENT_SERVICE_SUBJECT_ACTIONS.includes(action)), false);
});

test('parses identity, skill and configuration changes with their revisions', () => {
  for (const request of [
    { action: 'identity-save', target: 'soul', body: { text: '# Soul', revision } },
    { action: 'skill-set', target: 'web-research', body: { enabled: true, revision } },
    { action: 'config-save', body: { text: 'profile: lead\n', revision } },
    { action: 'skill-install', body: { source: 'hiveskills', name: 'web-research', version: '1.2.0' } },
    { action: 'skill-install', body: { source: 'hiveskills', name: 'web-research', version: '1.2.0', channel: 'canary', enable: true, revision } },
  ]) assert.equal(ardentServiceActionRequestSchema.safeParse(request).success, true, request.action);
  for (const request of [
    { action: 'identity-save', target: 'agents', body: { text: '# Soul', revision } },
    { action: 'identity-save', target: 'soul', body: { text: '', revision } },
    { action: 'skill-set', target: 'web research', body: { enabled: true, revision } },
    { action: 'skill-set', target: 'web-research', body: { enabled: true } },
    { action: 'config-save', body: { text: 'profile: lead\n', revision: 'stale' } },
    { action: 'config-save', target: 'x', body: { text: 'profile: lead\n', revision } },
    { action: 'config-validate', body: { text: 'profile: lead\n' } },
    { action: 'skill-install', body: { source: 'hiveskills', name: 'web-research', version: '1.2.0', enable: true } },
    { action: 'skill-install', body: { source: 'local', name: 'web-research', version: '1.2.0' } },
    { action: 'skill-install', body: { source: 'hiveskills', name: 'Web_Research', version: '1.2.0' } },
    { action: 'skill-install', body: { source: 'hiveskills', name: 'web-research', version: 'latest' } },
    { action: 'skill-install', target: 'web-research', body: { source: 'hiveskills', name: 'web-research', version: '1.2.0' } },
  ]) assert.equal(ardentServiceActionRequestSchema.safeParse(request).success, false, JSON.stringify(request));
});

test('the configuration read carries text and a revision, and the allowlist names no secret or listener', () => {
  assert.equal(ardentConfigFileSchema.safeParse({ revision, text: 'profile: lead\n' }).success, true);
  for (const path of ARDENT_SERVICE_CONFIG_PATHS) assert.doesNotMatch(path, /_env$|base_url|command|channels|a2a|^api\.|memory|plugins/u, path);
  const action = ardentServiceRoutes.find((route) => route.path.endsWith('/action'));
  assert.match(action.note, /CONFIG_PATH_FORBIDDEN/u);
});

test('task-submit, mission-submit and preview-submit take an optional execution context that is dropped, never refused, when invalid', async () => {
  const { parseArdentExecutionContext } = await import('../dist/ardent-service.js');
  const execution = { v: 1, root: 'hx1:studio:inst-1:request:req-1', self: 'hx1:studio:inst-1:step:req-1/2', attempt: 2, deadline_ms: 1 };
  const task = { action: 'task-submit', body: { prompt: 'Hi', idempotency_key: '00000000-0000-4000-8000-000000000001' } };
  assert.deepEqual(ardentServiceActionRequestSchema.parse({ ...task, execution: { ...execution, extra: true } }).execution, execution);
  for (const invalid of [{ v: 2, root: execution.root }, { v: 1, root: 'hx1:studio:inst-1:bogus:x' }, { v: 1 }, 'text', null, { v: 1, root: execution.root, inputs: Array(17).fill(execution.root) }]) {
    const parsed = ardentServiceActionRequestSchema.safeParse({ ...task, execution: invalid });
    assert.equal(parsed.success, true, JSON.stringify(invalid));
    assert.equal(parsed.data.execution, undefined);
  }
  assert.deepEqual(parseArdentExecutionContext({ v: 1, root: execution.root, inputs: [] }), { v: 1, root: execution.root });
  assert.equal(ardentServiceActionRequestSchema.safeParse({ ...task, context: execution }).success, false);
});

test('parses recovery decisions and artifact imports with bounded fields', () => {
  const target = '00000000-0000-4000-8000-000000000001';
  for (const request of [
    { action: 'task-recovery', target, body: { action: 'abandon' } },
    { action: 'task-recovery', target, body: { action: 'mark_applied', call_id: 'c1', result: { ok: true }, note: 'checked' } },
    { action: 'task-recovery', target, body: { action: 'retry_with_new_deadline', deadline_seconds: 600 } },
    { action: 'artifact-import', body: { peer_id: 'peer-1', a2a_task_id: 'remote', artifact_id: 'a'.repeat(32) } },
    { action: 'artifact-import', body: { peer_id: 'peer-1', a2a_task_id: 'remote', artifact_id: 'a'.repeat(32), task_id: target } },
  ]) assert.equal(ardentServiceActionRequestSchema.safeParse(request).success, true, JSON.stringify(request));
  for (const request of [
    { action: 'task-recovery', body: { action: 'abandon' } },
    { action: 'task-recovery', target, body: { action: 'retry' } },
    { action: 'task-recovery', target, body: { action: 'abandon', deadline_seconds: 86_401 } },
    { action: 'task-recovery', target, body: { action: 'mark_applied', result: 'x'.repeat(70_000) } },
    { action: 'task-recovery', target, body: { action: 'abandon', extra: 1 } },
    { action: 'artifact-import', body: { peer_id: 'peer 1', a2a_task_id: 'remote', artifact_id: 'a'.repeat(32) } },
    { action: 'artifact-import', body: { peer_id: 'peer-1', a2a_task_id: '', artifact_id: 'a'.repeat(32) } },
    { action: 'artifact-import', target, body: { peer_id: 'peer-1', a2a_task_id: 'remote', artifact_id: 'a'.repeat(32) } },
  ]) assert.equal(ardentServiceActionRequestSchema.safeParse(request).success, false, JSON.stringify(request));
  assert.ok(ardentServiceRoutes.some((route) => route.path.endsWith('/artifacts/{sha256}/content')));
});

test('derives profile capabilities from the status of Ardent 3.2.0 and the version of older runtimes', async () => {
  const { ardentProfileCapabilities, ardentVersionAtLeast, ARDENT_RUNTIME_GATES } = await import('../dist/ardent.js');
  const current = { version: '3.2.0', capabilities: { artifact_transfer: 2 }, recovery: { ready: 0, reconciling: 0, awaiting_decision: 0, unsupported: 0 } };
  assert.deepEqual(ardentProfileCapabilities(current, '3.2.0'), { version: '3.2.0', capabilities: { recovery: 1, lineage: 1, artifact_transfer: 2 } });
  assert.deepEqual(ardentProfileCapabilities({ version: '3.1.4' }, '3.2.0'), { version: '3.1.4', capabilities: { recovery: 0, lineage: 0, artifact_transfer: 1 } });
  // A stopped profile gets what its installed package offers.
  assert.deepEqual(ardentProfileCapabilities(undefined, '3.2.0'), { version: '3.2.0', capabilities: { recovery: 1, lineage: 1, artifact_transfer: 2 } });
  assert.deepEqual(ardentProfileCapabilities(undefined, '3.1.4'), { version: '3.1.4', capabilities: { recovery: 0, lineage: 0, artifact_transfer: 1 } });
  assert.deepEqual(ardentProfileCapabilities(undefined, null), { version: null, capabilities: { recovery: 0, lineage: 0, artifact_transfer: 1 } });
  // The node agent caps what it does not relay.
  assert.deepEqual(ardentProfileCapabilities(current, null, { recovery: 0, artifact_transfer: 1 }).capabilities, { recovery: 0, lineage: 1, artifact_transfer: 1 });
  assert.equal(ardentVersionAtLeast('3.10.0', '3.2.0'), true);
  assert.equal(ardentVersionAtLeast('3.2.0-rc.1', '3.2.0'), false);
  assert.equal(ardentVersionAtLeast('4.0.0', '3.2.0'), true);
  assert.equal(ardentVersionAtLeast('latest', '3.2.0'), false);
  assert.deepEqual(Object.fromEntries(Object.entries(ARDENT_RUNTIME_GATES).map(([gate, value]) => [gate, value.capability])),
    { recovery: 'ardent.recovery.v1', lineage: 'ardent.lineage.v1', artifact_transfer: 'artifact-transfer.v2' });
});
