import { describe, expect, it } from 'vitest';
import { agentDisabledMessage } from './agent-privilege';

describe('agentDisabledMessage', () => {
  it('recognizes the agent error body', () => {
    expect(agentDisabledMessage({ success: false, error: { code: 'AGENT_NOT_PRIVILEGED', feature: 'cron', message: 'cron is disabled: agent is not privileged (MAGNUS_AGENT_PRIVILEGED=false)' } }))
      .toBe('Cron management is disabled on this node (its agent runs unprivileged).');
  });

  it('recognizes the error wrapped in Control API text', () => {
    expect(agentDisabledMessage('Agent returned 403: users is disabled: agent is not privileged (MAGNUS_AGENT_PRIVILEGED=false)'))
      .toBe('User management is disabled on this node (its agent runs unprivileged).');
  });

  it('ignores other errors', () => {
    expect(agentDisabledMessage({ error: 'Forbidden' })).toBeNull();
    expect(agentDisabledMessage(undefined)).toBeNull();
  });
});
