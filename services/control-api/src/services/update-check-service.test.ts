import { describe, expect, it } from 'vitest';
import { checkForUpdate, classifyAgentVersions, summarizePackument, updateResult } from './update-check-service.js';
import { agentVersionStatus, warnOnAgentVersionMismatch } from './agent-version-warnings.js';

const manifest = (version: string, extra: Record<string, unknown> = {}) => ({
  schema: 1, version, engines: { node: '^24.22.1 || ^26.13.0' }, components: {}, engineProtocol: 1,
  agent: { selfUpgradeProtocol: 1, minLauncher: 1 }, summary: `Release ${version}`, notesUrl: `https://example.com/${version}`, ...extra,
});
const packument = (...entries: Array<[string, Record<string, unknown> | null]>) =>
  ({ versions: Object.fromEntries(entries.map(([version, m]) => [version, m ? { magnusRelease: m } : {}])) });

describe('update check', () => {
  it('summarizes notes, new settings and risky migrations up to the newest release of the same major', () => {
    const result = summarizePackument(packument(
      ['1.0.3', null],
      ['1.1.0', manifest('1.1.0', { newRequiredEnv: [{ name: 'EXAMPLE_KEY', component: 'server', secret: true, description: 'x' }] })],
      ['1.2.0', manifest('1.2.0', { migrations: [{ name: 'm', impact: 'slow', note: 'rewrites a table' }] })],
      ['2.0.0', manifest('2.0.0')],
    ), '1.0.3', {}, '2026-11-01T00:00:00.000Z');
    expect(result).toMatchObject({ latest: '1.2.0', latestMajor: '2.0.0', updateAvailable: true, command: 'magnus upgrade --to 1.2.0' });
    expect(result.releases.map(r => r.version)).toEqual(['1.1.0', '1.2.0']);
    expect(result.newRequiredEnv).toEqual([expect.objectContaining({ name: 'EXAMPLE_KEY', missingOnServer: true })]);
    expect(result.attention).toEqual([expect.objectContaining({ name: 'm', impact: 'slow' })]);
    expect(updateResult(result).message).toMatch(/1\.2\.0 is available.*EXAMPLE_KEY \(not set here\).*m \(slow\).*2\.0\.0 is a new major/);
  });

  it('is off without a network call when MAGNUS_UPDATE_CHECK=false', async () => {
    let called = false;
    const result = await checkForUpdate({ env: { MAGNUS_UPDATE_CHECK: 'false' }, fetchImpl: (async () => { called = true; return new Response('{}'); }) as typeof fetch });
    expect(result.enabled).toBe(false);
    expect(called).toBe(false);
    expect(updateResult(result).status).toBe('pass');
  });

  it('reports registry problems without throwing', async () => {
    const result = await checkForUpdate({ env: {}, current: '1.0.3', fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch });
    expect(result.error).toMatch(/offline/);
    expect(updateResult(result).status).toBe('warn');
  });
});

describe('agent version skew', () => {
  it('compares by semver, not by string', () => {
    expect(agentVersionStatus('1.0.10', '1.0.9')).toEqual({ updateAvailable: false, relation: 'ahead' });
    expect(agentVersionStatus('1.0.3', '1.1.0')).toEqual({ updateAvailable: true, relation: 'behind' });
    expect(agentVersionStatus(undefined, '1.1.0').relation).toBe('unknown');
    const skew = classifyAgentVersions([
      { nodeId: 'a', name: 'a', version: '1.1.0' }, { nodeId: 'b', name: 'b', version: '1.0.3' }, { nodeId: 'c', name: 'c', version: 'unknown' },
    ], '1.1.0');
    expect(skew).toMatchObject({ current: 1, behind: [{ nodeId: 'b' }], unknown: [{ nodeId: 'c' }] });
  });

  it('warns once per node and version with the exact fix', () => {
    const lines: string[] = [];
    const node = { id: 'n1', name: 'node-1' };
    warnOnAgentVersionMismatch(node, '1.0.3', '1.1.0', line => lines.push(line));
    warnOnAgentVersionMismatch(node, '1.0.3', '1.1.0', line => lines.push(line));
    expect(lines).toEqual([expect.stringMatching(/node-1 runs magnus-agent 1\.0\.3.*Fix: magnus-server agents upgrade --nodes node-1/)]);
    warnOnAgentVersionMismatch(node, '1.1.0', '1.1.0', line => lines.push(line));
    warnOnAgentVersionMismatch(node, '1.0.3', '1.1.0', line => lines.push(line));
    expect(lines).toHaveLength(2);
  });
});
