import { expect, test } from 'vitest';
import { commandCompletionDescriptor } from '../../../../packages/agent/src/security/command-completion-registry';
import { commandExecutionBudget, UPTIME_DIAGNOSTIC } from './command-presets';

test('the uptime quick action has a registered whole-effect completion policy', () => {
  const descriptor = commandCompletionDescriptor({ commandId: 'fixture', command: UPTIME_DIAGNOSTIC.command,
    args: [], timeoutSeconds: commandExecutionBudget(UPTIME_DIAGNOSTIC.command),
    coordination: { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 60_000 } });
  expect(descriptor?.id).toBe('diagnostics-uptime-v1');
});

test('other commands retain the existing budget and cannot borrow the diagnostic policy', () => {
  for (const command of ['uptime && cat /proc/loadavg', ' /usr/bin/uptime', 'printf fixture']) {
    const timeoutSeconds = commandExecutionBudget(command);
    expect(timeoutSeconds).toBe(300);
    expect(commandCompletionDescriptor({ commandId: 'fixture', command, args: [], timeoutSeconds,
      coordination: { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 300_000 } })).toBeUndefined();
  }
});
