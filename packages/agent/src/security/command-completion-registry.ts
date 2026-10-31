/** Finite commands whose empty supervised cgroup proves the whole requested effect ended. */
import { createHash } from 'node:crypto';
import type { CommandIdentity } from '../executors/command-ledger.js';

export const COMMAND_COMPLETION_REGISTRY = {
  version: 1,
  descriptors: [{
    id: 'diagnostics-uptime-v1',
    command: '/usr/bin/uptime',
    args: [],
    environment: {},
    workingDirectory: null,
    timeoutSeconds: 60,
    resourceKeyPattern: '^node:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$',
    completionMode: 'supervised-cgroup-empty',
    participantAuthority: {
      allowedKinds: ['ssh-command'],
      effectSemantics: 'read-only-node-diagnostic',
      effectBoundary: 'bounded-node-process',
    },
  }],
} as const;

export type CommandCompletionDescriptor = (typeof COMMAND_COMPLETION_REGISTRY.descriptors)[number];
export const COMMAND_COMPLETION_REGISTRY_SHA256 = createHash('sha256')
  .update(JSON.stringify(COMMAND_COMPLETION_REGISTRY)).digest('hex');

export function commandCompletionDescriptor(input: CommandIdentity): CommandCompletionDescriptor | undefined {
  const environment = input.environment ?? {};
  return COMMAND_COMPLETION_REGISTRY.descriptors.find(descriptor => input.command === descriptor.command
    && JSON.stringify(input.args) === JSON.stringify(descriptor.args)
    && (input.workingDirectory ?? null) === descriptor.workingDirectory
    && JSON.stringify(Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
      === JSON.stringify(descriptor.environment)
    && input.timeoutSeconds === descriptor.timeoutSeconds
    && input.coordination?.version === 1
    && new RegExp(descriptor.resourceKeyPattern).test(input.coordination.resourceKey)
    && /^[1-9][0-9]{0,18}$/.test(input.coordination.fence));
}
