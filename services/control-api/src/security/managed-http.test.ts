import { describe, expect, it } from 'vitest';
import * as control from './managed-http.js';
import * as node from '../../../../packages/agent/src/security/managed-http.js';
import * as controlRegistry from './native-completion-registry.js';
import * as nodeRegistry from '../../../../packages/agent/src/security/native-completion-registry.js';
import * as controlCommandRegistry from './command-completion-registry.js';
import * as nodeCommandRegistry from '../../../../packages/agent/src/security/command-completion-registry.js';
describe('native HTTP wire compatibility', () => {
  it('binds method, exact path, body bytes and timeout identically on both endpoints', () => {
    for (const body of ['{}', '{"secret":"private"}', '']) {
      const args = ['native-fixture', 'POST', '/files/write', body, 10] as const;
      expect(control.httpIdentity(...args)).toEqual(node.httpIdentity(...args));
      expect(control.httpReceiptBody('POST', '/files/write', 200, body)).toBe(node.httpReceiptBody('POST', '/files/write', 200, body));
      expect(JSON.stringify(control.httpIdentity(...args))).not.toContain('private');
    }
  });
  it('shares the exact versioned native completion registry and digest', () => {
    expect(controlRegistry.NATIVE_COMPLETION_REGISTRY).toEqual(nodeRegistry.NATIVE_COMPLETION_REGISTRY);
    expect(controlRegistry.NATIVE_COMPLETION_REGISTRY_SHA256).toBe(nodeRegistry.NATIVE_COMPLETION_REGISTRY_SHA256);
    expect(controlRegistry.NATIVE_COMPLETION_REGISTRY_SHA256).toBe('b0f05a1eac40dba262ec5ff0cc0de8d2b7c9f119a6a2d7ed3a00d94dcb6b1d3d');
    expect(controlRegistry.NATIVE_COMPLETION_REGISTRY.version).toBe(1);
    expect(controlRegistry.NATIVE_COMPLETION_REGISTRY.descriptors).toHaveLength(9);
    // Agent self-upgrade is the one lifecycle mutation in the registry: exact version and integrity, launcher-confirmed.
    expect(controlRegistry.nativeCompletionDescriptor('POST', '/agent-upgrade')).toMatchObject({ id: 'agent-self-upgrade', resourceClassifier: 'node-filesystem' });
  });
  it('shares the exact finite command completion registry and digest', () => {
    expect(controlCommandRegistry.COMMAND_COMPLETION_REGISTRY).toEqual(nodeCommandRegistry.COMMAND_COMPLETION_REGISTRY);
    expect(controlCommandRegistry.COMMAND_COMPLETION_REGISTRY_SHA256).toBe(nodeCommandRegistry.COMMAND_COMPLETION_REGISTRY_SHA256);
    expect(controlCommandRegistry.COMMAND_COMPLETION_REGISTRY_SHA256).toBe('2909a7be52ea7242fe37c6dc38e817895989c12d13affbeb4254eb65c46b0029');
    expect(controlCommandRegistry.commandCompletionDescriptor({ commandId: 'diagnostic', command: '/usr/bin/uptime', args: [],
      timeoutSeconds: 60, coordination: { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 60_000 } }))
      .toEqual(nodeCommandRegistry.commandCompletionDescriptor({ commandId: 'diagnostic', command: '/usr/bin/uptime', args: [],
        timeoutSeconds: 60, coordination: { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 60_000 } }));
  });
  it('preserves only the finite reviewed paths with completion, timeout and resource descriptors', () => {
    const allowed = [
      ['POST', '/files/write', 'node-filesystem'], ['POST', '/skills/install', 'node-skill-catalog'],
      ['DELETE', '/skills/example', 'node-skill-catalog'], ['POST', '/cron/managed-sync', 'node-scheduler'],
      ['POST', '/cron/managed-activate', 'node-scheduler'], ['POST', '/cron/managed-revoke', 'node-scheduler'],
      ['DELETE', '/cron/example', 'node-scheduler'],
      ['POST', '/ardent/action', 'node-ardent'],
    ] as const;
    for (const [method, path, resourceClassifier] of allowed) {
      const controlDescriptor = controlRegistry.nativeCompletionDescriptor(method, path);
      const nodeDescriptor = nodeRegistry.nativeCompletionDescriptor(method, path);
      expect(controlDescriptor).toEqual(nodeDescriptor);
      expect(controlDescriptor).toMatchObject({ completionMode: 'buffered-synchronous-http',
        timeoutCeilingSeconds: path === '/ardent/action' ? 900 : 3600, resourceClassifier });
      expect(controlRegistry.nativeCompletionResourceKey(controlDescriptor!, 'fixture')).toBe(
        path === '/ardent/action' ? 'node:fixture:ardent' : 'node:fixture');
      expect(nodeRegistry.nativeCompletionResourceKey(nodeDescriptor!, 'fixture')).toBe(
        path === '/ardent/action' ? 'node:fixture:ardent' : 'node:fixture');
    }
  });
  it('keeps lifecycle, login, raw recurring work and detached handlers outside the registry', () => {
    const denied = ['/update', '/self-update', '/codex/update', '/codex/device-auth', '/cron/sync', '/cron/example',
      '/ai-schedules', '/hermes/install', '/hermes/update', '/hermes/configure', '/hermes/uninstall',
      '/deploy', '/rollouts', '/quick-command', '/terminal', '/commands/execute'];
    for (const path of denied) expect(controlRegistry.nativeCompletionDescriptor('POST', path), path).toBeUndefined();
    for (const path of ['/skills/a/b', '/skills/a%2Fb', '/cron/a/b', '/cron/a%2Fb'])
      expect(controlRegistry.nativeCompletionDescriptor('DELETE', path), path).toBeUndefined();
  });
  it('shares exact nonce-bound authoritative legacy admission schemas', () => {
    const value = { nodeFqdn: 'fixture.lab', nonce: '00000000-0000-4000-8000-000000000000',
      nodeId: 'fixture', enrolled: true, gateEnabled: false, allowedLegacy: false };
    expect(control.legacyAdmissionResponseSchema.parse(value)).toEqual(node.legacyAdmissionResponseSchema.parse(value));
    expect(control.legacyAdmissionResponseSchema.safeParse({ ...value, unexpected: true }).success).toBe(false);
    expect(node.legacyAdmissionResponseSchema.safeParse({ ...value, nonce: 'stale' }).success).toBe(false);
  });
  it('limits the explicit recovery-only discriminator to atomic skill publication', () => {
    const request = { claim: { leaseId: 'lease', nodeId: 'fixture', nodeFqdn: 'fixture.lab' },
      commandId: 'skill-recovery', method: 'POST' as const, path: '/skills/install', body: '{}', timeoutSeconds: 10,
      coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 10_000 } };
    expect(control.managedHttpRequestSchema.parse({ ...request, recoveryOnly: true }).recoveryOnly).toBe(true);
    expect(control.managedHttpRequestSchema.parse(request)).not.toHaveProperty('recoveryOnly');
    for (const changed of [{ ...request, path: '/files/write', recoveryOnly: true },
      { ...request, method: 'DELETE' as const, recoveryOnly: true },
      { ...request, recoveryOnly: false }, { ...request, recoveryOnly: true, extra: true }])
      expect(control.managedHttpRequestSchema.safeParse(changed).success).toBe(false);
  });

});
