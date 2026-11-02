import { describe, expect, it } from 'vitest';
import { isNotFound, nodeDetail, retryable, targetDescription, upgradeErrorMessage } from './agent-upgrade-view';
import type { AgentUpgradeEligibility, AgentUpgradeRun } from '@/types/upgrades';

const eligibility = (extra: Partial<AgentUpgradeEligibility> = {}): AgentUpgradeEligibility => ({
  version: '1.1.3', serverVersion: '1.1.3', upgradesEnabled: true, disabledReason: null, nodes: [], latestRun: null, ...extra });
const run = (states: AgentUpgradeRun['nodes'][number]['state'][], status: AgentUpgradeRun['status'] = 'failed'): AgentUpgradeRun => ({
  id: 'r', version: '1.1.3', status, startedAt: '', finishedAt: null, concurrency: 1, message: null,
  nodes: states.map((state, index) => ({ nodeId: `n${index}`, name: `node-${index}`, from: '1.1.2', state, detail: null })) });

describe('agent upgrade dialog text', () => {
  it('shows the server error message and code instead of the HTTP status line', async () => {
    const error = Object.assign(new Error('Request failed with status code 409 Conflict'), {
      data: { success: false, error: { code: 'NO_ELIGIBLE_AGENTS', message: 'No selected agent can be upgraded now' } } });
    expect(await upgradeErrorMessage(error)).toBe('No selected agent can be upgraded now (NO_ELIGIBLE_AGENTS)');
    expect(await upgradeErrorMessage(new Error('offline'))).toBe('offline');
  });

  it('recognises a missing run', () => {
    expect(isNotFound({ response: { status: 404 } })).toBe(true);
    expect(isNotFound(new Error('x'))).toBe(false);
  });

  it('names the target accurately and flags unverified releases', () => {
    expect(targetDescription(eligibility())).toBe('Target: magnus-agent 1.1.3 (the agent version bundled with this server)');
    expect(targetDescription(eligibility({ version: '1.2.0-rc.1', prerelease: true, release: { verified: false, integrity: null, reason: 'not published' } })))
      .toBe('Target: magnus-agent 1.2.0-rc.1, a prerelease; not verified on the registry: not published');
  });

  it('offers a retry only for finished runs with nodes left over', () => {
    expect(retryable(run(['confirmed', 'refused']))).toBe(true);
    expect(retryable(run(['confirmed'], 'succeeded'))).toBe(false);
    expect(retryable(run(['refused'], 'running'))).toBe(false);
  });

  it('prefixes the code to the node detail once', () => {
    expect(nodeDetail({ ...run(['refused']).nodes[0]!, code: 'RESOURCE_BUSY', detail: 'busy' })).toBe('RESOURCE_BUSY: busy');
    expect(nodeDetail({ ...run(['refused']).nodes[0]!, code: 'X', detail: 'X: already' })).toBe('X: already');
  });
});
