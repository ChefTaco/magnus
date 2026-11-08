import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARDENT_SERVICE_ADMIN_ACTIONS, ARDENT_SERVICE_CONFIG_PATHS, ARDENT_SERVICE_SUBJECT_ACTIONS, ardentConfigFileSchema,
  ardentServiceActionRequestSchema, ardentServiceRoutes,
} from '../dist/ardent-service.js';

const revision = 'a'.repeat(64);

test('agent changes are separate from the actions any linked person may run', () => {
  assert.deepEqual([...ARDENT_SERVICE_ADMIN_ACTIONS], ['identity-save', 'skill-set', 'config-save']);
  assert.equal(ARDENT_SERVICE_ADMIN_ACTIONS.some((action) => ARDENT_SERVICE_SUBJECT_ACTIONS.includes(action)), false);
});

test('parses identity, skill and configuration changes with their revisions', () => {
  for (const request of [
    { action: 'identity-save', target: 'soul', body: { text: '# Soul', revision } },
    { action: 'skill-set', target: 'web-research', body: { enabled: true, revision } },
    { action: 'config-save', body: { text: 'profile: lead\n', revision } },
  ]) assert.equal(ardentServiceActionRequestSchema.safeParse(request).success, true, request.action);
  for (const request of [
    { action: 'identity-save', target: 'agents', body: { text: '# Soul', revision } },
    { action: 'identity-save', target: 'soul', body: { text: '', revision } },
    { action: 'skill-set', target: 'web research', body: { enabled: true, revision } },
    { action: 'skill-set', target: 'web-research', body: { enabled: true } },
    { action: 'config-save', body: { text: 'profile: lead\n', revision: 'stale' } },
    { action: 'config-save', target: 'x', body: { text: 'profile: lead\n', revision } },
    { action: 'config-validate', body: { text: 'profile: lead\n' } },
  ]) assert.equal(ardentServiceActionRequestSchema.safeParse(request).success, false, JSON.stringify(request));
});

test('the configuration read carries text and a revision, and the allowlist names no secret or listener', () => {
  assert.equal(ardentConfigFileSchema.safeParse({ revision, text: 'profile: lead\n' }).success, true);
  for (const path of ARDENT_SERVICE_CONFIG_PATHS) assert.doesNotMatch(path, /_env$|base_url|command|channels|a2a|^api\.|memory|plugins/u, path);
  const action = ardentServiceRoutes.find((route) => route.path.endsWith('/action'));
  assert.match(action.note, /CONFIG_PATH_FORBIDDEN/u);
});
