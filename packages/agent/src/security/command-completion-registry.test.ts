import { describe, expect, it } from 'vitest';
import { COMMAND_COMPLETION_REGISTRY, COMMAND_COMPLETION_REGISTRY_SHA256, commandCompletionDescriptor } from './command-completion-registry.js';

const input = () => ({ commandId: 'diagnostic-one', command: '/usr/bin/uptime', args: [], timeoutSeconds: 60,
  coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '4', expiresAt: 4_102_444_800_000 } });

describe('finite command completion registry', () => {
  it('is explicit, versioned and digest-bound', () => {
    expect(COMMAND_COMPLETION_REGISTRY.version).toBe(1);
    expect(COMMAND_COMPLETION_REGISTRY.descriptors.map(value => value.id)).toEqual(['diagnostics-uptime-v1']);
    expect(COMMAND_COMPLETION_REGISTRY_SHA256).toBe('2909a7be52ea7242fe37c6dc38e817895989c12d13affbeb4254eb65c46b0029');
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
});
