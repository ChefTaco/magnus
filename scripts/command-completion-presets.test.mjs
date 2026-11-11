import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandCompletionDescriptor } from '../packages/agent/src/security/command-completion-registry.ts';
import { commandExecutionBudget, UPTIME_DIAGNOSTIC } from '../apps/dashboard/src/lib/command-presets.ts';

test('the uptime quick action has a registered whole-effect completion policy', () => {
  const descriptor = commandCompletionDescriptor({ commandId: 'fixture', command: UPTIME_DIAGNOSTIC.command,
    args: [], timeoutSeconds: commandExecutionBudget(UPTIME_DIAGNOSTIC.command),
    coordination: { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 60_000 } });
  assert.equal(descriptor?.id, 'diagnostics-uptime-v1');
});

test('other commands retain their budget and cannot borrow the diagnostic policy', () => {
  for (const command of ['uptime && cat /proc/loadavg', ' /usr/bin/uptime', 'printf fixture']) {
    const timeoutSeconds = commandExecutionBudget(command);
    assert.equal(timeoutSeconds, 300);
    assert.equal(commandCompletionDescriptor({ commandId: 'fixture', command, args: [], timeoutSeconds,
      coordination: { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 300_000 } }), undefined);
  }
});
