import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', () => ({
  execFileSync: (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === 'id' && args[0] === '-nG') return 'operator adm\n';
    return '';
  },
}));
const { collectDockerGroupService } = await import('./docker-group.js');

describe('docker group check', () => {
  beforeEach(() => { calls.length = 0; vi.stubEnv('MAGNUS_AGENT_DOCKER_USER', 'operator'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('reports missing membership without remediation when unprivileged', () => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false');
    const result = collectDockerGroupService();
    expect(result).toMatchObject({ status: 'inactive', targetUser: 'operator', remediationAttempted: false });
    expect(result.details).toContain('agent is not privileged');
    expect(calls.some(([command]) => ['usermod', 'groupadd', 'sudo'].includes(command!))).toBe(false);
  });

  it('adds the configured user to the docker group when privileged, without sudo', () => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'true');
    const result = collectDockerGroupService();
    expect(result).toMatchObject({ remediationAttempted: true, remediationSucceeded: true });
    expect(calls).toContainEqual(['usermod', '-aG', 'docker', 'operator']);
    expect(calls.some(([command]) => command === 'sudo')).toBe(false);
  });
});
