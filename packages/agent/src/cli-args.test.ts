import { describe, expect, it } from 'vitest';
import { parseCli } from './cli-args.js';

describe('magnus-agent CLI arguments', () => {
  it('defaults to start', () => {
    expect(parseCli([])).toMatchObject({ command: 'start', rest: [], help: false, version: false });
  });
  it('accepts --env-file in both forms and anywhere', () => {
    expect(parseCli(['--env-file', '/etc/magnus-agent.env', 'check', '--json']))
      .toMatchObject({ command: 'check', rest: ['--json'], envFile: '/etc/magnus-agent.env' });
    expect(parseCli(['check', '--env-file=/tmp/a.env'])).toMatchObject({ command: 'check', rest: [], envFile: '/tmp/a.env' });
  });
  it('rejects unknown options and a missing env file path', () => {
    expect(() => parseCli(['--bogus'])).toThrow('unknown option');
    expect(() => parseCli(['--env-file'])).toThrow('--env-file needs a path');
  });
  it('parses help and version flags', () => {
    expect(parseCli(['-h']).help).toBe(true);
    expect(parseCli(['--version']).version).toBe(true);
  });
});
