import { execFileSync } from 'node:child_process';

export type DockerGroupHealthStatus = 'healthy' | 'warning' | 'not-applicable';

export interface DockerGroupHealthResult {
  status: DockerGroupHealthStatus;
  dockerInstalled: boolean;
  targetUser: string | null;
  targetUserSource: 'deploy-env' | 'unavailable';
  userExists: boolean;
  inDockerGroup: boolean;
  remediationAttempted: boolean;
  remediationSucceeded: boolean;
  requiresRecheck: boolean;
  message: string;
}

function commandSucceeds(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'pipe', timeout: 3000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function groupExists(groupName: string): boolean {
  return commandSucceeds('getent', ['group', groupName]);
}

function userExists(user: string): boolean {
  return commandSucceeds('id', ['-u', '--', user]);
}

function userInGroup(user: string, groupName: string): boolean {
  try {
    const output = execFileSync('id', ['-nG', '--', user], { encoding: 'utf-8', timeout: 3000, maxBuffer: 64 * 1024 });
    return output
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .includes(groupName);
  } catch {
    return false;
  }
}

/**
 * Checks whether the configured deploy user can access Docker via group membership.
 * Observation only: account and group changes are left to the operator.
 */
export function checkDockerGroupHealthOnControlNode(): DockerGroupHealthResult {
  const targetUser = process.env['MAGNUS_DOCKER_USER']?.trim() || null;
  const targetUserSource: DockerGroupHealthResult['targetUserSource'] = targetUser ? 'deploy-env' : 'unavailable';
  const dockerInstalled = commandSucceeds('docker', ['--version']);

  if (!dockerInstalled) {
    return {
      status: 'not-applicable',
      dockerInstalled,
      targetUser,
      targetUserSource,
      userExists: true,
      inDockerGroup: false,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
      message: 'Docker not installed; docker group check skipped.',
    };
  }

  if (!targetUser) {
    return {
      status: 'warning',
      dockerInstalled,
      targetUser,
      targetUserSource,
      userExists: false,
      inDockerGroup: false,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
      message: 'Docker detected but MAGNUS_DOCKER_USER is not configured; cannot verify docker group membership.',
    };
  }

  if (!userExists(targetUser)) {
    return {
      status: 'warning',
      dockerInstalled,
      targetUser,
      targetUserSource,
      userExists: false,
      inDockerGroup: false,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
      message: `Docker detected but configured user '${targetUser}' does not exist on this host.`,
    };
  }

  if (!groupExists('docker')) {
    return {
      status: 'warning',
      dockerInstalled,
      targetUser,
      targetUserSource,
      userExists: true,
      inDockerGroup: false,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
      message: 'Docker detected but the docker group is unavailable. Operator permission via Telegram is required before changing groups.',
    };
  }

  if (userInGroup(targetUser, 'docker')) {
    return {
      status: 'healthy',
      dockerInstalled,
      targetUser,
      targetUserSource,
      userExists: true,
      inDockerGroup: true,
      remediationAttempted: false,
      remediationSucceeded: false,
      requiresRecheck: false,
      message: `Docker detected and user '${targetUser}' is already in docker group.`,
    };
  }

  return {
    status: 'warning',
    dockerInstalled,
    targetUser,
    targetUserSource,
    userExists: true,
    inDockerGroup: false,
    remediationAttempted: false,
    remediationSucceeded: false,
    requiresRecheck: false,
    message: `Docker detected but docker group membership could not be verified for user '${targetUser}'. Operator permission via Telegram is required before changing membership.`,
  };
}
