import { describe, expect, it } from 'vitest';
import { enrollmentTokenFrom, parseCli } from './cli-args.js';

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

describe('enrollment token source', () => {
  const files: Record<string, string> = { '/run/token': 'mne_fixture-token-from-file\n' };
  const read = (path: string | 0) => {
    if (path === 0) return 'mne_fixture-token-from-stdin\n';
    if (files[path] === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return files[path]!;
  };
  it('reads --token, --token-file and standard input, and nothing ambiguous', () => {
    expect(enrollmentTokenFrom(['--token', 'mne_fixture-token'], read)).toEqual({ token: 'mne_fixture-token' });
    expect(enrollmentTokenFrom(['--token=mne_fixture-token'], read)).toEqual({ token: 'mne_fixture-token' });
    expect(enrollmentTokenFrom(['--token-file', '/run/token'], read)).toEqual({ token: 'mne_fixture-token-from-file' });
    expect(enrollmentTokenFrom(['--token-file=-'], read)).toEqual({ token: 'mne_fixture-token-from-stdin' });
    expect(enrollmentTokenFrom(['--token-file', '/missing'], read)).toEqual({ error: expect.stringContaining('ENOENT') });
    for (const bad of [[], ['--token'], ['--token', 'a', '--token-file', '-'], ['--token-file'], ['--token', 'a b'], ['--other', 'x']])
      expect(enrollmentTokenFrom(bad, read)).toHaveProperty('error');
  });
});
