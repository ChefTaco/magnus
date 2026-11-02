/**
 * Agent self-upgrade (MAGNUS_AGENT_SELF_UPGRADE). The server asks for an exact
 * version and its npm integrity; the agent downloads that tarball, checks it,
 * installs it into versions/<X> beside the running one, points ./current at
 * it and exits. The launcher (launcher/launcher.mjs, installed by
 * `magnus-agent install-service`) starts the new version on trial and switches
 * back if it does not report an accepted heartbeat in time. Nothing here uses
 * sudo: the agent only writes inside its own install directory.
 *
 * The state file and the links are shared with the launcher: both write them
 * durably (temp file, fsync, rename, fsync of the directory) and both take
 * upgrade-state.lock (O_EXCL) around a read-modify-write.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lchownSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  AGENT_SELF_UPGRADE_PROTOCOL,
  checkUpgradeAllowed,
  compareVersions,
  satisfiesRange,
  type AgentDiskHealth,
  type AgentNpmHealth,
  type AgentSelfUpgradeStatus,
  type AgentUpgradeReport,
  type AgentUpgradeRequest,
} from '@hivemagnus/magnus-contracts';
import { childEnvironment } from '../utils/child-env.js';
import { logger } from '../utils/logger.js';

export const STATE_FILE = 'upgrade-state.json';
export const LOCK_FILE = 'upgrade-state.lock';
/** Written while on trial when heartbeats cannot reach the control API; the launcher then extends the trial. */
export const ALIVE_FILE = 'trial-alive.json';
export const AGENT_PACKAGE = '@hivemagnus/magnus-agent';
/** The launcher protocol this agent needs. Kept equal to `magnusAgent.minLauncher` in package.json. */
export const MIN_LAUNCHER_PROTOCOL = 1;
/** Oldest npm the upgrade steps are tested with (overrides, `audit signatures`). */
export const MIN_NPM_VERSION = '10.0.0';
/** Per-step limits and the total budget; the server waits 15 minutes for an upgrade. */
export const STEP_TIMEOUT_MS = { pack: 3 * 60_000, install: 8 * 60_000, audit: 3 * 60_000, smoke: 60_000 } as const;
export const STAGE_BUDGET_MS = 13 * 60_000;
/** After staging, the agent exits even if a graceful shutdown hangs. */
export const EXIT_BACKSTOP_MS = 60_000;
const NPM_NETWORK = ['--fetch-timeout=60000', '--fetch-retries=2'];
/** Free space an upgrade needs in the install directory: the staged install, its npm cache and the new version. */
export const REQUIRED_FREE_BYTES = 512 * 1024 * 1024;
const ENTRY = ['node_modules', '@hivemagnus', 'magnus-agent', 'dist', 'index.js'] as const;

export interface UpgradeState {
  state: 'idle' | 'staged' | 'trial' | 'confirmed' | 'reverted' | 'failed';
  from: string | null;
  to: string | null;
  requestId: string | null;
  attempt?: number;
  maxAttempts?: number;
  trialDeadline?: string;
  extended?: number;
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

/**
 * An agent running as root inside a directory another account owns (a deploy
 * user that installs releases there) gives what it writes to that owner, so
 * the owner can still replace or remove it. Otherwise this does nothing.
 */
export function adoptInstallOwner(dir: string, path: string, uid = process.getuid?.()): void {
  if (uid !== 0) return;
  const owner = statSync(dir);
  if (owner.uid === 0) return;
  const walk = (entry: string) => {
    const info = lstatSync(entry);
    lchownSync(entry, owner.uid, owner.gid);
    if (info.isDirectory()) for (const child of readdirSync(entry)) walk(join(entry, child));
  };
  if (lstatSync(path, { throwIfNoEntry: false })) walk(path);
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // some filesystems cannot fsync a directory
  }
}

/** Temp file, fsync, rename, fsync the directory: a crash leaves the old or the new content, never a torn file. */
export function writeDurable(dir: string, name: string, text: string, mode = 0o600): void {
  const path = join(dir, name);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, 'w', mode);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    adoptInstallOwner(dir, temporary);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  fsyncDir(dir);
}

export function writeUpgradeState(dir: string, state: UpgradeState): void {
  writeDurable(dir, STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/** Atomically point `<dir>/<name>` (current, last-good) at versions/<version>. */
export function pointLink(dir: string, name: string, version: string): void {
  const temporary = join(dir, `${name}.${process.pid}.tmp`);
  try {
    rmSync(temporary, { force: true });
    symlinkSync(join('versions', version), temporary, 'dir');
    adoptInstallOwner(dir, temporary);
    renameSync(temporary, join(dir, name));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  fsyncDir(dir);
}

export function pointCurrentAt(dir: string, version: string): void {
  pointLink(dir, 'current', version);
}

/** The X of a `<name> -> versions/X` link, or null. */
export function linkVersion(dir: string, name: string): string | null {
  try {
    return /^versions[\\/]([^\\/]+)$/.exec(readlinkSync(join(dir, name)))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** versions/<version> holds a runnable agent. */
export function versionComplete(dir: string, version: string | null | undefined): boolean {
  return !!version && existsSync(join(dir, 'versions', version, ...ENTRY));
}

/** ./current resolves to versions/<version>. */
export function runsVersion(dir: string, version: string): boolean {
  try {
    return realpathSync(join(dir, 'current')) === realpathSync(join(dir, 'versions', version));
  } catch {
    return false;
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function lockIsStale(path: string, staleMs: number): boolean {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    }
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** O_EXCL lock shared with the launcher around a read-modify-write of the state file. Synchronous; waits up to timeoutMs. */
export function withStateLock<T>(dir: string, fn: () => T, { timeoutMs = 3_000, staleMs = 15_000 } = {}): T {
  const path = join(dir, LOCK_FILE);
  const until = Date.now() + timeoutMs;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(path, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (lockIsStale(path, staleMs)) { rmSync(path, { force: true }); continue; }
      if (Date.now() >= until) throw Object.assign(new Error(`${LOCK_FILE} is held by another process`), { code: 'ELOCKED' });
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
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

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

export interface NpmCommand {
  command: string;
  args: string[];
  /** Prepended to PATH so npm and lifecycle scripts run the agent's own Node.js. */
  pathPrefix: string;
  version: string | null;
  problem: string | null;
}

/**
 * The npm that belongs to the running Node.js (npm-cli.js beside it, run with
 * process.execPath), then MAGNUS_AGENT_NPM, then npm on PATH. A systemd PATH
 * often lacks the directory of a version-managed Node.js.
 */
export function resolveNpm(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): NpmCommand {
  const bin = dirname(execPath);
  const configured = env['MAGNUS_AGENT_NPM']?.trim();
  if (configured) return { command: configured, args: [], pathPrefix: bin, version: null, problem: null };
  for (const cli of [join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (!existsSync(cli)) continue;
    const version = readJson<{ version?: string }>(join(dirname(cli), '..', 'package.json'))?.version ?? null;
    let problem: string | null = null;
    try {
      if (version && compareVersions(version, MIN_NPM_VERSION) < 0) problem = `npm ${version} beside ${execPath} is older than ${MIN_NPM_VERSION}`;
    } catch {
      // unparseable version: let npm itself decide
    }
    return { command: execPath, args: [cli], pathPrefix: bin, version, problem };
  }
  const folder = [bin, ...(env['PATH'] ?? '').split(delimiter)].find(entry => entry && existsSync(join(entry, 'npm')));
  if (folder) return { command: join(folder, 'npm'), args: [], pathPrefix: bin, version: null, problem: null };
  return { command: 'npm', args: [], pathPrefix: bin, version: null, problem: `npm was not found beside ${execPath} or on PATH` };
}

function confirmWindowSeconds(env: NodeJS.ProcessEnv, layout: Layout): number | null {
  const fromLauncher = Number.parseInt(env['MAGNUS_AGENT_LAUNCHER_CONFIRM_SECONDS'] ?? '', 10);
  if (Number.isInteger(fromLauncher) && fromLauncher > 0) return fromLauncher;
  if (layout !== 'versioned') return null;
  // Launcher protocol 1 does not pass the window: compute it the same way.
  const value = Number.parseInt(env['MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS'] ?? '', 10);
  return Number.isInteger(value) && value >= 10 ? Math.min(value, 3600) : 180;
}

function writable(path: string): boolean {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

/** The paths in the install directory this agent cannot write, relative to it. */
export function unwritablePaths(dir: string): string[] {
  return ['.', 'versions', ...['staging', STATE_FILE].filter(name => existsSync(join(dir, name)))].filter(name => !writable(name === '.' ? dir : join(dir, name)));
}

/** Free space of the install directory, or null where the filesystem does not say. */
export function diskHealth(dir: string, requiredBytes = REQUIRED_FREE_BYTES): AgentDiskHealth | null {
  try {
    const stats = statfsSync(dir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return { freeBytes, requiredBytes, low: freeBytes < requiredBytes };
  } catch (error) {
    logger.warn(`Free disk of ${dir} is unknown: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function npmHealth(env: NodeJS.ProcessEnv = process.env): AgentNpmHealth {
  const npm = resolveNpm(env);
  return { present: !npm.problem || !/not found/.test(npm.problem), version: npm.version, problem: clip(npm.problem, 300) };
}

const clip = (text: string | null | undefined, max: number): string | null => (text == null ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Whether this agent can upgrade itself, and why not. Reported with every heartbeat. */
export function selfUpgradeStatus(version: string, env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): AgentSelfUpgradeStatus {
  const dir = installDir(env);
  const layout = detectLayout(dir, env);
  const launcherProtocol = Number.parseInt(env['MAGNUS_AGENT_LAUNCHER_PROTOCOL'] ?? '', 10);
  const state = readUpgradeState(dir);
  let reason: string | null = null;
  let reasonCode: AgentSelfUpgradeStatus['reasonCode'] = null;
  if (!selfUpgradeSwitch(env)) [reason, reasonCode] = ['MAGNUS_AGENT_SELF_UPGRADE=false on this node', 'SWITCHED_OFF'];
  else if (layout === 'container') [reason, reasonCode] = ['container agent: upgrade by pulling a newer image', 'CONTAINER'];
  else if (layout === 'legacy') [reason, reasonCode] = ['not running under the upgrade launcher; run `sudo magnus-agent install-service` once on this node', 'LEGACY_LAYOUT'];
  else {
    // Paths left behind by root (an earlier privileged run) block an unprivileged agent.
    const blocked = [dir, join(dir, 'versions'), ...[join(dir, 'staging'), join(dir, STATE_FILE)].filter(path => existsSync(path))]
      .find(path => !writable(path));
    const npmProblem = resolveNpm(env, execPath).problem;
    if (blocked) [reason, reasonCode] = [`the agent cannot write ${blocked}; run \`sudo magnus-agent install-service\` again`, 'NOT_WRITABLE'];
    else if (npmProblem) [reason, reasonCode] = [npmProblem, 'NPM'];
  }
  return {
    protocol: AGENT_SELF_UPGRADE_PROTOCOL,
    launcherProtocol: Number.isInteger(launcherProtocol) ? launcherProtocol : null,
    layout,
    enabled: reason === null,
    reason: clip(reason, 300),
    reasonCode,
    confirmSeconds: confirmWindowSeconds(env, layout),
    upgrade: state ? reportOf(state) : { state: 'idle', from: null, to: version },
  };
}

function reportOf(state: UpgradeState): AgentUpgradeReport {
  return {
    state: state.state, from: state.from, to: state.to, requestId: state.requestId, reason: clip(state.reason, 500),
    ...(state.attempt !== undefined ? { attempt: state.attempt } : {}), ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
  };
}

/** The upgrade state when `version` is the one on trial. */
export function trialOf(version: string, env: NodeJS.ProcessEnv = process.env): UpgradeState | null {
  const state = readUpgradeState(installDir(env));
  return state?.state === 'trial' && state.to === version ? state : null;
}

/** Tell the launcher this version runs but cannot reach the control API, so it extends the trial instead of reverting. */
export function recordTrialAlive(version: string, error: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  const state = trialOf(version, env);
  if (!state) return false;
  try {
    writeDurable(installDir(env), ALIVE_FILE, `${JSON.stringify({ version, requestId: state.requestId, at: now, error: error.slice(0, 200) })}\n`);
    return true;
  } catch {
    return false;
  }
}

/** A failed heartbeat POST that says nothing about this version: no answer, or a gateway with no upstream. */
export function controlApiUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error.name === 'HTTPError') {
    const status = (error as Error & { response?: { status?: number } }).response?.status ?? 0;
    return status === 502 || status === 503 || status === 504;
  }
  return true;
}

/** `export const LAUNCHER_PROTOCOL = N` in a launcher file, without running it. */
export function declaredLauncherProtocol(path: string): number | null {
  try {
    const match = /^export const LAUNCHER_PROTOCOL = (\d+);$/m.exec(readFileSync(path, 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Replace launcher/launcher.mjs with the confirmed version's copy when that
 * declares a higher protocol and passes a self-check (`--protocol`). The
 * running launcher keeps its loaded code; the new one is used from the next
 * service start. The previous file is kept as launcher.mjs.previous.
 */
export function upgradeLauncher(dir: string, version: string, execPath = process.execPath): string | null {
  const candidate = join(dir, 'versions', version, 'node_modules', ...AGENT_PACKAGE.split('/'), 'launcher', 'launcher.mjs');
  const folder = join(dir, 'launcher');
  const installed = join(folder, 'launcher.mjs');
  const offered = declaredLauncherProtocol(candidate);
  const have = declaredLauncherProtocol(installed);
  if (offered === null || have === null || offered <= have) return null;
  const probe = spawnSync(execPath, [candidate, '--protocol'], { encoding: 'utf8', timeout: 10_000, env: childEnvironment() });
  if (probe.status !== 0 || probe.stdout.trim() !== String(offered)) throw new Error(`the launcher from ${version} failed its self-check`);
  copyFileSync(installed, join(folder, 'launcher.mjs.previous'));
  writeDurable(folder, 'launcher.mjs', readFileSync(candidate, 'utf8'), 0o644);
  return `launcher protocol ${have} -> ${offered}`;
}

/**
 * Called after every accepted heartbeat: the first one from a version on
 * trial confirms it (unless the trial window has closed or ./current no
 * longer runs it), records it as last-good, and prunes other versions.
 */
export function confirmTrial(version: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): boolean {
  const dir = installDir(env);
  let trial: UpgradeState | null = null;
  try {
    withStateLock(dir, () => {
      const state = readUpgradeState(dir);
      if (!state || state.state !== 'trial' || state.to !== version) return;
      const deadline = Date.parse(state.trialDeadline ?? '');
      // The launcher is reverting (or about to): a late confirmation must not race it.
      if (Number.isFinite(deadline) && now.getTime() >= deadline) return;
      if (!runsVersion(dir, version)) return;
      writeUpgradeState(dir, { ...state, state: 'confirmed', reason: null, updatedAt: now.toISOString() });
      trial = state;
    }, { timeoutMs: 1_000 }); // blocks the event loop while it waits; the launcher holds the lock for milliseconds
  } catch (error) {
    logger.warn('Self-upgrade confirmation deferred', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  const confirmed = trial as UpgradeState | null;
  if (!confirmed) return false;
  const bestEffort = (step: string, action: () => void) => {
    try { action(); } catch (error) { logger.warn(`Self-upgrade: ${step} failed`, { error: error instanceof Error ? error.message : String(error) }); }
  };
  bestEffort('recording last-good', () => pointLink(dir, 'last-good', version));
  bestEffort('removing the trial marker', () => rmSync(join(dir, ALIVE_FILE), { force: true }));
  bestEffort('pruning old versions', () => pruneVersions(dir, [confirmed.from, confirmed.to]));
  bestEffort('upgrading the launcher', () => {
    const change = upgradeLauncher(dir, version);
    if (change) logger.info(`Self-upgrade: installed the launcher from ${version} (${change}); it takes over at the next service start`);
  });
  return true;
}

export function pruneVersions(dir: string, keep: ReadonlyArray<string | null>): void {
  const versions = join(dir, 'versions');
  if (!existsSync(versions)) return;
  const kept = [...keep, linkVersion(dir, 'current'), linkVersion(dir, 'last-good')];
  for (const name of readdirSync(versions)) {
    if (kept.includes(name)) continue;
    rmSync(join(versions, name), { recursive: true, force: true });
  }
}

const ENV_ERRNO: Readonly<Record<string, string>> = { ENOSPC: 'SELF_UPGRADE_ENV_DISK', EDQUOT: 'SELF_UPGRADE_ENV_DISK', EACCES: 'SELF_UPGRADE_ENV_ACCESS', EPERM: 'SELF_UPGRADE_ENV_ACCESS', EROFS: 'SELF_UPGRADE_ENV_ACCESS' };

/**
 * What a failed npm step says about its cause. A package fault wins, since a
 * corrupt tarball must stay evidence against the release whatever else the
 * output mentions; only a clear environment cause moves it off the release.
 */
export function npmFailureCode(output: string): string {
  if (/\b(EINTEGRITY|E404|ETARGET|EBADENGINE|EJSONPARSE|TAR_BAD_ARCHIVE|TAR_ENTRY_ERROR)\b/.test(output)) return 'SELF_UPGRADE_FAILED';
  if (/\b(ENOSPC|EDQUOT)\b|no space left/i.test(output)) return 'SELF_UPGRADE_ENV_DISK';
  if (/\b(EACCES|EPERM|EROFS)\b|permission denied/i.test(output)) return 'SELF_UPGRADE_ENV_ACCESS';
  if (/\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|E429|E50[0-4])\b|network timeout|socket hang up/i.test(output)) return 'SELF_UPGRADE_ENV_NETWORK';
  return 'SELF_UPGRADE_FAILED';
}

export class SelfUpgradeError extends Error {
  /**
   * Always below 500: a thrown SelfUpgradeError means the attempt ended and the
   * staging was cleaned up, so over managed-http it is a settled, signed result
   * rather than an uncertain mutation. Anything else that goes wrong stays a 500.
   */
  constructor(readonly code: string, message: string, readonly status: 400 | 409 | 422 = 409) {
    super(message);
  }
}

export interface RunResult { code: number; stdout: string; stderr: string; timedOut?: boolean }

export interface Runner {
  (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<RunResult>;
}

const OUTPUT_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 5_000;

/** Runs a command in its own process group; at timeoutMs the whole group gets SIGTERM, then SIGKILL. */
export const runProcess: Runner = (command, args, options) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const signalGroup = (signal: NodeJS.Signals) => {
    try { if (child.pid) process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
  };
  if (options.timeoutMs !== undefined) {
    timers.push(setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      timers.push(setTimeout(() => {
        signalGroup('SIGKILL');
        // A descendant outside the group may still hold the pipes: release them so `close` fires.
        timers.push(setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, KILL_GRACE_MS));
      }, KILL_GRACE_MS));
    }, options.timeoutMs));
  }
  const settle = () => { for (const timer of timers) clearTimeout(timer); };
  const keep = (buffer: string, chunk: unknown) => (buffer + String(chunk)).slice(-OUTPUT_LIMIT);
  child.stdout.on('data', chunk => { stdout = keep(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = keep(stderr, chunk); });
  child.on('error', error => { settle(); reject(error); });
  child.on('close', code => { settle(); resolvePromise({ code: code ?? 1, stdout, stderr, timedOut }); });
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

const SIMPLE_RANGE = /^(?:\*|\^?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Why `engines.node` rules out `nodeVersion`, or null. Range forms satisfiesRange cannot judge are not refused. */
export function engineProblem(range: string | undefined, nodeVersion: string): string | null {
  if (typeof range !== 'string' || !range.trim()) return null;
  if (!range.split('||').every(part => SIMPLE_RANGE.test(part.trim()))) return null;
  return satisfiesRange(nodeVersion, range) ? null : `requires Node.js ${range.trim()}; this node runs ${nodeVersion}`;
}

export interface StageOptions {
  request: AgentUpgradeRequest;
  version: string;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  now?: Date;
  /** Monotonic-enough milliseconds for the step budget (tests). */
  clock?: () => number;
  nodeVersion?: string;
}

export interface StageResult {
  from: string;
  to: string;
  integrity: string;
  requestId: string;
  /** The same request was already handled: nothing was changed, `upgrade` is the current state. */
  repeated?: boolean;
  upgrade?: AgentUpgradeReport;
}

let staging: { requestId: string; version: string } | null = null;

/** Download, verify, install and switch. The caller exits afterwards so the launcher starts the new version. */
export async function stageUpgrade(options: StageOptions): Promise<StageResult> {
  const env = options.env ?? process.env;
  const run = options.run ?? runProcess;
  const clock = options.clock ?? Date.now;
  const started = clock();
  const { request, version: from } = options;
  const dir = installDir(env);

  // A retried request (same requestId and target) reports where it got to instead of failing.
  const recorded = readUpgradeState(dir);
  if ((recorded?.requestId === request.requestId && recorded.to === request.version)
    || (staging?.requestId === request.requestId && staging.version === request.version)) {
    return { from: recorded?.from ?? from, to: request.version, integrity: request.integrity, requestId: request.requestId, repeated: true,
      upgrade: recorded?.requestId === request.requestId ? reportOf(recorded) : { state: 'idle', from, to: request.version, requestId: request.requestId, reason: 'being staged' } };
  }

  const status = selfUpgradeStatus(from, env);
  if (!status.enabled) throw new SelfUpgradeError('SELF_UPGRADE_UNAVAILABLE', status.reason ?? 'self-upgrade is unavailable');
  if (request.packageName !== AGENT_PACKAGE) throw new SelfUpgradeError('SELF_UPGRADE_PACKAGE', `only ${AGENT_PACKAGE} can be installed`, 422);
  if (compareVersions(request.version, from) === 0) throw new SelfUpgradeError('SELF_UPGRADE_CURRENT', `already running ${from}`);
  const decision = checkUpgradeAllowed(from, request.version);
  if (!decision.allowed) throw new SelfUpgradeError('SELF_UPGRADE_REFUSED', decision.reason ?? 'upgrade refused', 422);
  const previous = status.upgrade?.state;
  if (previous === 'staged' || previous === 'trial') throw new SelfUpgradeError('SELF_UPGRADE_BUSY', `an upgrade to ${status.upgrade?.to} is still on trial`);
  if (staging) throw new SelfUpgradeError('SELF_UPGRADE_BUSY', 'an upgrade is already being staged');
  // The launcher can only switch back to a complete versions/<from> that ./current runs now.
  if (!versionComplete(dir, from) || !runsVersion(dir, from)) {
    throw new SelfUpgradeError('SELF_UPGRADE_UNAVAILABLE', `./current does not run a complete versions/${from}, so a failed upgrade could not be reverted; run \`sudo magnus-agent install-service\` again`);
  }
  const npm = resolveNpm(env);
  if (npm.problem) throw new SelfUpgradeError('SELF_UPGRADE_UNAVAILABLE', npm.problem);
  staging = { requestId: request.requestId, version: request.version };
  const stagingRoot = join(dir, 'staging');
  const work = join(stagingRoot, request.version);
  const target = join(dir, 'versions', request.version);
  try {
    // Leftovers of interrupted upgrades, whatever version they were for.
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const path = [npm.pathPrefix, env['PATH']].filter(Boolean).join(delimiter);
    // No agent credentials for npm, lifecycle scripts or the smoke test; a per-upgrade cache that goes with the staging directory.
    const npmEnv = childEnvironment({ PATH: path, npm_config_cache: join(work, '.npm'), npm_config_update_notifier: 'false' }, env);
    const step = async (name: string, limitMs: number, command: string, args: readonly string[], cwd: string, stepEnv: NodeJS.ProcessEnv, timeoutCode = 'SELF_UPGRADE_TIMEOUT') => {
      const remaining = STAGE_BUDGET_MS - (clock() - started);
      if (remaining <= 0) throw new SelfUpgradeError('SELF_UPGRADE_TIMEOUT', `the upgrade used its ${STAGE_BUDGET_MS / 60_000} minute budget before ${name}`, 422);
      const timeoutMs = Math.min(limitMs, remaining);
      const result = await run(command, args, { cwd, env: stepEnv, timeoutMs });
      if (result.timedOut) throw new SelfUpgradeError(timeoutCode, `${name} did not finish within ${Math.round(timeoutMs / 1000)} s`, 422);
      return result;
    };
    const npmStep = (name: string, limitMs: number, args: readonly string[], cwd: string) =>
      step(name, limitMs, npm.command, [...npm.args, ...args, ...NPM_NETWORK, '--loglevel=error'], cwd, npmEnv);
    const fail = (name: string, result: RunResult) => {
      throw new SelfUpgradeError(npmFailureCode(`${result.stderr}\n${result.stdout}`), `${name} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`, 422);
    };

    // 1. The exact tarball: from an operator-provided directory, or the registry.
    const sourceDir = env['MAGNUS_AGENT_UPGRADE_SOURCE_DIR']?.trim();
    let tarball: string;
    if (sourceDir) {
      tarball = join(resolve(sourceDir), tarballName(request.version));
      if (!existsSync(tarball)) throw new SelfUpgradeError('SELF_UPGRADE_SOURCE', `${tarball} does not exist`, 422);
    } else {
      const packed = await npmStep('npm pack', STEP_TIMEOUT_MS.pack, ['pack', `${AGENT_PACKAGE}@${request.version}`, '--pack-destination', work, '--json'], work);
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
    const installed = await npmStep('npm install', STEP_TIMEOUT_MS.install, ['install', '--omit=dev', '--no-audit', '--no-fund'], install);
    if (installed.code !== 0) fail('npm install', installed);
    // 4. This node must be able to run it: Node.js engines and the launcher protocol it needs.
    const manifest = readJson<{ engines?: { node?: string }; magnusAgent?: { minLauncher?: number } }>(
      join(install, 'node_modules', ...AGENT_PACKAGE.split('/'), 'package.json')) ?? {};
    const engine = engineProblem(manifest.engines?.node, options.nodeVersion ?? process.versions.node);
    if (engine) throw new SelfUpgradeError('SELF_UPGRADE_ENGINE', `${request.version} ${engine}`, 422);
    const needs = Number.isInteger(manifest.magnusAgent?.minLauncher) ? manifest.magnusAgent!.minLauncher! : 1;
    if (needs > (status.launcherProtocol ?? 0)) {
      throw new SelfUpgradeError('SELF_UPGRADE_LAUNCHER',
        `${request.version} needs launcher protocol ${needs}; this node runs ${status.launcherProtocol ?? 'none'}. Run \`sudo magnus-agent install-service\` once to update it`, 422);
    }
    // 5. Registry signatures and provenance of everything installed.
    if ((env['MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE'] ?? 'true').trim().toLowerCase() !== 'false') {
      const audit = await npmStep('npm audit signatures', STEP_TIMEOUT_MS.audit, ['audit', 'signatures', '--omit=dev'], install);
      if (audit.code !== 0) fail('npm audit signatures', audit);
    }
    // 6. The new code must at least start and report the requested version.
    const entry = join(install, ...ENTRY);
    // A new version that hangs on --version is a bad package, whatever the clock says about this node.
    const smoke = await step('the installed agent', STEP_TIMEOUT_MS.smoke, process.execPath, [entry, '--version'], install, childEnvironment({ PATH: path }, env), 'SELF_UPGRADE_FAILED');
    if (smoke.code !== 0 || smoke.stdout.trim() !== request.version) {
      throw new SelfUpgradeError('SELF_UPGRADE_FAILED', `the installed agent reports "${smoke.stdout.trim()}", not ${request.version}`, 422);
    }
    rmSync(target, { recursive: true, force: true });
    mkdirSync(join(dir, 'versions'), { recursive: true });
    adoptInstallOwner(dir, join(dir, 'versions'));
    adoptInstallOwner(dir, install);
    renameSync(install, target);
    // 7. Record, then switch. A switch that fails records `failed`, so the launcher does not start a doomed trial.
    const now = (options.now ?? new Date()).toISOString();
    const staged: UpgradeState = { state: 'staged', from, to: request.version, requestId: request.requestId, attempt: 0, maxAttempts: 2, reason: null, updatedAt: now };
    try {
      withStateLock(dir, () => {
        writeUpgradeState(dir, staged);
        try {
          pointCurrentAt(dir, request.version);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try { writeUpgradeState(dir, { ...staged, state: 'failed', reason: `switching ./current failed: ${message}` }); } catch { /* the launcher detects it */ }
          throw new SelfUpgradeError('SELF_UPGRADE_FAILED', `switching ./current to ${request.version} failed: ${message}`, 422);
        }
      });
    } catch (error) {
      try { rmSync(target, { recursive: true, force: true }); } catch { /* pruned later */ }
      if (error instanceof SelfUpgradeError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new SelfUpgradeError(code === 'ELOCKED' ? 'SELF_UPGRADE_BUSY' : 'SELF_UPGRADE_FAILED',
        `recording the upgrade failed: ${error instanceof Error ? error.message : String(error)}`, code === 'ELOCKED' ? 409 : 422);
    }
    return { from, to: request.version, integrity, requestId: request.requestId };
  } catch (error) {
    // The filesystem said no: the node's problem, and the finally below still cleans up.
    const code = (error as NodeJS.ErrnoException).code;
    if (!(error instanceof SelfUpgradeError) && code && ENV_ERRNO[code]) throw new SelfUpgradeError(ENV_ERRNO[code], `staging ${request.version} failed: ${error instanceof Error ? error.message : String(error)}`, 422);
    throw error;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* cleared at the next upgrade */ }
    try { adoptInstallOwner(dir, stagingRoot); } catch { /* reported by selfUpgradeStatus */ }
    staging = null;
  }
}
