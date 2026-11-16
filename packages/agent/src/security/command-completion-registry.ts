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
  }, {
    id: 'diagnostics-magnus-status-v1',
    command: '/usr/bin/systemctl',
    args: ['status', 'magnus-agent', '--no-pager'],
    environment: {},
    workingDirectory: null,
    timeoutSeconds: 15,
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

/** Request-shape preflight only; this grants no fence or execution authority. */
export function commandCompletionRequestDescriptor(input: Omit<CommandIdentity, 'commandId' | 'coordination'>): CommandCompletionDescriptor | undefined {
  const environment = input.environment ?? {};
  return COMMAND_COMPLETION_REGISTRY.descriptors.find(descriptor => input.command === descriptor.command
    && JSON.stringify(input.args) === JSON.stringify(descriptor.args)
    && (input.workingDirectory ?? null) === descriptor.workingDirectory
    && JSON.stringify(Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
      === JSON.stringify(descriptor.environment)
    && input.timeoutSeconds === descriptor.timeoutSeconds);
}

export function commandCompletionDescriptor(input: CommandIdentity): CommandCompletionDescriptor | undefined {
  const descriptor = commandCompletionRequestDescriptor(input);
  return descriptor && input.coordination?.version === 1
    && new RegExp(descriptor.resourceKeyPattern).test(input.coordination.resourceKey)
    && /^[1-9][0-9]{0,18}$/.test(input.coordination.fence) ? descriptor : undefined;
}

/** Historical evidence retains its original registry identity after an extension. */
export function knownCommandCompletionIdentity(version: unknown, sha256: unknown, id: unknown): boolean {
  return version === 1 && (sha256 === COMMAND_COMPLETION_REGISTRY_SHA256
    && COMMAND_COMPLETION_REGISTRY.descriptors.some(descriptor => descriptor.id === id)
    || sha256 === '2909a7be52ea7242fe37c6dc38e817895989c12d13affbeb4254eb65c46b0029'
    && id === 'diagnostics-uptime-v1');
}
