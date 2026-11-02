import { describe, expect, it } from 'vitest';
import { UsageError } from './args.js';
import { doctorLines, parseAgentsArgs } from './agents.js';

describe('agents CLI options', () => {
  it('parses canary, prerelease, retry and stop', () => {
    expect(parseAgentsArgs(['upgrade', '--canary', 'node-1', '--allow-prerelease', '--retry-reverted']))
      .toEqual({ canary: 'node-1', allowPrerelease: true, retryReverted: true, dryRun: false });
    expect(parseAgentsArgs(['upgrade', '--retry', 'run-1'])).toEqual({ retry: 'run-1', dryRun: false });
    expect(parseAgentsArgs(['stop', 'run-1'])).toEqual({ stop: 'run-1', dryRun: false });
  });

  it('parses doctor, its repair switch, the failure budget and the fence command', () => {
    expect(parseAgentsArgs(['doctor', '--nodes', 'a,b'])).toEqual({ doctor: true, nodes: ['a', 'b'], dryRun: false });
    expect(parseAgentsArgs(['doctor', '--heal'])).toEqual({ doctor: true, heal: true, dryRun: false });
    expect(parseAgentsArgs(['upgrade', '--max-failures', '5'])).toEqual({ maxFailures: 5, dryRun: false });
    expect(parseAgentsArgs(['fence', 'node-1', '1789962351090'])).toEqual({ fence: { node: 'node-1', value: '1789962351090' }, dryRun: false });
    expect(() => parseAgentsArgs(['upgrade', '--heal'])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['upgrade', '--max-failures', '0'])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['upgrade', '--max-failures', 'many'])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['fence', 'node-1'])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['fence', 'node-1', '-5'])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['fence', 'node-1', '12a'])).toThrow(UsageError);
  });

  it('prints each node of a check with what to do about its problems', () => {
    const lines = doctorLines({ version: '1.1.8', release: { verified: false, integrity: null, reason: 'offline' }, eligible: 1, blocked: 1, nodes: [
      { nodeId: 'a', name: 'node-a', version: '1.1.7', eligible: true, reason: null, code: null, upgrade: null, layout: 'versioned', cause: null, remedy: null,
        preflight: { status: 'warning', checkedAt: '', problems: [{ code: 'FENCE_AHEAD', detail: 'fence 9 vs 1', blocking: false }], healed: ['moved the fence'],
          report: { preflightProtocol: 1, version: '1.1.7', layout: 'versioned', disk: { freeBytes: 2 ** 31, requiredBytes: 1, low: false }, npm: { present: true, version: '11.0.0' } } } },
      { nodeId: 'b', name: 'node-b', version: '1.1.7', eligible: false, reason: 'stuck in draining', code: 'ENROLLMENT_DRAINING', upgrade: null, layout: 'versioned', cause: 'x', remedy: 'y' },
    ] }).join('\n');
    expect(lines).toMatch(/not verified on the registry: offline/);
    expect(lines).toMatch(/node-a {2}1\.1\.7 {2}ready {2}\(versioned, 2048 MiB free, npm 11\.0\.0\)/);
    expect(lines).toMatch(/FENCE_AHEAD \(fence 9 vs 1\)/);
    expect(lines).toMatch(/repaired: moved the fence/);
    expect(lines).toMatch(/node-b {2}1\.1\.7 {2}blocked {2}\(preflight not run\)/);
    expect(lines).toMatch(/enrollment\/<nodeId>\/complete/);
    expect(lines).toMatch(/1 ready, 1 blocked, 0 not applicable/);
  });

  it('rejects an empty node list, a stop without a run and a retry that overrides the run', () => {
    expect(() => parseAgentsArgs(['upgrade', '--nodes', ' , '])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['stop'])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['upgrade', '--retry', 'run-1', '--to', '1.2.0'])).toThrow(UsageError);
  });
});
