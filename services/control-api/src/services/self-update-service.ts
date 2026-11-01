import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFile, access, constants } from 'node:fs/promises';

import { reserveApiLocalWork, withApiLocalWork } from './api-local-work.js';

const execAsync = promisify(execFile);

/** Root of the magnus-api repo (two levels up from this file in dist/). */
const REPO_ROOT = process.env['MAGNUS_REPO_ROOT'] ?? path.resolve(import.meta.dirname, '../../');

/** Check whether the REPO_ROOT is inside a valid git repository. */
export async function isGitRepo(): Promise<boolean> {
  try {
    await access(path.join(REPO_ROOT, '.git'), constants.F_OK);
    return true;
  } catch {
    // Might be a subdirectory in a repo — ask git
    try {
      await git('rev-parse', '--git-dir');
      return true;
    } catch {
      return false;
    }
  }
}

export interface SelfUpdateResult {
  workId?: string;
  success: boolean;
  updated: boolean;
  previousVersion: string;
  currentVersion: string;
  gitOutput?: string;
  buildOutput?: string;
  error?: string;
}

export interface UpdateStatus {
  controlApiVersion: string;
  agentVersion: string;
  repoRoot: string;
  gitBranch: string | null;
  gitCommit: string | null;
  lastChecked: string | null;
  isGitRepo: boolean;
  /** Whether the git pull/rebuild endpoints are enabled (MAGNUS_LEGACY_GIT_SELF_UPDATE). */
  legacyGitSelfUpdate: boolean;
  /** How to upgrade this install. */
  upgradeCommand: string;
}

let lastChecked: string | null = null;

/** Read the versions from the package files on disk (they change after a pull and rebuild). */
async function readVersionFromDisk(): Promise<{ agent: string; controlApi: string }> {
  const read = async (file: string) => {
    try {
      return (JSON.parse(await readFile(path.join(REPO_ROOT, file), 'utf-8')) as { version?: string }).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
  return { agent: await read('agent-version.json'), controlApi: await read('package.json') };
}

/** Run a git command in the repo root. */
async function git(...args: string[]): Promise<string> {
  const { stdout } = await execAsync('git', args, {
    cwd: REPO_ROOT,
    timeout: 60_000,
  });
  return stdout.trim();
}

/** Run a shell command in the repo root. */
async function exec(cmd: string, args: string[], timeoutMs = 300_000): Promise<string> {
  const { stdout, stderr } = await execAsync(cmd, args, {
    cwd: REPO_ROOT,
    timeout: timeoutMs,
  });
  return `${stdout}\n${stderr}`.trim();
}

/** Get current git branch name. */
async function getGitBranch(): Promise<string | null> {
  try {
    return await git('rev-parse', '--abbrev-ref', 'HEAD');
  } catch {
    return null;
  }
}

/** Get current git commit hash. */
async function getGitCommit(): Promise<string | null> {
  try {
    return await git('rev-parse', '--short', 'HEAD');
  } catch {
    return null;
  }
}

/**
 * Check for updates by running `git fetch` and comparing local vs remote HEAD.
 * Returns true if there are new commits to pull.
 * Gracefully returns "not available" when the deployment is not a git repo
 * (e.g. deployed via tarball or docker) so callers never see a 500.
 */
export async function checkForUpdates(): Promise<{ available: boolean; behindBy: number; currentCommit: string; remoteCommit: string; error?: string }> {
  lastChecked = new Date().toISOString();

  if (!(await isGitRepo())) {
    const versions = await readVersionFromDisk().catch(() => ({ controlApi: 'unknown', agent: 'unknown' }));
    return {
      available: false,
      behindBy: 0,
      currentCommit: versions.controlApi,
      remoteCommit: versions.controlApi,
      error: `No git repository at ${REPO_ROOT}. Use manual deploy or set MAGNUS_REPO_ROOT.`,
    };
  }

  return withApiLocalWork('self-update-check', async () => {
    await git('fetch', 'origin');
    const branch = await getGitBranch() ?? 'main';
    const local = await git('rev-parse', 'HEAD');
    const remote = await git('rev-parse', `origin/${branch}`);

    if (local === remote) {
      return { available: false, behindBy: 0, currentCommit: local.slice(0, 8), remoteCommit: remote.slice(0, 8) };
    }

    // Count how many commits behind
    const countOutput = await git('rev-list', '--count', `HEAD..origin/${branch}`);
    const behindBy = parseInt(countOutput, 10) || 0;

    return { available: behindBy > 0, behindBy, currentCommit: local.slice(0, 8), remoteCommit: remote.slice(0, 8) };
  });
}

/**
 * Perform the self-update:
 * 1. `git pull origin <branch>`
 * 2. `npm ci` (in case deps changed)
 * 3. `npm run build` (rebuild control-api)
 * 4. Read the new version from disk
 * 5. Schedule a process restart via systemd (if running as a service)
 */
export async function performSelfUpdate(): Promise<SelfUpdateResult> {
  const beforeVersions = await readVersionFromDisk().catch(() => ({ controlApi: 'unknown', agent: 'unknown' }));

  if (!(await isGitRepo())) {
    return {
      success: false,
      updated: false,
      previousVersion: beforeVersions.controlApi,
      currentVersion: beforeVersions.controlApi,
      error: `No git repository at ${REPO_ROOT}. Self-update requires a git checkout. Set MAGNUS_REPO_ROOT or redeploy from source.`,
    };
  }

  return withApiLocalWork('self-update-apply', async () => {
    try {
      const branch = await getGitBranch() ?? 'main';

      // 1. Pull latest code
      const gitOutput = await git('pull', 'origin', branch);

      // 2. Install dependencies (in case lockfile changed)
      const installOutput = await exec('npm', ['ci']);

      // 3. Build everything
      const buildOutput = await exec('npm', ['run', 'build']);

      // 4. Read the new version from the freshly-pulled source
      const afterVersions = await readVersionFromDisk();

      const updated = beforeVersions.controlApi !== afterVersions.controlApi ||
                      beforeVersions.agent !== afterVersions.agent ||
                      !gitOutput.includes('Already up to date');

      lastChecked = new Date().toISOString();

      return {
        success: true,
        updated,
        previousVersion: beforeVersions.controlApi,
        currentVersion: afterVersions.controlApi,
        gitOutput,
        buildOutput: `${installOutput}\n---\n${buildOutput}`.slice(-2000),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        updated: false,
        previousVersion: beforeVersions.controlApi,
        currentVersion: beforeVersions.controlApi,
        error: message.slice(0, 2000),
      };
    }
  });
}

/**
 * Schedule a restart of the control-api systemd service.
 * A process-manager fallback is retained; both paths require fresh durable admission.
 */
export async function scheduleRestart(): Promise<{ scheduled: boolean; method: string; workId: string }> {
  const work = await reserveApiLocalWork('self-update-restart');
  let method: 'systemd' | 'process.exit' = 'systemd';
  try {
    await execAsync('systemctl', ['is-active', 'magnus-control-api'], { timeout: 5_000 });
  } catch { method = 'process.exit'; }
  // Keep the reservation durable during the response delay. A drain that wins
  // before this callback must deny the restart, including after lost replies.
  setTimeout(() => {
    void work.run(async () => {
      if (method === 'systemd') await execAsync('systemctl', ['restart', 'magnus-control-api'], { timeout: 30_000 });
      else process.exit(0);
    }).catch(() => { console.warn('[SelfUpdate] Restart did not obtain verified completion; inspect its durable work receipt'); });
  }, 3_000);
  return { scheduled: true, method, workId: work.workId };
}

/** Get the current update status for reporting. */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const { AGENT_VERSION, CONTROL_API_VERSION } = await import('../config/index.js');
  const branch = await getGitBranch();
  const commit = await getGitCommit();
  const gitRepo = await isGitRepo();

  return {
    controlApiVersion: CONTROL_API_VERSION,
    agentVersion: AGENT_VERSION,
    repoRoot: REPO_ROOT,
    gitBranch: branch,
    gitCommit: commit,
    lastChecked,
    isGitRepo: gitRepo,
    legacyGitSelfUpdate: (await import('../config/features.js')).upgradeSettings().legacyGitSelfUpdate,
    upgradeCommand: 'magnus upgrade',
  };
}
