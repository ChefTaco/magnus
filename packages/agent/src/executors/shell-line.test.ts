import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { quoteShellArgument, shellCommandLine } from './execution-supervisor-state.js';

const sh = (line: string) => execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8' });

describe('shellCommandLine', () => {
  it('keeps the command a shell string when there are no arguments', () => {
    expect(shellCommandLine('echo a | tr a b', [])).toBe('echo a | tr a b');
  });

  it('passes every argument through the shell literally', () => {
    const args = ['two words', "it's", '$(id)', '`id`', 'a;b', '*', '', '-n', 'x\ny', '"q"', '\\'];
    const out = sh(shellCommandLine(`printf '%s\\0'`, args));
    expect(out.split('\0').slice(0, -1)).toEqual(args);
  });

  it('leaves plain words unquoted and refuses NUL', () => {
    expect(quoteShellArgument('restart')).toBe('restart');
    expect(quoteShellArgument('/etc/app.conf')).toBe('/etc/app.conf');
    expect(() => quoteShellArgument('a\0b')).toThrow(/NUL/);
  });
});
