import { describe, expect, it } from 'vitest';
import { UsageError } from './args.js';
import { parseAgentsArgs } from './agents.js';

describe('agents CLI options', () => {
  it('parses canary, prerelease, retry and stop', () => {
    expect(parseAgentsArgs(['upgrade', '--canary', 'node-1', '--allow-prerelease', '--retry-reverted']))
      .toEqual({ canary: 'node-1', allowPrerelease: true, retryReverted: true, dryRun: false });
    expect(parseAgentsArgs(['upgrade', '--retry', 'run-1'])).toEqual({ retry: 'run-1', dryRun: false });
    expect(parseAgentsArgs(['stop', 'run-1'])).toEqual({ stop: 'run-1', dryRun: false });
  });

  it('rejects an empty node list, a stop without a run and a retry that overrides the run', () => {
    expect(() => parseAgentsArgs(['upgrade', '--nodes', ' , '])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['stop'])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['upgrade', '--retry', 'run-1', '--to', '1.2.0'])).toThrow(UsageError);
  });
});
