/**
 * Opt-out update notices (MAGNUS_UPDATE_CHECK). Once a day the server reads
 * the npm registry document of @hivemagnus/magnus (one anonymous GET; nothing
 * about this install is sent) and summarizes the releases between the running
 * version and the newest one of the same major: release notes, new required
 * settings and migrations that are slow or one-way. A newer major is reported
 * separately and never offered as a one-click upgrade.
 */
import {
  compareVersions,
  isVersion,
  latestVersion,
  manifestsFromPackument,
  summarizeUpgradePath,
} from '@hivemagnus/magnus-contracts';
import { upgradeSettings } from '../config/features.js';
import { AGENT_VERSION, CONTROL_API_VERSION } from '../config/version.js';

export const META_PACKAGE = '@hivemagnus/magnus';
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = 'update-check:v1';

export interface UpdateCheckResult {
  enabled: boolean;
  checkedAt: string | null;
  error: string | null;
  current: string;
  /** Newest release in the running major, when newer than `current`. */
  latest: string | null;
  /** A newer major release, which needs a deliberate `--allow-major` upgrade. */
  latestMajor: string | null;
  updateAvailable: boolean;
  breaking: boolean;
  releases: Array<{ version: string; summary: string; notesUrl: string | null; breaking: boolean }>;
  newRequiredEnv: Array<{ name: string; component: string; secret: boolean; description: string; missingOnServer: boolean }>;
  attention: Array<{ name: string; impact: string; note: string; version: string }>;
  command: string;
}

export function emptyResult(enabled: boolean, error: string | null = null): UpdateCheckResult {
  return {
    enabled, checkedAt: null, error, current: CONTROL_API_VERSION, latest: null, latestMajor: null, updateAvailable: false,
    breaking: false, releases: [], newRequiredEnv: [], attention: [], command: 'magnus upgrade',
  };
}

export interface CheckOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  current?: string;
}

export function summarizePackument(packument: unknown, current: string, env: NodeJS.ProcessEnv, checkedAt: string): UpdateCheckResult {
  const versions = Object.keys((packument as { versions?: Record<string, unknown> } | null)?.versions ?? {}).filter(isVersion);
  const manifests = manifestsFromPackument(packument);
  const sameMajor = latestVersion(versions, { sameMajorAs: current });
  const newest = latestVersion(versions);
  const latest = sameMajor && compareVersions(sameMajor, current) > 0 ? sameMajor : null;
  const latestMajor = newest && compareVersions(newest, current) > 0 && newest.split('.')[0] !== current.split('.')[0] ? newest : null;
  const path = latest ? summarizeUpgradePath(manifests, current, latest) : null;
  return {
    enabled: true,
    checkedAt,
    error: null,
    current,
    latest,
    latestMajor,
    updateAvailable: latest !== null,
    breaking: path?.breaking ?? false,
    releases: (path?.releases ?? []).map(release => ({
      version: release.version, summary: release.summary, notesUrl: release.notesUrl ?? null, breaking: release.breaking,
    })),
    newRequiredEnv: (path?.newRequiredEnv ?? []).map(variable => ({
      name: variable.name, component: variable.component, secret: variable.secret, description: variable.description,
      missingOnServer: variable.component === 'server' && !env[variable.name],
    })),
    attention: (path?.attention ?? []).map(migration => ({ name: migration.name, impact: migration.impact, note: migration.note, version: migration.version })),
    command: latest ? `magnus upgrade --to ${latest}` : 'magnus upgrade',
  };
}

/** One registry read. Errors are reported in the result, never thrown. */
export async function checkForUpdate(options: CheckOptions = {}): Promise<UpdateCheckResult> {
  const env = options.env ?? process.env;
  const settings = upgradeSettings(env);
  const current = options.current ?? CONTROL_API_VERSION;
  if (!settings.updateCheck) return { ...emptyResult(false), current };
  const url = `${settings.updateRegistry}/${META_PACKAGE.replace('/', '%2f')}`;
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) return { ...emptyResult(true), current, checkedAt };
    if (!response.ok) return { ...emptyResult(true, `registry answered ${response.status}`), current, checkedAt };
    return summarizePackument(await response.json(), current, env, checkedAt);
  } catch (error) {
    return { ...emptyResult(true, `registry unreachable: ${error instanceof Error ? error.message : String(error)}`), current, checkedAt };
  }
}

/** The `updates` line of `check`: never a failure, only a notice. */
export function updateResult(update: UpdateCheckResult): { name: string; status: 'pass' | 'warn'; message: string } {
  if (!update.enabled) return { name: 'updates', status: 'pass', message: 'registry check off (MAGNUS_UPDATE_CHECK=false)' };
  if (update.error) return { name: 'updates', status: 'warn', message: `could not check: ${update.error}` };
  const major = update.latestMajor ? `; ${update.latestMajor} is a new major version (see UPGRADING.md)` : '';
  if (!update.updateAvailable) return { name: 'updates', status: 'pass', message: `${update.current} is the newest ${update.current.split('.')[0]}.x release${major}` };
  const env = update.newRequiredEnv.map(variable => `${variable.name}${variable.missingOnServer ? ' (not set here)' : ''}`);
  return {
    name: 'updates',
    status: 'warn',
    message: `${update.latest} is available: ${update.command}`
      + (env.length ? `; new required settings: ${env.join(', ')}` : '')
      + (update.attention.length ? `; slow or one-way migrations: ${update.attention.map(m => `${m.name} (${m.impact})`).join(', ')}` : '')
      + major,
  };
}

let cached: UpdateCheckResult | null = null;
let timer: NodeJS.Timeout | undefined;

async function redis() {
  const { getRedis } = await import('../queue/redis.js');
  return getRedis();
}

async function store(result: UpdateCheckResult): Promise<void> {
  cached = result;
  try {
    await (await redis()).set(CACHE_KEY, JSON.stringify(result), 'PX', DAY_MS + 60 * 60 * 1000);
  } catch {
    // The in-memory copy is enough; Redis only shares the result across restarts.
  }
}

/** Latest known result; refreshes when there is none yet or `refresh` is set. */
export async function getUpdateCheck(options: { refresh?: boolean } = {}): Promise<UpdateCheckResult> {
  if (!upgradeSettings().updateCheck) return emptyResult(false);
  if (!options.refresh) {
    if (cached && cached.current === CONTROL_API_VERSION) return cached;
    try {
      const raw = await (await redis()).get(CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) as UpdateCheckResult : null;
      if (parsed && parsed.current === CONTROL_API_VERSION) {
        cached = parsed;
        return parsed;
      }
    } catch {
      // fall through to a live check
    }
  }
  const result = await checkForUpdate();
  await store(result);
  return result;
}

export function startUpdateCheck(): void {
  if (!upgradeSettings().updateCheck || timer) return;
  const run = () => { void getUpdateCheck({ refresh: true }).then(result => {
    if (result.updateAvailable) console.log(`[updates] Magnus ${result.latest} is available (running ${result.current}): ${result.command}`);
    if (result.latestMajor) console.log(`[updates] Magnus ${result.latestMajor} (new major) is available; see UPGRADING.md`);
  }); };
  // First check a minute after startup (with jitter), then daily.
  timer = setTimeout(function tick() {
    run();
    timer = setTimeout(tick, DAY_MS);
    timer.unref();
  }, 60_000 + Math.floor(Math.random() * 60_000));
  timer.unref();
}

export function stopUpdateCheck(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
}

export type AgentSkewNode = { nodeId: string; name: string; version: string };

export interface AgentVersionSkew {
  expected: string;
  current: number;
  behind: AgentSkewNode[];
  ahead: AgentSkewNode[];
  unknown: AgentSkewNode[];
}

/** Classify agent versions against the version this server ships with. */
export function classifyAgentVersions(agents: ReadonlyArray<AgentSkewNode>, expected = AGENT_VERSION): AgentVersionSkew {
  const skew: AgentVersionSkew = { expected, current: 0, behind: [], ahead: [], unknown: [] };
  for (const agent of agents) {
    if (!isVersion(agent.version) || !isVersion(expected)) skew.unknown.push(agent);
    else {
      const order = compareVersions(agent.version, expected);
      if (order === 0) skew.current++;
      else (order < 0 ? skew.behind : skew.ahead).push(agent);
    }
  }
  return skew;
}

export async function agentVersionSkew(): Promise<AgentVersionSkew> {
  const { getDb } = await import('../db/client.js');
  const agents = await getDb().agent.findMany({ select: { version: true, node: { select: { id: true, name: true } } } });
  return classifyAgentVersions(agents.map(agent => ({ nodeId: agent.node.id, name: agent.node.name, version: agent.version })));
}

/** The fix for an agent that is behind, spelled out for logs, `check` and the console. */
export function agentFixCommand(nodeNames: readonly string[]): string {
  return nodeNames.length > 0 && nodeNames.length <= 5
    ? `magnus-server agents upgrade --nodes ${nodeNames.join(',')}`
    : 'magnus-server agents upgrade';
}
