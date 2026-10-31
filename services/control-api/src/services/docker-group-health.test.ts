import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDockerGroupHealthOnControlNode } from './docker-group-health.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const exec = vi.mocked(execFileSync);

beforeEach(() => {
  vi.stubEnv('MAGNUS_DOCKER_USER', 'fixture-user');
  exec.mockReset();
  exec.mockImplementation((command, args) => {
    if (command === 'id' && args?.[0] === '-nG') return 'fixture-user docker\n';
    return Buffer.from('');
  });
});
afterEach(() => {
  // Every branch is constrained to this fixed read-only executable/argument set.
  for (const [command, args, options] of exec.mock.calls) {
    expect(['docker', 'getent', 'id']).toContain(command);
    if (command === 'docker') expect(args).toEqual(['--version']);
    if (command === 'getent') expect(args).toEqual(['group', 'docker']);
    if (command === 'id') {
      expect(['-u', '-nG']).toContain(args?.[0]);
      expect(args?.[1]).toBe('--');
      expect(args).toHaveLength(3);
    }
    expect(options).toMatchObject({ timeout: 3000, maxBuffer: 64 * 1024 });
  }
  vi.unstubAllEnvs();
});
function inspect() {
  const value = checkDockerGroupHealthOnControlNode();
  expect(value).toMatchObject({ remediationAttempted: false, remediationSucceeded: false, requiresRecheck: false });
  expect(Object.keys(value).sort()).toEqual(['status', 'dockerInstalled', 'targetUser', 'targetUserSource', 'userExists', 'inDockerGroup', 'remediationAttempted', 'remediationSucceeded', 'requiresRecheck', 'message'].sort());
  return value;
}
function failAt(commandName: string, firstArg: string, error: unknown = new Error('private command diagnostic')) {
  exec.mockImplementation((command, args) => {
    if (command === commandName && args?.[0] === firstArg) throw error;
    return command === 'id' && args?.[0] === '-nG' ? 'fixture-user docker\n' : Buffer.from('');
  });
}
describe('Docker group health is observation only', () => {
  it('reports healthy existing membership without account changes', () => {
    expect(inspect()).toMatchObject({ status: 'healthy', dockerInstalled: true, userExists: true, inDockerGroup: true });
    expect(exec).toHaveBeenCalledTimes(4);
  });
  it('skips when Docker detection fails', () => {
    failAt('docker', '--version');
    expect(inspect()).toMatchObject({ status: 'not-applicable', dockerInstalled: false });
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('warns when deploy username is unavailable without probing identities', () => {
    vi.stubEnv('MAGNUS_DOCKER_USER', '   ');
    expect(inspect()).toMatchObject({ status: 'warning', targetUser: null, targetUserSource: 'unavailable' });
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('warns when user lookup fails without attempting to create a user or group', () => {
    failAt('id', '-u');
    expect(inspect()).toMatchObject({ status: 'warning', userExists: false });
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it.each([new Error('group unavailable'), Object.assign(new Error('lookup timed out'), { code: 'ETIMEDOUT' }), 'unexpected lookup failure'])('requires operator permission when group lookup fails: %s', error => {
    failAt('getent', 'group', error);
    const result = inspect();
    expect(result).toMatchObject({ status: 'warning', userExists: true, inDockerGroup: false });
    expect(result.message).toContain('Operator permission via Telegram');
    expect(exec).toHaveBeenCalledTimes(3);
  });
  it.each(['fixture-user users\n', 'fixture-user dockerish notdocker\n', ''])('warns on unverified membership without usermod: %j', groups => {
    exec.mockImplementation((command, args) => command === 'id' && args?.[0] === '-nG' ? groups : Buffer.from(''));
    const result = inspect();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Operator permission via Telegram');
  });
  it('handles failed membership observation without leaking command diagnostics', () => {
    failAt('id', '-nG');
    const result = inspect();
    expect(result.status).toBe('warning');
    expect(result.message).not.toContain('private command diagnostic');
    expect(result.message).toContain('Operator permission via Telegram');
  });
  it('passes option-like configured usernames only as identity operands', () => {
    vi.stubEnv('MAGNUS_DOCKER_USER', ' --help ');
    inspect();
    expect(exec).toHaveBeenCalledWith('id', ['-u', '--', '--help'], expect.any(Object));
    expect(exec).toHaveBeenCalledWith('id', ['-nG', '--', '--help'], expect.any(Object));
  });
});
