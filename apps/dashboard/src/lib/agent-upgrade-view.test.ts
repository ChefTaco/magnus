import { describe, expect, it } from 'vitest';
import { isNotFound, manualMajorUpgradeCount, nodeDetail, readinessTitle, remedyText, retryCount, retryable, runHeadline, targetDescription, upgradeErrorMessage } from './agent-upgrade-view';
import type { AgentUpgradeEligibility, AgentUpgradeRun, SystemUpdates } from '@/types/upgrades';

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

  it('offers a retry for a partial run: its ambiguous nodes and those the check held back, not expected states', () => {
    const partial = { ...run(['confirmed', 'ambiguous'], 'partial'), excluded: [
      { nodeId: 'x', name: 'x', reason: 'stuck', code: 'ENROLLMENT_DRAINING' },
      { nodeId: 'y', name: 'y', reason: 'current', code: 'ALREADY_CURRENT' }] };
    expect(retryCount(partial)).toBe(2);
    expect(retryable({ ...run(['confirmed'], 'partial'), excluded: [{ nodeId: 'y', name: 'y', reason: 'current', code: 'ALREADY_CURRENT' }] })).toBe(false);
  });

  it('tells partial from failed in the headline', () => {
    expect(runHeadline({ ...run(['refused'], 'partial'), attention: [{ nodeId: 'n', name: 'n', state: 'refused', code: 'X', failureClass: 'node', detail: null, cause: 'c', remedy: 'r' }] }))
      .toBe('Last run: partial, 1 node(s) need attention');
    expect(runHeadline(run(['reverted'], 'failed'))).toMatch(/evidence about the release/);
    expect(runHeadline({ ...run(['ambiguous', 'ambiguous'], 'failed'), suspectedRelease: 'suspect' })).toMatch(/suspected but unproven/);
    expect(runHeadline(run(['confirmed'], 'succeeded'))).toBe('Last run: succeeded');
    expect(runHeadline(run(['skipped'], 'stopped'))).toBe('Last run: stopped');
  });

  it('reads remedies from the shared catalogue, with a fallback for codes it does not know', () => {
    expect(remedyText('ENROLLMENT_DRAINING')).toMatch(/complete/);
    expect(remedyText('A_CODE_FROM_THE_FUTURE')).toMatch(/Read the detail/);
    expect(readinessTitle({ status: 'not-ready', observedAt: null, problems: [{ code: 'A', detail: 'b', cause: 'c', remedy: 'd' }] })).toBe('A: b. d');
  });

  it('prefixes the code to the node detail once', () => {
    expect(nodeDetail({ ...run(['refused']).nodes[0]!, code: 'RESOURCE_BUSY', detail: 'busy' })).toBe('RESOURCE_BUSY: busy');
    expect(nodeDetail({ ...run(['refused']).nodes[0]!, code: 'X', detail: 'X: already' })).toBe('X: already');
  });
});

describe('agent major-version notice', () => {
  const agents = (versions: string[], expected = '2.1.2'): SystemUpdates['agents'] => ({
    expected, current: 0, ahead: [], unknown: [], upgradesEnabled: true, fixCommand: null,
    behind: versions.map((version, index) => ({ nodeId: `node-${index}`, name: `Node ${index}`, version })),
  });

  it('counts manual major upgrades separately from same-major updates', () => {
    expect(manualMajorUpgradeCount(agents(['1.1.12', '1.1.4', '2.1.1', '2.1.2-rc.1']))).toBe(2);
    expect(manualMajorUpgradeCount(agents(['2.1.1']))).toBe(0);
    expect(manualMajorUpgradeCount(agents([]))).toBe(0);
  });

  it('does not treat missing or unknown versions as major upgrades', () => {
    expect(manualMajorUpgradeCount(agents(['unknown', '', '1.1.12']))).toBe(1);
    expect(manualMajorUpgradeCount(agents(['1.1.12'], 'unknown'))).toBe(0);
  });
});
