/**
 * Agent self-upgrade (MAGNUS_AGENT_SELF_UPGRADE). The server asks for an exact
 * version and its npm integrity; the agent downloads that tarball, checks it,
 * installs it into versions/<X> beside the running one, points ./current at
 * it and exits. The launcher (launcher/launcher.mjs, installed by
 * `magnus-agent install-service`) starts the new version on trial and switches
 * back if it does not report an accepted heartbeat in time. Nothing here uses
 * sudo: the agent only writes inside its own install directory.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AGENT_SELF_UPGRADE_PROTOCOL,
  checkUpgradeAllowed,
  compareVersions,
  type AgentSelfUpgradeStatus,
  type AgentUpgradeReport,
  type AgentUpgradeRequest,
} from '@hivemagnus/magnus-contracts';

export const STATE_FILE = 'upgrade-state.json';
export const AGENT_PACKAGE = '@hivemagnus/magnus-agent';

export interface UpgradeState {
  state: 'idle' | 'staged' | 'trial' | 'confirmed' | 'reverted' | 'failed';
  from: string | null;
  to: string | null;
  requestId: string | null;
  attempt?: number;
  maxAttempts?: number;
  trialDeadline?: string;
  reason?: string | null;
  updatedAt?: string;
}

export function installDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['AGENT_INSTALL_DIR'] ?? process.cwd());
}

export function readUpgradeState(dir: string): UpgradeState | null {
  try {
    return JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as UpgradeState;
  } catch {
    return null;
  }
}

export function writeUpgradeState(dir: string, state: UpgradeState): void {
  const path = join(dir, STATE_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function pointCurrentAt(dir: string, version: string): void {
  const temporary = join(dir, `current.${process.pid}.tmp`);
  rmSync(temporary, { force: true });
  symlinkSync(join('versions', version), temporary, 'dir');
  renameSync(temporary, join(dir, 'current'));
}

export type Layout = AgentSelfUpgradeStatus['layout'];

export function detectLayout(dir: string, env: NodeJS.ProcessEnv = process.env): Layout {
  if (env['MAGNUS_AGENT_CONTAINER'] === '1') return 'container';
  try {
    if (env['MAGNUS_AGENT_LAUNCHER'] === '1' && lstatSync(join(dir, 'current')).isSymbolicLink()) return 'versioned';
  } catch {
    // no ./current
  }
  return 'legacy';
}

function selfUpgradeSwitch(env: NodeJS.ProcessEnv): boolean {
  return (env['MAGNUS_AGENT_SELF_UPGRADE'] ?? 'true').trim().toLowerCase() !== 'false';
}

/** Whether this agent can upgrade itself, and why not. Reported with every heartbeat. */
export function selfUpgradeStatus(version: string, env: NodeJS.ProcessEnv = process.env): AgentSelfUpgradeStatus {
  const dir = installDir(env);
  const layout = detectLayout(dir, env);
  const launcherProtocol = Number.parseInt(env['MAGNUS_AGENT_LAUNCHER_PROTOCOL'] ?? '', 10);
  const state = readUpgradeState(dir);
  let reason: string | null = null;
  if (!selfUpgradeSwitch(env)) reason = 'MAGNUS_AGENT_SELF_UPGRADE=false on this node';
  else if (layout === 'container') reason = 'container agent: upgrade by pulling a newer image';
  else if (layout === 'legacy') reason = 'not running under the upgrade launcher; run `sudo magnus-agent install-service` once on this node';
  else {
    try {
      accessSync(dir, constants.W_OK);
      accessSync(join(dir, 'versions'), constants.W_OK);
    } catch {
      reason = `the agent cannot write ${dir}`;
    }
  }
  return {
    protocol: AGENT_SELF_UPGRADE_PROTOCOL,
    launcherProtocol: Number.isInteger(launcherProtocol) ? launcherProtocol : null,
    layout,
    enabled: reason === null,
    reason,
    upgrade: state ? reportOf(state) : { state: 'idle', from: null, to: version },
  };
}

function reportOf(state: UpgradeState): AgentUpgradeReport {
  return {
    state: state.state, from: state.from, to: state.to, requestId: state.requestId, reason: state.reason ?? null,
    ...(state.attempt !== undefined ? { attempt: state.attempt } : {}), ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
  };
}

/**
 * Called after every accepted heartbeat: the first one from a version on trial
 * confirms it, and versions other than the previous and the current one are pruned.
 */
export function confirmTrial(version: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): boolean {
  const dir = installDir(env);
  const state = readUpgradeState(dir);
  if (!state || state.state !== 'trial' || state.to !== version) return false;
  writeUpgradeState(dir, { ...state, state: 'confirmed', reason: null, updatedAt: now.toISOString() });
  pruneVersions(dir, [state.from, state.to]);
  return true;
}

export function pruneVersions(dir: string, keep: ReadonlyArray<string | null>): void {
  const versions = join(dir, 'versions');
  if (!existsSync(versions)) return;
  for (const name of readdirSync(versions)) {
    if (keep.includes(name)) continue;
    rmSync(join(versions, name), { recursive: true, force: true });
  }
}

export class SelfUpgradeError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 409 | 422 | 500 = 409) {
    super(message);
  }
}

export interface Runner {
  (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const runProcess: Runner = (command, args, options) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', code => resolvePromise({ code: code ?? 1, stdout, stderr }));
});

/** npm pack names files `<scope>-<name>-<version>.tgz`. */
export function tarballName(version: string): string {
  return `hivemagnus-magnus-agent-${version}.tgz`;
}

export function sha512Integrity(file: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
}

const ALLOW_SCRIPTS = { 'cpu-features': true, ssh2: true } as const;

const SOURCE_TARBALL = /^hivemagnus-(.+?)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/;

/** Other @hivemagnus tarballs in the source directory, used instead of the registry (offline nodes). */
export function sourceOverrides(sourceDir: string, agentTarball: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const file of readdirSync(sourceDir)) {
    const match = SOURCE_TARBALL.exec(file);
    const path = join(sourceDir, file);
    if (!match || path === agentTarball || match[1] === 'magnus-agent') continue;
    overrides[`@hivemagnus/${match[1]}`] = `file:${path}`;
  }
  return overrides;
}

export interface StageOptions {
  request: AgentUpgradeRequest;
  version: string;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  now?: Date;
}

export interface StageResult {
  from: string;
  to: string;
  integrity: string;
  requestId: string;
}

let staging = false;

/** Download, verify, install and switch. The caller exits afterwards so the launcher starts the new version. */
export async function stageUpgrade(options: StageOptions): Promise<StageResult> {
  const env = options.env ?? process.env;
  const run = options.run ?? runProcess;
  const { request, version: from } = options;
  const status = selfUpgradeStatus(from, env);
  if (!status.enabled) throw new SelfUpgradeError('SELF_UPGRADE_UNAVAILABLE', status.reason ?? 'self-upgrade is unavailable');
  if (request.packageName !== AGENT_PACKAGE) throw new SelfUpgradeError('SELF_UPGRADE_PACKAGE', `only ${AGENT_PACKAGE} can be installed`, 422);
  if (compareVersions(request.version, from) === 0) throw new SelfUpgradeError('SELF_UPGRADE_CURRENT', `already running ${from}`);
  const decision = checkUpgradeAllowed(from, request.version);
  if (!decision.allowed) throw new SelfUpgradeError('SELF_UPGRADE_REFUSED', decision.reason ?? 'upgrade refused', 422);
  const previous = status.upgrade?.state;
  if (previous === 'staged' || previous === 'trial') throw new SelfUpgradeError('SELF_UPGRADE_BUSY', `an upgrade to ${status.upgrade?.to} is still on trial`);
  if (staging) throw new SelfUpgradeError('SELF_UPGRADE_BUSY', 'an upgrade is already being staged');
  staging = true;
  const dir = installDir(env);
  const work = join(dir, 'staging', request.version);
  const target = join(dir, 'versions', request.version);
  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const npm = env['MAGNUS_AGENT_NPM'] || 'npm';
    const npmEnv: NodeJS.ProcessEnv = { ...env, npm_config_cache: env['npm_config_cache'] ?? join(dir, '.npm'), npm_config_update_notifier: 'false' };
    const fail = (step: string, result: { code: number; stderr: string; stdout: string }) => {
      throw new SelfUpgradeError('SELF_UPGRADE_FAILED', `${step} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`, 500);
    };

    // 1. The exact tarball: from an operator-provided directory, or the registry.
    const sourceDir = env['MAGNUS_AGENT_UPGRADE_SOURCE_DIR']?.trim();
    let tarball: string;
    if (sourceDir) {
      tarball = join(resolve(sourceDir), tarballName(request.version));
      if (!existsSync(tarball)) throw new SelfUpgradeError('SELF_UPGRADE_SOURCE', `${tarball} does not exist`, 422);
    } else {
      const packed = await run(npm, ['pack', `${AGENT_PACKAGE}@${request.version}`, '--pack-destination', work, '--json', '--loglevel=error'], { cwd: work, env: npmEnv });
      if (packed.code !== 0) fail('npm pack', packed);
      tarball = join(work, tarballName(request.version));
    }
    // 2. The bytes must match what the server pinned (npm also checks the registry's own digest on download).
    const integrity = sha512Integrity(tarball);
    if (integrity !== request.integrity) {
      throw new SelfUpgradeError('SELF_UPGRADE_INTEGRITY', `tarball integrity ${integrity.slice(0, 20)}… differs from the requested ${request.integrity.slice(0, 20)}…`, 422);
    }
    // 3. Install beside the running version.
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    const overrides = sourceDir ? sourceOverrides(resolve(sourceDir), tarball) : {};
    writeFileSync(join(install, 'package.json'), `${JSON.stringify({
      name: `magnus-agent-${request.version}`, version: request.version, private: true, type: 'module',
      dependencies: { [AGENT_PACKAGE]: `file:${tarball}` }, ...(Object.keys(overrides).length ? { overrides } : {}), allowScripts: ALLOW_SCRIPTS,
    }, null, 2)}\n`);
    const installed = await run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: install, env: npmEnv });
    if (installed.code !== 0) fail('npm install', installed);
    // 4. Registry signatures and provenance of everything installed.
    if ((env['MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE'] ?? 'true').trim().toLowerCase() !== 'false') {
      const audit = await run(npm, ['audit', 'signatures', '--omit=dev', '--loglevel=error'], { cwd: install, env: npmEnv });
      if (audit.code !== 0) fail('npm audit signatures', audit);
    }
    // 5. The new code must at least start and report the requested version.
    const entry = join(install, 'node_modules', '@hivemagnus', 'magnus-agent', 'dist', 'index.js');
    const smoke = await run(process.execPath, [entry, '--version'], { cwd: install, env });
    if (smoke.code !== 0 || smoke.stdout.trim() !== request.version) {
      throw new SelfUpgradeError('SELF_UPGRADE_FAILED', `the installed agent reports "${smoke.stdout.trim()}", not ${request.version}`, 500);
    }
    rmSync(target, { recursive: true, force: true });
    mkdirSync(join(dir, 'versions'), { recursive: true });
    renameSync(install, target);
    const now = (options.now ?? new Date()).toISOString();
    writeUpgradeState(dir, { state: 'staged', from, to: request.version, requestId: request.requestId, attempt: 0, maxAttempts: 2, reason: null, updatedAt: now });
    pointCurrentAt(dir, request.version);
    return { from, to: request.version, integrity, requestId: request.requestId };
  } finally {
    rmSync(work, { recursive: true, force: true });
    staging = false;
  }
}
