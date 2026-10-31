import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { ServiceInfo } from '../types/index.js';
import { AgentNotPrivilegedError, agentPrivileged, notPrivilegedMessage } from '../privileged.js';

// ── Helpers ──

function commandSucceeds(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Root-only remediation. Never escalates through sudo. */
function runPrivileged(command: string, args: string[]): void {
  if (!agentPrivileged()) throw new AgentNotPrivilegedError('docker-group-remediation');
  execFileSync(command, args, { stdio: 'pipe', timeout: 10_000 });
}

function groupExists(groupName: string): boolean {
  return commandSucceeds('getent', ['group', groupName]);
}

function ensureGroup(groupName: string): boolean {
  if (groupExists(groupName)) return true;
  try {
    runPrivileged('groupadd', [groupName]);
    return groupExists(groupName);
  } catch {
    return false;
  }
}

function userExists(user: string): boolean {
  return commandSucceeds('id', ['-u', user]);
}

function userInGroup(user: string, groupName: string): boolean {
  try {
    const output = execFileSync('id', ['-nG', user], { encoding: 'utf-8', timeout: 10_000 });
    return output.trim().split(/\s+/).filter(Boolean).includes(groupName);
  } catch {
    return false;
  }
}

function resolveDockerTargetUser(): { user: string | null; source: 'configured' | 'process-user' | 'unavailable' } {
  const configured = process.env['MAGNUS_AGENT_DOCKER_USER']?.trim();
  if (configured) return { user: configured, source: 'configured' };

  try {
    const processUser = os.userInfo().username;
    if (processUser) return { user: processUser, source: 'process-user' };
  } catch {
    // ignore
  }

  return { user: null, source: 'unavailable' };
}

/**
 * Validate Docker group access for the deploy user.
 * If Docker is installed but membership is missing, attempts remediation.
 */
export function collectDockerGroupService(): ServiceInfo {
  const dockerInstalled = commandSucceeds('docker', ['--version']);
  const target = resolveDockerTargetUser();

  if (!dockerInstalled) {
    return {
      name: 'docker-group',
      status: 'unknown',
      pid: null,
      memoryBytes: null,
      cpuPercent: null,
      details: 'Docker not installed; docker group check skipped.',
      targetUser: target.user,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
    };
  }

  if (!target.user) {
    return {
      name: 'docker-group',
      status: 'failed',
      pid: null,
      memoryBytes: null,
      cpuPercent: null,
      details: 'Docker detected but no target user could be resolved for docker group validation.',
      targetUser: null,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
    };
  }

  if (!userExists(target.user)) {
    return {
      name: 'docker-group',
      status: 'failed',
      pid: null,
      memoryBytes: null,
      cpuPercent: null,
      details: `Docker detected but target user '${target.user}' (${target.source}) does not exist on this host.`,
      targetUser: target.user,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
    };
  }

  if (!agentPrivileged() && !userInGroup(target.user, 'docker')) {
    return {
      name: 'docker-group',
      status: 'inactive',
      pid: null,
      memoryBytes: null,
      cpuPercent: null,
      details: `Docker detected and user '${target.user}' is not in docker group; ${notPrivilegedMessage('docker-group-remediation')}.`,
      targetUser: target.user,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
    };
  }

  if (!ensureGroup('docker')) {
    return {
      name: 'docker-group',
      status: 'failed',
      pid: null,
      memoryBytes: null,
      cpuPercent: null,
      details: 'Docker detected but docker group is unavailable and could not be created automatically.',
      targetUser: target.user,
      remediationAttempted: true,
      remediationSucceeded: false,
      requiresRecheck: false,
    };
  }

  if (userInGroup(target.user, 'docker')) {
    return {
      name: 'docker-group',
      status: 'active',
      pid: null,
      memoryBytes: null,
      cpuPercent: null,
      details: `Docker detected and user '${target.user}' (${target.source}) is in docker group.`,
      targetUser: target.user,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
    };
  }

  try {
    runPrivileged('usermod', ['-aG', 'docker', target.user]);
    return {
      name: 'docker-group',
      status: 'failed',
      pid: null,
      memoryBytes: null,
      cpuPercent: null,
      details: `Docker detected and user '${target.user}' was added to docker group; awaiting next health check verification.`,
      targetUser: target.user,
      remediationAttempted: true,
      remediationSucceeded: true,
      requiresRecheck: true,
    };
  } catch {
    return {
      name: 'docker-group',
      status: 'failed',
      pid: null,
      memoryBytes: null,
      cpuPercent: null,
      details: `Docker detected but failed to add user '${target.user}' to docker group.`,
      targetUser: target.user,
      remediationAttempted: true,
      remediationSucceeded: false,
      requiresRecheck: false,
    };
  }
}
