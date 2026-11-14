import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { observeHermesDashboard } from './hermes-dashboard-discovery.js';
import { inspectHiveMemToken, type HiveMemTokenPosture } from './hivemem-token.js';
import { parseGatewayStatusText } from './hermes-gateway-status.js';
import { childEnvironment } from '../utils/child-env.js';
import { armChildTimeout } from '../utils/child-timeout.js';
import { ownerExecution } from '../utils/owner-exec.js';

const OFFICIAL_INSTALL_SCRIPT =
  'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh';
const DEFAULT_HERMES_HOME = process.env['HERMES_HOME'] ?? '~/.hermes';
const MAX_PLUGIN_BYTES = 768 * 1024;
const MAGNUS_STATE_FILE = '.magnus-managed.json';

type HermesServiceStatus =
  | 'unknown'
  | 'not_installed'
  | 'inactive'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'error';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface HermesSkillState {
  slug: string;
  category: string | null;
  source: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

interface HermesToolsetState {
  toolset: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

interface HermesProviderState {
  profileName: string | null;
  provider: string;
  model: string | null;
  configured: boolean;
  metadata: Record<string, unknown>;
}

interface HermesPluginState {
  slug: string;
  pluginType: string;
  version: string | null;
  status: string;
  healthState: string;
  metadata: Record<string, unknown>;
}

export interface HermesNodeState {
  installed: boolean;
  status: 'not_installed' | 'detected' | 'needs_setup' | 'running' | 'degraded' | 'error';
  installMode: 'official-script' | 'existing';
  version: string | null;
  hermesBin: string;
  hermesHome: string;
  gatewayStatus: HermesServiceStatus;
  dashboardStatus: HermesServiceStatus;
  dashboardHost?: string;
  dashboardPort?: number;
  apiServerEnabled: boolean;
  apiServerHost: string;
  apiServerPort: number | null;
  profiles: Array<Record<string, unknown>>;
  skills: HermesSkillState[];
  toolsets: HermesToolsetState[];
  providers: HermesProviderState[];
  plugins: HermesPluginState[];
  configuration: {
    configPresent: boolean;
    configPath: string | null;
    envPath: string | null;
    envKeys: string[];
    modelProvider: string | null;
    modelName: string | null;
    modelBaseUrl: string | null;
    openaiRuntime: 'auto' | 'codex_app_server' | null;
    magnusRouterConfigured: boolean;
    memoryProvider: string | null;
    hiveMemConfigured: boolean;
    hiveMemPluginInstalled: boolean;
    hiveMemApiUrl: string | null;
    hiveMemToken: HiveMemTokenPosture | null;
    magnusSkills: {
      status: 'available' | 'not_configured';
      message: string;
    };
  };
  rawChecks: Record<string, unknown>;
}

const safeValue = z.string().min(1).refine((value) => !/[\r\n]/.test(value), {
  message: 'Value may not contain a newline',
});
const safeUrl = z.string().url().refine((value) => !/[\r\n]/.test(value), {
  message: 'URL may not contain a newline',
});
const fileSchema = z.object({
  path: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.\-/]+$/),
  content: z.string(),
});

const configurationSchema = z.object({
  openaiRuntime: z.enum(['auto', 'codex_app_server']).optional(),
  router: z.object({
    baseUrl: safeUrl,
    model: safeValue,
    apiKey: safeValue.optional(),
  }).optional(),
  hiveMem: z.object({
    apiUrl: safeUrl,
    token: safeValue.optional(),
    workspaceId: safeValue.default('default'),
    defaultScope: z.enum(['private', 'shared']).default('private'),
    recallMode: z.enum(['hybrid', 'context', 'tools', 'off']).default('hybrid'),
    pluginFiles: z.array(fileSchema).optional(),
  }).optional(),
});

const targetSchema = z.object({
  hermesHome: z.string().trim().min(1).default(DEFAULT_HERMES_HOME),
  hermesBin: z.string().trim().min(1).default('hermes'),
});
const installSchema = targetSchema.extend({
  skipBrowser: z.boolean().default(false),
  configuration: configurationSchema.optional(),
});
const updateSchema = targetSchema.extend({
  checkOnly: z.boolean().default(false),
  backup: z.boolean().default(true),
  configuration: configurationSchema.optional(),
});
const uninstallSchema = targetSchema.extend({
  confirm: z.literal(true),
  keepConfiguration: z.boolean().default(true),
});

export const hermesRoutes = new Hono();

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function target(options: { hermesHome: string; hermesBin: string }): { home: string; bin: string } {
  if (!/^[a-zA-Z0-9_./~-]+$/.test(options.hermesBin)) throw new Error('Invalid Hermes executable path');
  return { home: resolve(expandHome(options.hermesHome)), bin: expandHome(options.hermesBin) };
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))];
}

async function userHomeCandidates(): Promise<string[]> {
  const configuredUsers = unique([
    process.env['HERMES_USER'],
    process.env['HERMES_OWNER'],
    process.env['SUDO_USER'],
    process.env['USER'] && process.env['USER'] !== 'root' ? process.env['USER'] : null,
  ]);
  const configuredHomes = configuredUsers.map((user) => `/home/${user}`);

  let scannedHomes: string[] = [];
  try {
    const entries = await readdir('/home', { withFileTypes: true });
    scannedHomes = entries
      .filter((entry) => entry.isDirectory() && /^[a-z_][a-z0-9_-]*[$]?$/i.test(entry.name))
      .map((entry) => `/home/${entry.name}`);
  } catch {
    // /home may not be readable or present in minimal containers.
  }

  return unique([...configuredHomes, ...scannedHomes]);
}

async function homeCandidates(requestedHome: string): Promise<string[]> {
  const userHomes = await userHomeCandidates();
  return unique([
    resolve(expandHome(requestedHome)),
    process.env['HERMES_HOME'] ? resolve(expandHome(process.env['HERMES_HOME'])) : null,
    join(homedir(), '.hermes'),
    join(homedir(), '.config', 'hermes'),
    join(homedir(), '.config', 'hermes-agent'),
    ...userHomes.map((home) => join(home, '.hermes')),
    ...userHomes.map((home) => join(home, '.config', 'hermes')),
    ...userHomes.map((home) => join(home, '.config', 'hermes-agent')),
    '/opt/hermes-agent',
    '/opt/hermes',
  ]);
}

function binCandidates(requestedBin: string, home: string): string[] {
  const ownerHome = dirname(home);
  return unique([
    process.env['HERMES_BIN'],
    expandHome(requestedBin),
    'hermes',
    join(homedir(), '.local', 'bin', 'hermes'),
    join(ownerHome, '.local', 'bin', 'hermes'),
    join(home, 'bin', 'hermes'),
    join(home, 'hermes'),
    join(home, 'hermes-agent', 'hermes'),
    '/usr/local/bin/hermes',
    '/usr/bin/hermes',
  ]);
}

function firstLine(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function cleanTableCell(text: string): string {
  return stripAnsi(text).replace(/\s+/g, ' ').trim();
}

function richTableRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => stripAnsi(line))
    .filter((line) => line.includes('│'))
    .map((line) => line.split('│').slice(1, -1).map(cleanTableCell))
    .filter((cells) => cells.length > 0 && cells.some(Boolean) && !/^name$/i.test(cells[0] ?? ''));
}

function parseJsonArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      : [];
  } catch {
    return [];
  }
}

function pluginType(slug: string): string {
  if (slug.includes('/')) return slug.split('/').at(0) || 'general';
  if (slug.includes('-')) return slug.split('-').at(0) || 'general';
  return 'general';
}

function isEnabledStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized.includes('enabled') && !normalized.includes('not enabled') && !normalized.includes('disabled');
}

function redact(text: string): string {
  return text
    .replace(/(api[_-]?key|token|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeHermesHome(home: string): Promise<boolean> {
  return await exists(join(home, 'config.yaml'))
    || await exists(join(home, '.env'))
    || await exists(join(home, 'profiles'));
}

function run(command: string, args: string[], options: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
  /** Run as this account instead of the agent's own (root only). */
  identity?: { uid: number; gid: number; cwd?: string };
} = {}): Promise<CommandResult> {
  return new Promise((complete) => {
    const proc = spawn(command, args, { env: childEnvironment(options.env), stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.identity ? { uid: options.identity.uid, gid: options.identity.gid, ...(options.identity.cwd ? { cwd: options.identity.cwd } : {}) } : {}) });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const disarm = armChildTimeout(proc, options.timeoutMs ?? 30_000, () => { timedOut = true; });
    proc.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString()}`.slice(-256_000); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-256_000); });
    proc.on('error', (err) => {
      disarm();
      complete({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });
    proc.on('close', (code) => {
      disarm();
      complete({ code: timedOut ? 124 : code ?? 1, stdout, stderr: timedOut ? `${stderr}\nCommand timed out` : stderr });
    });
    if (options.stdin) proc.stdin.write(options.stdin);
    proc.stdin.end();
  });
}

/**
 * Run a Hermes executable against a Hermes home. A root agent runs it as the
 * account that controls the executable or the home, never as root on that
 * account's behalf: both are code the account can replace.
 */
async function runHermesBinary(bin: string, home: string, args: string[], options: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
} = {}): Promise<CommandResult> {
  const execution = await ownerExecution(bin, { home });
  if (!execution.ok) return { code: execution.code, stdout: '', stderr: execution.reason };
  return run(execution.command, args, {
    ...options,
    env: { HERMES_HOME: home, ...options.env, ...execution.env },
    ...(execution.uid !== undefined && execution.gid !== undefined
      ? { identity: { uid: execution.uid, gid: execution.gid, ...(execution.cwd ? { cwd: execution.cwd } : {}) } } : {}),
  });
}

async function runHermes(
  options: { hermesHome: string; hermesBin: string },
  args: string[],
  timeoutMs = 30_000,
  stdin?: string,
): Promise<CommandResult> {
  const resolved = target(options);
  return runHermesBinary(resolved.bin, resolved.home, args, { env: { COLUMNS: '240' }, timeoutMs, ...(stdin === undefined ? {} : { stdin }) });
}

async function collectHermesSkills(options: { hermesHome: string; hermesBin: string }): Promise<HermesSkillState[]> {
  const result = await runHermes(options, ['skills', 'list'], 20_000);
  const rows = richTableRows(`${result.stdout}\n${result.stderr}`);
  return rows
    .filter((cells) => cells.length >= 5 && cells[0] && !/^[-\s]+$/.test(cells[0]))
    .slice(0, 250)
    .map((cells) => {
      const slug = cells[0] ?? 'unknown';
      const status = cells[4] ?? 'unknown';
      return {
        slug,
        category: cells[1] || null,
        source: cells[2] || 'detected',
        enabled: status.toLowerCase() === 'enabled',
        metadata: { trust: cells[3] || null, status, source: 'hermes skills list' },
      };
    });
}

async function collectHermesPlugins(options: { hermesHome: string; hermesBin: string }): Promise<HermesPluginState[]> {
  const jsonResult = await runHermes(options, ['plugins', 'list', '--json'], 20_000);
  const jsonRows = jsonResult.code === 0 ? parseJsonArray(jsonResult.stdout) : [];
  if (jsonRows.length > 0) {
    return jsonRows.slice(0, 250).map((row) => {
      const slug = typeof row['name'] === 'string' ? row['name'] : 'unknown';
      const status = typeof row['status'] === 'string' ? row['status'] : 'unknown';
      return {
        slug,
        pluginType: pluginType(slug),
        version: typeof row['version'] === 'string' ? row['version'] : null,
        status,
        healthState: isEnabledStatus(status) ? 'enabled' : 'inactive',
        metadata: {
          source: typeof row['source'] === 'string' ? row['source'] : 'hermes plugins list --json',
          description: typeof row['description'] === 'string' ? row['description'] : undefined,
        },
      };
    });
  }

  const textResult = await runHermes(options, ['plugins', 'list'], 20_000);
  const rows = richTableRows(`${textResult.stdout}\n${textResult.stderr}`);
  return rows
    .filter((cells) => cells.length >= 5 && cells[0])
    .slice(0, 250)
    .map((cells) => {
      const slug = cells[0] ?? 'unknown';
      const status = cells[1] ?? 'unknown';
      return {
        slug,
        pluginType: pluginType(slug),
        version: cells[2] || null,
        status,
        healthState: isEnabledStatus(status) ? 'enabled' : 'inactive',
        metadata: { source: cells[4] || 'hermes plugins list', description: cells[3] || undefined },
      };
    });
}

function providersFromConfiguration(config: string, configuration: HermesNodeState['configuration']): HermesProviderState[] {
  if (!configuration.modelProvider && !configuration.modelName) return [];
  return [{
    profileName: null,
    provider: configuration.modelProvider ?? 'configured-model',
    model: configuration.modelName,
    configured: Boolean(configuration.modelProvider || configuration.modelName || config),
    metadata: { source: 'config.model', baseUrl: configuration.modelBaseUrl },
  }];
}

/**
 * Discovery timing. `version`/`--version` can be far slower than every other
 * Hermes command (some releases spend most of a minute of CPU on it), so the
 * probe gets its own budget, runs once per binary change, and discovery waits
 * for it only briefly before it falls back to a cheap liveness command.
 */
interface HermesDiscoveryTuning {
  /** Total time for `hermes version` and then `hermes --version`. */
  versionBudgetMs: number;
  /** How long one discovery waits for a probe that has not settled yet. */
  versionWaitMs: number;
  /** Timeout of the liveness command (`hermes profile list`). */
  livenessTimeoutMs: number;
  /** A settled probe is repeated after this long even if the binary looks unchanged. */
  versionTtlMs: number;
  homeCandidates: (requestedHome: string) => Promise<string[]>;
  binCandidates: (requestedBin: string, home: string) => string[];
}

const DEFAULT_DISCOVERY_TUNING: HermesDiscoveryTuning = {
  versionBudgetMs: 90_000,
  versionWaitMs: 10_000,
  livenessTimeoutMs: 15_000,
  versionTtlMs: 24 * 60 * 60_000,
  homeCandidates,
  binCandidates,
};
let discoveryTuning: HermesDiscoveryTuning = { ...DEFAULT_DISCOVERY_TUNING };

type VersionOutcome =
  | { status: 'ok'; version: string | null }
  | { status: 'failed' | 'timeout'; detail: string };

interface VersionProbe {
  fingerprint: string;
  /** The resolved binary, the Hermes home and the account the probe runs against (its cache key). */
  real: string;
  home: string;
  uid: number;
  /** When this binary last answered the liveness command (`hermes profile list`). */
  livenessAt: number | null;
  /** A liveness command the health check started and others may wait for. */
  liveness: Promise<boolean> | null;
  /** The command as given and its absolute path, to forget the entry when the binary disappears. */
  command: string;
  absolute: string;
  outcome: VersionOutcome | null;
  settledAt: number | null;
  /** A discovery reported this binary before the probe settled: tell listeners when it does. */
  reportedPending: boolean;
  promise: Promise<VersionOutcome>;
}

const MAX_VERSION_PROBES = 64;
const versionProbes = new Map<string, VersionProbe>();
const versionProbeListeners = new Set<() => void>();

/** Called when a version probe that discovery stopped waiting for has settled. */
export function onHermesVersionProbeSettled(listener: () => void): () => void {
  versionProbeListeners.add(listener);
  return () => { versionProbeListeners.delete(listener); };
}

/** Forget every cached version probe (after Magnus installs, updates or removes Hermes). */
export function forgetHermesVersionProbes(): void {
  versionProbes.clear();
}

/** Test hook: override discovery timing and candidates; call with no argument to restore the defaults. */
export function configureHermesDiscoveryForTests(overrides?: Partial<HermesDiscoveryTuning>): void {
  discoveryTuning = { ...DEFAULT_DISCOVERY_TUNING, ...overrides };
  versionProbes.clear();
  stateCache = null;
}

/** Test hook: wait until every running version probe has settled. */
export async function settleHermesVersionProbesForTests(): Promise<void> {
  await Promise.all([...versionProbes.values()].map((probe) => probe.promise));
}

/** Test hook: how many version probes are cached. */
export function hermesVersionProbeCountForTests(): number {
  return versionProbes.size;
}

async function findExecutable(command: string): Promise<string | null> {
  if (command.includes('/')) return resolve(command);
  for (const entry of (process.env['PATH'] ?? '').split(':')) {
    if (!entry.startsWith('/')) continue;
    const candidate = join(entry, command);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* next entry */ }
  }
  return null;
}

/** The resolved binary and what identifies its current contents, or null when it does not exist. */
async function binaryIdentity(command: string): Promise<{ absolute: string; real: string; fingerprint: string } | null> {
  const absolute = await findExecutable(command);
  if (!absolute) return null;
  try {
    const real = await realpath(absolute);
    const info = await stat(real);
    if (!info.isFile()) return null;
    return { absolute, real, fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
  } catch {
    return null;
  }
}

function forgetProbesFor(command: string, absolute: string | null): void {
  for (const [key, probe] of versionProbes) {
    if (probe.command === command || (absolute && probe.absolute === absolute)) versionProbes.delete(key);
  }
}

async function probeVersion(bin: string, home: string, budgetMs: number): Promise<VersionOutcome> {
  const deadline = Date.now() + budgetMs;
  let last: CommandResult | null = null;
  for (const args of [['version'], ['--version']]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await runHermesBinary(bin, home, args, { timeoutMs: remaining });
    if (result.code === 0) return { status: 'ok', version: firstLine(result.stdout || result.stderr) };
    last = result;
  }
  return {
    status: !last || last.code === 124 ? 'timeout' : 'failed',
    detail: redact(firstLine(last?.stderr || last?.stdout || '') ?? 'Hermes version probe ran out of time'),
  };
}

function startVersionProbe(key: string, bin: string, home: string, identity: { absolute: string; real: string; fingerprint: string }, uid: number): VersionProbe {
  const probe: VersionProbe = {
    fingerprint: identity.fingerprint,
    real: identity.real,
    home,
    uid,
    livenessAt: null,
    liveness: null,
    command: bin,
    absolute: identity.absolute,
    outcome: null,
    settledAt: null,
    reportedPending: false,
    promise: Promise.resolve({ status: 'timeout', detail: 'not started' }),
  };
  probe.promise = probeVersion(bin, home, discoveryTuning.versionBudgetMs)
    .catch((error: unknown): VersionOutcome => ({ status: 'failed', detail: error instanceof Error ? error.message : String(error) }))
    .then((outcome) => {
      probe.outcome = outcome;
      probe.settledAt = Date.now();
      if (probe.reportedPending && versionProbes.get(key) === probe) {
        for (const listener of versionProbeListeners) {
          try { listener(); } catch { /* a listener failure must not affect discovery */ }
        }
      }
      return outcome;
    });
  if (versionProbes.size >= MAX_VERSION_PROBES) {
    const oldest = versionProbes.keys().next().value;
    if (oldest !== undefined) versionProbes.delete(oldest);
  }
  versionProbes.set(key, probe);
  return probe;
}

type VersionProbeState = 'ok' | 'pending' | 'failed' | 'timeout' | 'not_found' | 'refused';

interface CandidateProbe {
  runnable: boolean;
  version: string | null;
  versionProbe: VersionProbeState;
  /** `hermes profile list` output when it was run as the liveness check. */
  liveness: CommandResult | null;
}

/**
 * Whether `bin` runs against `home`. The version probe is cached per resolved
 * binary, its contents, the home and the account it runs as. When the probe
 * fails, times out or is still running, a trusted binary that answers the
 * liveness command still counts as runnable, with no version.
 */
async function probeCandidate(bin: string, home: string): Promise<CandidateProbe> {
  const execution = await ownerExecution(bin, { home });
  if (!execution.ok) {
    if (execution.code === 127) forgetProbesFor(bin, bin.includes('/') ? resolve(bin) : null);
    return { runnable: false, version: null, versionProbe: execution.code === 127 ? 'not_found' : 'refused', liveness: null };
  }
  const identity = await binaryIdentity(execution.command);
  if (!identity) {
    forgetProbesFor(bin, bin.includes('/') ? resolve(bin) : null);
    return { runnable: false, version: null, versionProbe: 'not_found', liveness: null };
  }
  const uid = execution.uid ?? process.geteuid?.() ?? -1;
  const key = `${identity.real}\u0000${home}\u0000${uid}`;
  let probe = versionProbes.get(key);
  if (probe && (probe.fingerprint !== identity.fingerprint
    || (probe.settledAt !== null && Date.now() - probe.settledAt > discoveryTuning.versionTtlMs))) {
    versionProbes.delete(key);
    probe = undefined;
  }
  probe ??= startVersionProbe(key, bin, home, identity, uid);

  let outcome = probe.outcome;
  if (!outcome) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    outcome = await Promise.race([
      probe.promise,
      new Promise<null>((done) => { timer = setTimeout(() => done(null), discoveryTuning.versionWaitMs); }),
    ]);
    clearTimeout(timer);
    // This discovery reports the binary without its version: say when the probe has settled.
    if (!outcome) probe.reportedPending = true;
  }
  if (outcome?.status === 'ok') return { runnable: true, version: outcome.version, versionProbe: 'ok', liveness: null };

  const liveness = await runHermesBinary(bin, home, ['profile', 'list'], { env: { COLUMNS: '240' }, timeoutMs: discoveryTuning.livenessTimeoutMs });
  if (liveness.code === 0) probe.livenessAt = Date.now();
  return { runnable: liveness.code === 0, version: null, versionProbe: outcome?.status ?? 'pending', liveness };
}

/** A liveness answer this recent still counts for the health check. */
const HEALTH_LIVENESS_FRESH_MS = 15 * 60_000;

/** The Hermes home a health check probes a binary against when discovery has not probed it yet. */
function healthHome(command: string): string {
  const marker = command.indexOf('/.hermes/');
  return marker > 0 ? command.slice(0, marker + '/.hermes'.length) : resolve(expandHome(DEFAULT_HERMES_HOME));
}

/**
 * The `hermes-cli` health check, from the discovery cache: the version probe discovery keeps per
 * binary (90-second budget, in the background), else a recent or bounded liveness answer. It never
 * waits longer than `waitMs`, so a Hermes whose version command is slow does not fail the check
 * (and with it the upgrade acceptance probe, which needs a healthy agent within seconds).
 */
export async function hermesCliHealth(command: string, waitMs = 2_000): Promise<{ ok: boolean; message: string }> {
  const deadline = Date.now() + waitMs;
  const execution = await ownerExecution(command);
  if (!execution.ok) return { ok: false, message: execution.reason };
  const identity = await binaryIdentity(execution.command);
  if (!identity) return { ok: false, message: 'Hermes CLI not found' };
  const uid = execution.uid ?? process.geteuid?.() ?? -1;
  const current = [...versionProbes.values()].filter(probe => probe.real === identity.real && probe.fingerprint === identity.fingerprint && probe.uid === uid
    && (probe.settledAt === null || Date.now() - probe.settledAt <= discoveryTuning.versionTtlMs));
  let probe = current.find(entry => entry.outcome?.status === 'ok') ?? current.find(entry => entry.livenessAt !== null) ?? current[0];
  if (!probe) {
    const home = healthHome(command);
    probe = startVersionProbe(`${identity.real}\u0000${home}\u0000${uid}`, command, home, identity, uid);
  }
  const entry = probe;
  const versionState = () => entry.outcome ? `version probe ${entry.outcome.status}` : 'version probe still running';
  if (entry.outcome?.status === 'ok') return { ok: true, message: entry.outcome.version ?? 'ok' };
  if (entry.livenessAt !== null && Date.now() - entry.livenessAt <= HEALTH_LIVENESS_FRESH_MS)
    return { ok: true, message: `runnable (answers profile list); ${versionState()}` };
  // Whichever proves the binary runs first: its version, or the liveness command (shared by concurrent checks).
  entry.liveness ??= runHermesBinary(command, entry.home, ['profile', 'list'], { env: { COLUMNS: '240' }, timeoutMs: discoveryTuning.livenessTimeoutMs })
    .then(result => { if (result.code === 0) entry.livenessAt = Date.now(); return result.code === 0; })
    .catch(() => false)
    .finally(() => { entry.liveness = null; });
  const liveness = entry.liveness;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = await Promise.race([
    entry.promise.then(outcome => outcome.status === 'ok' ? 'version' as const : liveness.then(live => live ? 'liveness' as const : 'failed' as const)),
    liveness.then(live => live ? 'liveness' as const : entry.promise.then(outcome => outcome.status === 'ok' ? 'version' as const : 'failed' as const)),
    new Promise<'waiting'>(done => { timer = setTimeout(() => done('waiting'), Math.max(0, deadline - Date.now())); }),
  ]).finally(() => clearTimeout(timer));
  const settled = entry.outcome as VersionOutcome | null;
  if (answer === 'version' && settled?.status === 'ok') return { ok: true, message: settled.version ?? 'ok' };
  if (answer === 'liveness') return { ok: true, message: `runnable (answers profile list); ${versionState()}` };
  return { ok: false, message: answer === 'waiting' ? `${versionState()}; liveness check still running` : `${versionState()}; profile list failed` };
}

async function discoverRuntimeTarget(requested: { hermesHome: string; hermesBin: string }): Promise<{
  requested: { hermesHome: string; hermesBin: string };
  resolved: { home: string; bin: string };
  runnable: boolean;
  version: string | null;
  versionProbe: VersionProbeState;
  liveness: CommandResult | null;
  homeDetected: boolean;
}> {
  let firstHomeOnly: string | null = null;
  for (const home of await discoveryTuning.homeCandidates(requested.hermesHome)) {
    const homeDetected = await looksLikeHermesHome(home);
    if (homeDetected && !firstHomeOnly) firstHomeOnly = home;
    for (const bin of discoveryTuning.binCandidates(requested.hermesBin, home)) {
      const candidate = await probeCandidate(bin, home);
      if (candidate.runnable) {
        return {
          requested: { hermesHome: home, hermesBin: bin },
          resolved: { home, bin },
          runnable: true,
          version: candidate.version,
          versionProbe: candidate.versionProbe,
          liveness: candidate.liveness,
          homeDetected,
        };
      }
    }
  }

  const home = firstHomeOnly ?? resolve(expandHome(requested.hermesHome));
  const bin = expandHome(requested.hermesBin);
  return {
    requested: { hermesHome: home, hermesBin: bin },
    resolved: { home, bin },
    runnable: false,
    version: null,
    versionProbe: 'not_found',
    liveness: null,
    homeDetected: Boolean(firstHomeOnly),
  };
}

function yamlBlockValue(contents: string, block: string, key: string): string | null {
  let within = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^[a-zA-Z_][\w-]*:\s*(?:#.*)?$/.test(line)) {
      within = line.startsWith(`${block}:`);
      continue;
    }
    if (!within) continue;
    const match = line.match(new RegExp(`^\\s{2}${key}:\\s*(.*?)\\s*(?:#.*)?$`));
    if (match?.[1]) return match[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

function updateYamlBlock(contents: string, block: string, values: Record<string, string>): string {
  const output: string[] = [];
  const pending = new Map(Object.entries(values));
  let inBlock = false;
  let foundBlock = false;
  const flush = (): void => {
    if (!inBlock) return;
    for (const [key, value] of pending) output.push(`  ${key}: ${value}`);
    pending.clear();
    inBlock = false;
  };
  for (const line of contents.split(/\r?\n/)) {
    const topLevel = /^[a-zA-Z_][\w-]*:\s*(?:#.*)?$/.test(line);
    if (topLevel && inBlock) flush();
    if (line.startsWith(`${block}:`) && topLevel) {
      foundBlock = true;
      inBlock = true;
      output.push(line);
      continue;
    }
    if (inBlock) {
      const key = line.match(/^\s{2}([a-zA-Z_][\w-]*):/)?.[1];
      if (key && pending.has(key)) {
        output.push(`  ${key}: ${pending.get(key)}`);
        pending.delete(key);
        continue;
      }
    }
    output.push(line);
  }
  flush();
  if (!foundBlock) {
    if (output.some((line) => line.trim())) output.push('');
    output.push(`${block}:`, ...Object.entries(values).map(([key, value]) => `  ${key}: ${value}`));
  }
  return `${output.join('\n').trimEnd()}\n`;
}

async function updateEnvFile(path: string, values: Record<string, string>): Promise<void> {
  let lines = await exists(path) ? (await readFile(path, 'utf8')).split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  lines = lines.map((line) => {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join('\n').trimEnd()}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function installHiveMemPlugin(home: string, files: Array<{ path: string; content: string }>): Promise<void> {
  const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  if (bytes > MAX_PLUGIN_BYTES) throw new Error('HiveMem plugin payload exceeds size limit');
  const root = resolve(home, 'plugins', 'memory', 'hivemem');
  for (const file of files) {
    const destination = resolve(root, file.path);
    if (!destination.startsWith(`${root}/`)) throw new Error('Invalid HiveMem plugin path');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, 'utf8');
  }
}
async function readMagnusState(home: string): Promise<{ routerBaseUrl?: string }> {
  const path = join(home, MAGNUS_STATE_FILE);
  if (!await exists(path)) return {};
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as { routerBaseUrl?: unknown };
    return typeof state.routerBaseUrl === 'string' ? { routerBaseUrl: state.routerBaseUrl } : {};
  } catch {
    return {};
  }
}

/** A Hermes profile name. Hidden entries such as `profiles/.deleted` are not profiles. */
function isProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

function cleanCell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/…/g, '').trim();
}

function parseProfileListText(text: string, home: string): Array<Record<string, unknown>> {
  const profiles: Array<Record<string, unknown>> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(name|profiles?|[-=]+)/i.test(line) || /^[┌└├│\s─┬┴┼]+$/.test(line)) continue;
    const cells = line.startsWith('│')
      ? line.slice(1, -1).split('│').map(cleanCell)
      : cleanCell(line).split(/\s{2,}/);
    const nameCell = cells[0] ?? '';
    const name = nameCell.replace(/^[*◆◇•]\s*/, '').replace(/\s+\(default\)$/i, '').split(/\s+/)[0] ?? '';
    if (!name || name.includes(':') || !isProfileName(name)) continue;
    profiles.push({
      name,
      profileHome: join(home, 'profiles', name),
      isDefault: nameCell.startsWith('*') || nameCell.startsWith('◆') || /\bdefault\b/i.test(nameCell),
      gatewayStatus: cells[2] ? parseGatewayStatusText(cells[2]) : 'unknown',
      modelSummary: cells[1] && !['-', '—'].includes(cells[1]) ? cells[1] : null,
      distribution: cells[4] && !['-', '—'].includes(cells[4]) ? cells[4] : null,
      metadata: { source: 'hermes profile list' },
    });
  }
  return profiles;
}

function profileGatewayStatus(profile: Record<string, unknown>, installationStatus: HermesServiceStatus): HermesServiceStatus {
  const reported = profileString(profile, 'gatewayStatus', 'gateway_status');
  const state = reported ? parseGatewayStatusText(reported) : 'unknown';
  if (state !== 'unknown') return state;
  return profile['isDefault'] === true || profile['is_default'] === true || profile['default'] === true || profile['name'] === 'default'
    ? installationStatus : 'unknown';
}

function profileString(profile: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === 'string' && value.trim() && !['-', '—', 'unknown'].includes(value.trim().toLowerCase())) return value.trim();
  }
  return null;
}

function profileBoolean(profile: Record<string, unknown>, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
  }
  return fallback;
}

function profileNumber(profile: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/**
 * Hermes exposes API-server and model routing at the installation level.
 * Profile-list output varies by Hermes release and often contains only names,
 * so carry the observed installation posture into every profile unless that
 * profile explicitly reported its own value. `hermes gateway status` observes
 * only the default profile's gateway, so another profile that reported nothing
 * stays unknown instead of counting as one more running gateway.
 */
function enrichProfiles(
  profiles: Array<Record<string, unknown>>,
  installation: Pick<HermesNodeState, 'gatewayStatus' | 'apiServerEnabled' | 'apiServerHost' | 'apiServerPort' | 'configuration'>,
): Array<Record<string, unknown>> {
  return profiles.map((profile) => ({
    ...profile,
    gatewayStatus: profileGatewayStatus(profile, installation.gatewayStatus),
    providerSummary: profileString(profile, 'providerSummary', 'provider_summary', 'provider') ?? installation.configuration.modelProvider,
    modelSummary: profileString(profile, 'modelSummary', 'model_summary', 'model') ?? installation.configuration.modelName,
    apiServerEnabled: profileBoolean(profile, installation.apiServerEnabled, 'apiServerEnabled', 'api_server_enabled'),
    apiServerHost: profileString(profile, 'apiServerHost', 'api_server_host') ?? installation.apiServerHost,
    apiServerPort: profileNumber(profile, 'apiServerPort', 'api_server_port') ?? installation.apiServerPort,
  }));
}

async function profilesFromHome(home: string): Promise<Array<Record<string, unknown>>> {
  const profilesDir = join(home, 'profiles');
  if (!await exists(profilesDir)) return [];
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isProfileName(entry.name))
      .map((entry) => ({
        name: entry.name,
        profileHome: join(profilesDir, entry.name),
        isDefault: entry.name === 'default',
        gatewayStatus: 'unknown',
        metadata: { source: 'filesystem profiles' },
      }));
  } catch {
    return [];
  }
}

async function envKeys(path: string): Promise<string[]> {
  if (!await exists(path)) return [];
  try {
    return (await readFile(path, 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter((key): key is string => Boolean(key))
      .sort();
  } catch {
    return [];
  }
}

async function apiServerConfiguration(path: string): Promise<{
  enabled: boolean;
  host: string;
  port: number | null;
}> {
  const fallback = { enabled: false, host: '127.0.0.1', port: null };
  if (!await exists(path)) return fallback;
  try {
    const values = new Map<string, string>();
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^(API_SERVER_ENABLED|API_SERVER_HOST|API_SERVER_PORT)=(.*)$/);
      const key = match?.[1];
      const value = match?.[2];
      if (key && value !== undefined) values.set(key, value.trim());
    }
    const configuredPort = values.get('API_SERVER_PORT');
    const port = configuredPort && /^\d+$/.test(configuredPort) ? Number(configuredPort) : null;
    return {
      enabled: values.get('API_SERVER_ENABLED')?.toLowerCase() === 'true',
      host: values.get('API_SERVER_HOST') || fallback.host,
      port: port && port > 0 && port <= 65_535 ? port : null,
    };
  } catch {
    return fallback;
  }
}


export async function configureHermes(
  options: { hermesHome: string; hermesBin: string },
  configuration: z.infer<typeof configurationSchema>,
): Promise<{ warnings: string[]; state: HermesNodeState }> {
  const { home } = target(options);
  await mkdir(home, { recursive: true });
  const configPath = join(home, 'config.yaml');
  const envPath = join(home, '.env');
  let yaml = await exists(configPath) ? await readFile(configPath, 'utf8') : '';
  const warnings: string[] = [];
  const magnusState = await readMagnusState(home);
  if (configuration.openaiRuntime) {
    yaml = updateYamlBlock(yaml, 'model', { openai_runtime: configuration.openaiRuntime });
  }
  if (configuration.router) {
    const modelValues: Record<string, string> = {
      provider: 'custom',
      default: JSON.stringify(configuration.router.model),
      base_url: JSON.stringify(configuration.router.baseUrl),
    };
    if (configuration.router.apiKey) {
      await updateEnvFile(envPath, { MAGNUS_ROUTER_API_KEY: configuration.router.apiKey });
      modelValues['api_key'] = '${MAGNUS_ROUTER_API_KEY}';
    }
    yaml = updateYamlBlock(yaml, 'model', modelValues);
    magnusState.routerBaseUrl = configuration.router.baseUrl;
  }
  if (configuration.hiveMem) {
    if (configuration.hiveMem.pluginFiles?.length) await installHiveMemPlugin(home, configuration.hiveMem.pluginFiles);
    const pluginInstalled = await exists(join(home, 'plugins', 'memory', 'hivemem', '__init__.py'));
    if (!pluginInstalled) {
      warnings.push('HiveMem plugin bundle not available on this node; memory.provider was not changed.');
    } else {
      yaml = updateYamlBlock(yaml, 'memory', { provider: 'hivemem' });
      await writeFile(join(home, 'hivemem.json'), `${JSON.stringify({
        api_url: configuration.hiveMem.apiUrl,
        workspace_id: configuration.hiveMem.workspaceId,
        default_scope: configuration.hiveMem.defaultScope,
        recall_mode: configuration.hiveMem.recallMode,
        capture_turns: true,
        max_recall_results: 5,
        context_tokens: 1200,
        enabled: true,
      }, null, 2)}\n`, 'utf8');
      if (configuration.hiveMem.token) {
        await updateEnvFile(envPath, {
          HERMES_HIVEMEM_API_URL: configuration.hiveMem.apiUrl,
          HERMES_HIVEMEM_TOKEN: configuration.hiveMem.token,
        });
      }
    }
  }
  await writeFile(configPath, yaml, 'utf8');
  await writeFile(join(home, MAGNUS_STATE_FILE), `${JSON.stringify(magnusState, null, 2)}\n`, 'utf8');
  return { warnings, state: await collectHermesState(options, true) };
}

let stateCache: { key: string; at: number; value: HermesNodeState } | null = null;

export function hermesInstallationStatus(input: { installed: boolean; runnable: boolean; gatewayStatus: HermesServiceStatus; configPresent: boolean }): HermesNodeState['status'] {
  if (!input.installed) return 'not_installed';
  if (input.gatewayStatus === 'running') return 'running';
  if (!input.runnable) return 'degraded';
  return input.configPresent ? 'detected' : 'needs_setup';
}

export async function collectHermesState(
  options: { hermesHome?: string; hermesBin?: string } = {},
  refresh = false,
): Promise<HermesNodeState> {
  const requested = { hermesHome: options.hermesHome ?? DEFAULT_HERMES_HOME, hermesBin: options.hermesBin ?? 'hermes' };
  const runtime = await discoverRuntimeTarget(requested);
  const resolved = runtime.resolved;
  const cacheKey = `${resolved.home}:${resolved.bin}`;
  if (!refresh && stateCache?.key === cacheKey && Date.now() - stateCache.at < 20_000) return stateCache.value;
  const configPath = join(resolved.home, 'config.yaml');
  const hiveConfigPath = join(resolved.home, 'hivemem.json');
  const envPath = join(resolved.home, '.env');
  const configPresent = await exists(configPath);
  const config = configPresent ? await readFile(configPath, 'utf8') : '';
  const homeProfiles = await profilesFromHome(resolved.home);
  // A Hermes home without a working binary is leftover data, not a usable installation.
  const runnable = runtime.runnable;
  const installed = runnable || runtime.homeDetected || configPresent || homeProfiles.length > 0;
  const version = runnable ? runtime.version : null;
  const gatewayResult = runnable ? await runHermes(runtime.requested, ['gateway', 'status']) : null;
  const profileListResult = runnable ? await runHermes(runtime.requested, ['profile', 'list', '--json'], 15_000) : null;
  let profiles: Array<Record<string, unknown>> = [];
  if (profileListResult?.code === 0 && profileListResult.stdout.trim()) {
    try {
      const parsed = JSON.parse(profileListResult.stdout);
      if (Array.isArray(parsed)) {
        profiles = parsed.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
          .filter((entry) => typeof entry['name'] !== 'string' || isProfileName(entry['name'])).slice(0, 50);
      }
    } catch { /* fall through with empty profiles */ }
  }
  if (profiles.length === 0 && runnable) {
    // Discovery may already have run `profile list` as its liveness check.
    const textResult = runtime.liveness?.code === 0 ? runtime.liveness : await runHermes(runtime.requested, ['profile', 'list'], 15_000);
    profiles = parseProfileListText(`${textResult.stdout}\n${textResult.stderr}`, resolved.home).slice(0, 50);
  }
  if (profiles.length === 0) profiles = homeProfiles.slice(0, 50);
  if (installed && profiles.length === 0) {
    profiles = [{
      name: 'default',
      profileHome: join(resolved.home, 'profiles', 'default'),
      isDefault: true,
      gatewayStatus: 'unknown',
      metadata: { source: 'implicit default profile' },
    }];
  }
  const gatewayStatus: HermesServiceStatus = !installed
    ? 'not_installed'
    : parseGatewayStatusText(`${gatewayResult?.stdout ?? ''}\n${gatewayResult?.stderr ?? ''}`);
  const modelProvider = yamlBlockValue(config, 'model', 'provider');
  const modelName = yamlBlockValue(config, 'model', 'default');
  const modelBaseUrl = yamlBlockValue(config, 'model', 'base_url');
  const configuredOpenaiRuntime = yamlBlockValue(config, 'model', 'openai_runtime');
  const openaiRuntime = configuredOpenaiRuntime === 'auto' || configuredOpenaiRuntime === 'codex_app_server'
    ? configuredOpenaiRuntime
    : null;
  const memoryProvider = yamlBlockValue(config, 'memory', 'provider');
  const apiServer = await apiServerConfiguration(envPath);
  const magnusState = await readMagnusState(resolved.home);
  const hiveMemPluginInstalled = await exists(join(resolved.home, 'plugins', 'memory', 'hivemem', '__init__.py'))
    || await exists(join(resolved.home, 'plugins', 'hivemem', '__init__.py'));
  let hiveMemApiUrl: string | null = null;
  if (await exists(hiveConfigPath)) {
    try {
      const data = JSON.parse(await readFile(hiveConfigPath, 'utf8')) as { api_url?: unknown };
      hiveMemApiUrl = typeof data.api_url === 'string' ? data.api_url : null;
    } catch {}
  }
  if (!hiveMemApiUrl && await exists(envPath)) {
    const hiveEnv = await readFile(envPath, 'utf8');
    hiveMemApiUrl = hiveEnv.split(/\r?\n/).find((line) => line.startsWith('HERMES_HIVEMEM_API_URL='))
      ?.slice('HERMES_HIVEMEM_API_URL='.length).trim() ?? null;
  }
  const configuration: HermesNodeState['configuration'] = {
    configPresent,
    configPath: configPresent ? configPath : null,
    envPath: await exists(envPath) ? envPath : null,
    envKeys: await envKeys(envPath),
    modelProvider,
    modelName,
    modelBaseUrl,
    openaiRuntime,
    magnusRouterConfigured: modelProvider === 'custom' && Boolean(modelBaseUrl) && modelBaseUrl === magnusState.routerBaseUrl,
    memoryProvider,
    hiveMemConfigured: memoryProvider === 'hivemem' && hiveMemPluginInstalled,
    hiveMemPluginInstalled,
    hiveMemApiUrl,
    hiveMemToken: memoryProvider === 'hivemem' ? await inspectHiveMemToken(envPath, hiveMemApiUrl) : null,
    magnusSkills: {
      status: process.env['MAGNUS_SKILLS_DIR'] ? 'available' : 'not_configured',
      message: process.env['MAGNUS_SKILLS_DIR']
        ? 'Hermes Agent skills are published from magnus-skills and reconciled through magnus-agent.'
        : 'Set MAGNUS_SKILLS_DIR on this node to expose the magnus-skills catalogue to Hermes Agent profiles.',
    },
  };
  const [skills, plugins] = runnable
    ? await Promise.all([
        collectHermesSkills(runtime.requested).catch(() => []),
        collectHermesPlugins(runtime.requested).catch(() => []),
      ])
    : [[], []];
  const providers = providersFromConfiguration(config, configuration);
  profiles = enrichProfiles(profiles, {
    gatewayStatus,
    apiServerEnabled: apiServer.enabled,
    apiServerHost: apiServer.host,
    apiServerPort: apiServer.port,
    configuration,
  });
  const dashboard = await observeHermesDashboard(resolved.home);
  const state: HermesNodeState = {
    installed,
    status: hermesInstallationStatus({ installed, runnable, gatewayStatus, configPresent }),
    installMode: installed ? 'official-script' : 'existing',
    version,
    hermesBin: requested.hermesBin,
    hermesHome: resolved.home,
    gatewayStatus,
    dashboardStatus: dashboard.status,
    ...(dashboard.status === 'running' && dashboard.host && dashboard.port
      ? { dashboardHost: dashboard.host, dashboardPort: dashboard.port } : {}),
    apiServerEnabled: apiServer.enabled,
    apiServerHost: apiServer.host,
    apiServerPort: apiServer.port,
    profiles,
    skills,
    toolsets: [],
    providers,
    plugins,
    configuration,
    rawChecks: {
      configPresent,
      dashboardObservation: { source: dashboard.source, reason: dashboard.reason },
      gatewayExitCode: gatewayResult?.code ?? null,
      hiveMemPluginInstalled,
      magnusRouterManaged: Boolean(magnusState.routerBaseUrl),
      detectedHome: resolved.home,
      detectedBin: resolved.bin,
      binaryDetected: runnable,
      versionProbe: runtime.versionProbe,
    },
  };
  stateCache = { key: cacheKey, at: Date.now(), value: state };
  return state;
}

function errorResponse(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ success: false, error: { code: 'HERMES_OPERATION_FAILED', message: redact(message) } }, 500);
}

hermesRoutes.get('/state', async (c) => {
  const parsed = targetSchema.safeParse({ hermesHome: c.req.query('hermesHome') ?? DEFAULT_HERMES_HOME, hermesBin: c.req.query('hermesBin') ?? 'hermes' });
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ success: true, data: await collectHermesState(parsed.data, true) });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/configure', async (c) => {
  const parsed = targetSchema.extend({ configuration: configurationSchema }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ success: true, data: await configureHermes(parsed.data, parsed.data.configuration) });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/install', async (c) => {
  const parsed = installSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    const { home } = target(parsed.data);
    const args = parsed.data.skipBrowser ? ['--skip-browser'] : [];
    const result = await run('/bin/bash', ['-c', `curl -fsSL ${OFFICIAL_INSTALL_SCRIPT} | bash -s -- "$@"`, 'hermes-agent-install', ...args], { env: { HERMES_HOME: home }, timeoutMs: 20 * 60_000 });
    forgetHermesVersionProbes();
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'Official Hermes installer failed'));
    const configured = parsed.data.configuration
      ? await configureHermes(parsed.data, parsed.data.configuration)
      : { warnings: [], state: await collectHermesState(parsed.data, true) };
    return c.json({ success: true, data: { state: configured.state, warnings: configured.warnings, output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/update', async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    const args = ['update'];
    if (parsed.data.checkOnly) args.push('--check');
    else if (parsed.data.backup) args.push('--backup');
    const result = await runHermes(parsed.data, args, 20 * 60_000);
    if (!parsed.data.checkOnly) forgetHermesVersionProbes();
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'Hermes update failed'));
    const configured = !parsed.data.checkOnly && parsed.data.configuration
      ? await configureHermes(parsed.data, parsed.data.configuration)
      : { warnings: [], state: await collectHermesState(parsed.data, true) };
    return c.json({ success: true, data: { state: configured.state, warnings: configured.warnings, output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/uninstall', async (c) => {
  const parsed = uninstallSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    await runHermes(parsed.data, ['gateway', 'stop'], 30_000);
    const args = parsed.data.keepConfiguration ? ['uninstall', '--yes'] : ['uninstall', '--full', '--yes'];
    const result = await runHermes(parsed.data, args, 5 * 60_000);
    forgetHermesVersionProbes();
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'Hermes uninstall failed'));
    return c.json({ success: true, data: { state: await collectHermesState(parsed.data, true), output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

// ── Reconciler endpoints (Magnus → Hermes CLI) ────────────────────────────
// Each endpoint accepts a desired-state payload and invokes the local `hermes`
// CLI as a thin reconciler. Output is redacted before returning.

const profileScope = z.object({ profile: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.\-]+$/).optional() });
const skillsSyncSchema = targetSchema.merge(profileScope).extend({
  skills: z.array(z.object({
    slug: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-/@]+$/),
    pinnedVersion: z.string().min(1).max(40).regex(/^[a-zA-Z0-9_.\-]+$/).nullable().optional(),
    enabled: z.boolean().default(true),
  })).max(200),
});
const toolsetApplySchema = targetSchema.merge(profileScope).extend({
  toolset: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.\-]+$/),
  enabled: z.boolean().default(true),
  approvalMode: z.enum(['auto', 'confirm', 'block']).default('auto'),
  allowList: z.array(safeValue).max(200).default([]),
  denyList: z.array(safeValue).max(200).default([]),
});
const providerApplySchema = targetSchema.merge(profileScope).extend({
  chain: z.array(safeValue).max(40).default([]),
  sortStrategy: z.enum(['priority', 'latency', 'cost', 'manual']).default('priority'),
  whitelist: z.array(safeValue).max(80).default([]),
  blacklist: z.array(safeValue).max(80).default([]),
  visionOverride: z.string().min(1).max(120).nullable().optional(),
  compressionOverride: z.string().min(1).max(120).nullable().optional(),
});
const providerTestSchema = targetSchema.merge(profileScope).extend({
  provider: safeValue,
  prompt: z.string().min(1).max(2000).default('ping'),
});
const credentialPoolApplySchema = targetSchema.merge(profileScope).extend({
  poolName: safeValue,
  provider: safeValue,
  keys: z.array(safeValue).min(1).max(50),
  detach: z.boolean().default(false),
});
const mcpApplySchema = targetSchema.merge(profileScope).extend({
  name: safeValue,
  transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
  command: z.string().min(1).max(500).optional(),
  url: safeUrl.optional(),
  detach: z.boolean().default(false),
});
const messagingApplySchema = targetSchema.merge(profileScope).extend({
  platform: z.enum(['slack', 'discord', 'matrix', 'webhook']),
  channel: z.string().min(1).max(200),
  detach: z.boolean().default(false),
});
const cronApplySchema = targetSchema.merge(profileScope).extend({
  name: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-]+$/),
  cronExpr: z.string().min(1).max(120),
  prompt: z.string().min(1).max(4000),
  enabled: z.boolean().default(true),
  remove: z.boolean().default(false),
});
const pluginInstallSchema = targetSchema.extend({
  pluginSlug: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-/@]+$/),
  pinnedVersion: z.string().min(1).max(40).regex(/^[a-zA-Z0-9_.\-]+$/).nullable().optional(),
});
const pluginUninstallSchema = targetSchema.extend({
  pluginSlug: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-/@]+$/),
});
const roleApplySchema = targetSchema.merge(profileScope).extend({
  roleName: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-]+$/),
});

function profileArgs(profile: string | undefined): string[] {
  return profile ? ['--profile', profile] : [];
}

async function runReconcile(
  parsed: { hermesHome: string; hermesBin: string },
  args: string[],
  timeoutMs = 5 * 60_000,
): Promise<{ output: string }> {
  const result = await runHermes(parsed, args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(redact(result.stderr || result.stdout || `hermes ${args[0] ?? ''} failed`));
  }
  return { output: redact(result.stdout.slice(-4000)) };
}

function validationError(c: Context, err: z.ZodError): Response {
  return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } }, 400);
}

hermesRoutes.post('/skills/sync', async (c) => {
  const parsed = skillsSyncSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const outputs: string[] = [];
    for (const skill of parsed.data.skills) {
      const sub = skill.enabled ? 'install' : 'remove';
      const ref = skill.pinnedVersion ? `${skill.slug}@${skill.pinnedVersion}` : skill.slug;
      const result = await runReconcile(parsed.data, ['skill', sub, ...profileArgs(parsed.data.profile), ref]);
      outputs.push(`${sub} ${ref}: ${result.output}`);
    }
    return c.json({ success: true, data: { output: outputs.join('\n---\n').slice(-4000) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/toolsets/apply', async (c) => {
  const parsed = toolsetApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const args = ['tools', parsed.data.enabled ? 'enable' : 'disable', ...profileArgs(parsed.data.profile), parsed.data.toolset];
    const out = await runReconcile(parsed.data, args);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/providers/apply', async (c) => {
  const parsed = providerApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const payload = JSON.stringify({
      chain: parsed.data.chain,
      sort: parsed.data.sortStrategy,
      whitelist: parsed.data.whitelist,
      blacklist: parsed.data.blacklist,
      visionOverride: parsed.data.visionOverride ?? null,
      compressionOverride: parsed.data.compressionOverride ?? null,
    });
    const args = ['providers', 'configure', ...profileArgs(parsed.data.profile), '--from-stdin'];
    const result = await runHermes(parsed.data, args, 60_000, payload);
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'providers configure failed'));
    return c.json({ success: true, data: { output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/providers/test', async (c) => {
  const parsed = providerTestSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const args = ['providers', 'test', ...profileArgs(parsed.data.profile), parsed.data.provider, '--prompt', parsed.data.prompt];
    const out = await runReconcile(parsed.data, args, 120_000);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/credential-pools/apply', async (c) => {
  const parsed = credentialPoolApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const action = parsed.data.detach ? 'detach' : 'attach';
    const payload = JSON.stringify({ provider: parsed.data.provider, keys: parsed.data.keys });
    const args = ['credentials', action, ...profileArgs(parsed.data.profile), parsed.data.poolName, '--from-stdin'];
    const result = await runHermes(parsed.data, args, 60_000, payload);
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'credentials apply failed'));
    return c.json({ success: true, data: { output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/mcp/apply', async (c) => {
  const parsed = mcpApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    if (parsed.data.detach) {
      const out = await runReconcile(parsed.data, ['mcp', 'remove', ...profileArgs(parsed.data.profile), parsed.data.name]);
      return c.json({ success: true, data: out });
    }
    const args = ['mcp', 'add', ...profileArgs(parsed.data.profile), parsed.data.name, '--transport', parsed.data.transport];
    if (parsed.data.command) args.push('--command', parsed.data.command);
    if (parsed.data.url) args.push('--url', parsed.data.url);
    const out = await runReconcile(parsed.data, args);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/messaging/apply', async (c) => {
  const parsed = messagingApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const action = parsed.data.detach ? 'remove' : 'add';
    const out = await runReconcile(parsed.data, ['messaging', action, ...profileArgs(parsed.data.profile), parsed.data.platform, '--channel', parsed.data.channel]);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/cron/apply', async (c) => {
  const parsed = cronApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    if (parsed.data.remove) {
      const out = await runReconcile(parsed.data, ['cron', 'remove', ...profileArgs(parsed.data.profile), parsed.data.name]);
      return c.json({ success: true, data: out });
    }
    const args = [
      'cron', 'add', ...profileArgs(parsed.data.profile),
      parsed.data.name, '--schedule', parsed.data.cronExpr,
    ];
    if (!parsed.data.enabled) args.push('--paused');
    const result = await runHermes(parsed.data, args, 60_000, parsed.data.prompt);
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'cron apply failed'));
    return c.json({ success: true, data: { output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/plugins/install', async (c) => {
  const parsed = pluginInstallSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const ref = parsed.data.pinnedVersion ? `${parsed.data.pluginSlug}@${parsed.data.pinnedVersion}` : parsed.data.pluginSlug;
    const out = await runReconcile(parsed.data, ['plugins', 'install', ref]);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/plugins/uninstall', async (c) => {
  const parsed = pluginUninstallSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const out = await runReconcile(parsed.data, ['plugins', 'uninstall', parsed.data.pluginSlug]);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/role/apply', async (c) => {
  const parsed = roleApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const out = await runReconcile(parsed.data, ['role', 'apply', ...profileArgs(parsed.data.profile), parsed.data.roleName]);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});
