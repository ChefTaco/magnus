import { describe, expect, it } from 'vitest';
import { COMMAND_COMPLETION_REGISTRY, COMMAND_COMPLETION_REGISTRY_SHA256, commandCompletionDescriptor,
  commandCompletionRequestDescriptor, knownCommandCompletionIdentity } from './command-completion-registry.js';

const input = () => ({ commandId: 'diagnostic-one', command: '/usr/bin/uptime', args: [], timeoutSeconds: 60,
  coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '4', expiresAt: 4_102_444_800_000 } });

describe('finite command completion registry', () => {
  it('is explicit, versioned and digest-bound', () => {
    expect(COMMAND_COMPLETION_REGISTRY.version).toBe(1);
    expect(COMMAND_COMPLETION_REGISTRY.descriptors.map(value => value.id)).toEqual(['diagnostics-uptime-v1', 'diagnostics-magnus-status-v1']);
    expect(COMMAND_COMPLETION_REGISTRY_SHA256).toBe('9a3c624e02974750c5f96821afdc8a5753413d643f91be3d0f197f39abe7ce47');
    expect(commandCompletionDescriptor(input())).toMatchObject({ id: 'diagnostics-uptime-v1', participantAuthority: {
      allowedKinds: ['ssh-command'], effectSemantics: 'read-only-node-diagnostic', effectBoundary: 'bounded-node-process' } });
  });

  it.each([
    { command: '/bin/uptime' },
    { args: ['--pretty'] },
    { environment: { LANG: 'C' } },
    { workingDirectory: '/tmp' },
    { timeoutSeconds: 59 },
    { coordination: undefined },
    { coordination: { ...input().coordination, resourceKey: 'provider:fixture' } },
    { coordination: { ...input().coordination, fence: '0' } },
  ])('keeps changed or unregistered identity outside terminal evidence: %o', change => {
    expect(commandCompletionDescriptor({ ...input(), ...change })).toBeUndefined();
  });

  it('does not classify external-service handoffs or arbitrary shell text', () => {
    expect(commandCompletionDescriptor({ ...input(), command: '/usr/bin/systemctl', args: ['restart', 'fixture.service'] })).toBeUndefined();
    expect(commandCompletionDescriptor({ ...input(), command: '/bin/bash', args: ['-c', '/usr/bin/uptime'] })).toBeUndefined();
  });

  it('requires exact bounded status argv, timeout, environment, directory and coordination', () => {
    const status = { ...input(), command: '/usr/bin/systemctl', args: ['status', 'magnus-agent', '--no-pager'], timeoutSeconds: 15 };
    expect(commandCompletionDescriptor(status)?.id).toBe('diagnostics-magnus-status-v1');
    for (const patch of [{ command: 'systemctl' }, { args: ['restart', 'magnus-agent'] },
      { args: ['status', 'foreign', '--no-pager'] }, { args: ['status', 'magnus-agent'] },
      { timeoutSeconds: 16 }, { environment: { SYSTEMD_PAGER: '/bin/sh' } },
      { workingDirectory: '/tmp' }, { coordination: undefined }])
      expect(commandCompletionDescriptor({ ...status, ...patch })).toBeUndefined();
    const { coordination: _coordination, ...unfenced } = status;
    expect(commandCompletionRequestDescriptor(unfenced)?.id).toBe('diagnostics-magnus-status-v1');
  });

  it('preserves only original uptime authority under the historical registry digest', () => {
    const previous = '2909a7be52ea7242fe37c6dc38e817895989c12d13affbeb4254eb65c46b0029';
    expect(knownCommandCompletionIdentity(1, previous, 'diagnostics-uptime-v1')).toBe(true);
    expect(knownCommandCompletionIdentity(1, previous, 'diagnostics-magnus-status-v1')).toBe(false);
    expect(knownCommandCompletionIdentity(1, COMMAND_COMPLETION_REGISTRY_SHA256, 'diagnostics-magnus-status-v1')).toBe(true);
    expect(knownCommandCompletionIdentity(1, 'f'.repeat(64), 'diagnostics-uptime-v1')).toBe(false);
    expect(knownCommandCompletionIdentity(2, previous, 'diagnostics-uptime-v1')).toBe(false);
    expect(knownCommandCompletionIdentity(null, null, null)).toBe(false);
  });
});
