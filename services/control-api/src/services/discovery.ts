/**
 * Where the dependencies of Magnus's Ardent agents are, and what they offer: HiveMem (per-agent memory
 * enrollment), HiveSkills (skill installation) and Emberpath (model aliases). For each, an explicit
 * MAGNUS_ARDENT_* setting wins; without one, the Hive Registry's record of the installed product (its
 * internal endpoint and service capabilities, read with the registry's read credential); without either,
 * nothing. Each resolved endpoint is probed at `health/live`.
 *
 * The report refreshes every five minutes and on demand. It is information only: a resolved endpoint is
 * merely available. Discovery never enrolls, installs or enables anything, and never sends a credential
 * to a dependency; HiveMem enrollment, skill installation and channels keep their explicit steps.
 *
 * Credentials go only to explicitly configured endpoints. A Registry-resolved HiveSkills serves promoted
 * releases (which need none), never pinned ones under Magnus's target token; a Registry-resolved HiveMem is
 * reported but never used for enrollment until MAGNUS_ARDENT_HIVEMEM_URL names it.
 *
 * MAGNUS_HIVE_REGISTRY_URL (https, or http with MAGNUS_HIVE_REGISTRY_ALLOW_HTTP=true for the registry's
 * private network) and MAGNUS_HIVE_REGISTRY_TOKEN_FILE (the registry read credential) turn Registry
 * discovery on. Without them every dependency resolves from its setting or not at all (source none).
 */
import { readFileSync } from 'node:fs';
import { createRegistryClient, type RegistryClient, type RegistryConnection } from '@hivemagnus/hive-common/registry';
import type { ArdentDependency } from '@hivemagnus/magnus-contracts/browser';
import { ardentHiveMemSettings } from './ardent-hivemem.js';

export type DependencyName = ArdentDependency['name'];
export const DISCOVERY_DEPENDENCIES: readonly DependencyName[] = ['hivemem', 'hiveskills', 'emberpath'];
/** How often the report is rebuilt, and how old a report may be before a reader rebuilds it. */
export const DISCOVERY_REFRESH_MS = 5 * 60_000;
/** Capabilities Magnus expects of a dependency; one it lacks makes it `unsupported` (its endpoint is still used). */
export const DISCOVERY_EXPECTED_CAPABILITIES: Readonly<Record<DependencyName, readonly string[]>> = {
  hivemem: [], hiveskills: [], emberpath: ['emberpath.execution-trace.v1'],
};

const OVERRIDES: Record<DependencyName, string> = {
  hivemem: 'MAGNUS_ARDENT_HIVEMEM_URL', hiveskills: 'MAGNUS_ARDENT_HIVESKILLS_URL', emberpath: 'MAGNUS_ARDENT_EMBERPATH_URL',
};

type Probe = { ok: true; version: string | null; capabilities: string[] | null } | { ok: false; reason: string };

export interface DiscoveryDeps {
  env(): NodeJS.ProcessEnv;
  /** The Registry client, or null when Registry discovery is off. Throws on an unusable configuration. */
  registry(env: NodeJS.ProcessEnv): RegistryClient | null;
  /** GET `url` (health/live); never sends a credential. */
  probe(url: string): Promise<Probe>;
  now(): number;
}

function registryClient(env: NodeJS.ProcessEnv): RegistryClient | null {
  const baseUrl = env['MAGNUS_HIVE_REGISTRY_URL'];
  const tokenFile = env['MAGNUS_HIVE_REGISTRY_TOKEN_FILE'];
  if (!baseUrl && !tokenFile) return null;
  if (!baseUrl || !tokenFile) throw new Error('MAGNUS_HIVE_REGISTRY_URL and MAGNUS_HIVE_REGISTRY_TOKEN_FILE are set together');
  let token: string;
  try { token = readFileSync(tokenFile, 'utf8').trim(); }
  catch (error: unknown) { throw new Error(`MAGNUS_HIVE_REGISTRY_TOKEN_FILE cannot be read: ${(error as { code?: string }).code ?? 'unreadable'}`); }
  if (!token) throw new Error('MAGNUS_HIVE_REGISTRY_TOKEN_FILE is empty');
  return createRegistryClient({ baseUrl, token, allowHttp: (env['MAGNUS_HIVE_REGISTRY_ALLOW_HTTP'] ?? '').toLowerCase() === 'true', timeoutMs: 5_000 });
}

async function probeHealth(url: string): Promise<Probe> {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } });
    const text = await response.text().catch(() => '');
    if (!response.ok) return { ok: false, reason: `health/live answered HTTP ${response.status}` };
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text.slice(0, 65_536)) as Record<string, unknown>; } catch { body = {}; } // no-reason-needed: a non-JSON health body still means the service answers
    const capabilities = Array.isArray(body['capabilities']) ? body['capabilities'].filter((item): item is string => typeof item === 'string' && /^[a-z0-9.-]{1,64}$/u.test(item)) : null;
    return { ok: true, version: typeof body['version'] === 'string' ? body['version'] : null, capabilities };
  } catch (error: unknown) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { ok: false, reason: `does not answer${cause ? ` (${cause})` : error instanceof Error && error.name === 'TimeoutError' ? ' (timeout)' : ''}` };
  }
}

const defaultDeps: DiscoveryDeps = { env: () => process.env, registry: registryClient, probe: probeHealth, now: () => Date.now() };
let deps = defaultDeps;
/** Replace the environment, registry, probe and clock in tests; drops the cached report. Returns a restore function. */
export function setDiscoveryDeps(overrides: Partial<DiscoveryDeps>): () => void {
  deps = { ...defaultDeps, ...overrides };
  cache = null;
  return () => { deps = defaultDeps; cache = null; };
}

let cache: { at: number; report: ArdentDependency[] } | null = null;
let pending: Promise<ArdentDependency[]> | null = null;

const plainUrl = (value: string, httpsOnly: boolean): string | null => {
  try {
    const url = new URL(value);
    if ((httpsOnly ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) || url.username || url.password || url.search || url.hash) return null;
    return url.toString();
  } catch { return null; }
};
const stripV1 = (url: string) => url.replace(/\/v1\/?$/u, '/');
const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/** The endpoint the Registry records for one dependency, as Magnus's matching setting would name it. */
function registryEndpoint(name: DependencyName, connection: RegistryConnection): string | null {
  const internal = connection.internalEndpoints ?? {};
  const own = (record: Readonly<Record<string, string>>, key: string) => (Object.hasOwn(record, key) ? record[key] : undefined);
  if (name === 'emberpath') {
    const model = own(internal, 'model');
    if (model) return `${model.replace(/\/+$/u, '')}/v1`;
    return own(connection.nativeApis, 'model') ?? null;
  }
  if (name === 'hivemem') {
    const api = own(internal, 'api');
    if (api) return withSlash(api);
    const memory = own(connection.nativeApis, 'memory');
    return memory ? stripV1(withSlash(memory)) : null;
  }
  const api = own(internal, 'api');
  return api ? withSlash(api) : null;
}

/** `X.Y.Z` comparison; a non-numeric version is never at least anything. */
export function versionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)?.slice(1).map(Number);
  const have = version ? parse(version.replace(/^v/u, '')) : undefined;
  const want = parse(minimum);
  if (!have || !want) return false;
  for (let index = 0; index < 3; index++) if (have[index] !== want[index]) return have[index]! > want[index]!;
  return true;
}

interface Offered { name: string; since: string; confirmed: boolean }
function offeredCapabilities(connection: RegistryConnection): Offered[] | null {
  const raw = (connection as unknown as { serviceCapabilities?: unknown }).serviceCapabilities;
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((item: unknown) => {
    const entry = item as { name?: unknown; since?: unknown; confirmed?: unknown };
    return typeof entry?.name === 'string' && /^[a-z0-9.-]{1,64}$/u.test(entry.name) && typeof entry.since === 'string'
      ? [{ name: entry.name, since: entry.since, confirmed: entry.confirmed !== false }] : [];
  }).slice(0, 32);
}

function healthUrl(name: DependencyName, endpoint: string): string {
  return new URL('health/live', withSlash(name === 'emberpath' ? stripV1(endpoint) : endpoint)).toString();
}

/** Whether Magnus has its own HiveMem enrollment credential (an Oathweave client or an enrollment token). */
function hiveMemCredentialProblem(env: NodeJS.ProcessEnv, url: string): string | null {
  try { ardentHiveMemSettings({ ...env, MAGNUS_ARDENT_HIVEMEM_URL: url }); return null; }
  catch (error: unknown) { return error instanceof Error ? error.message : 'HiveMem enrollment is misconfigured'; }
}

async function resolveOne(name: DependencyName, env: NodeJS.ProcessEnv, registry: { client: RegistryClient | null; error: string | null }): Promise<ArdentDependency> {
  const setting = OVERRIDES[name];
  const explicit = env[setting];
  let source: ArdentDependency['source'] = 'none';
  let endpoint: string | null = null;
  let offered: Offered[] | null = null;
  if (explicit) {
    source = 'override';
    endpoint = plainUrl(explicit, name !== 'emberpath');
    if (!endpoint) return { name, status: 'awaiting_configuration', source, capabilities: [],
      reason: `${setting} must be an ${name === 'emberpath' ? 'HTTP(S)' : 'HTTPS'} URL without credentials, query or fragment` };
  }
  let registryReason: string | null = registry.error;
  if (registry.client) {
    try {
      const connection = await registry.client.connection(name);
      if (connection) {
        const recorded = registryEndpoint(name, connection);
        // The registry's capabilities describe its installed product: they apply to an override only at the same address.
        if (!endpoint && recorded) { source = 'registry'; endpoint = recorded; }
        if (source === 'registry' || (recorded && endpoint === recorded)) offered = offeredCapabilities(connection);
        if (!recorded) registryReason = `The Hive Registry records no internal endpoint for ${name}`;
      } else registryReason = `The Hive Registry lists no installed ${name}`;
    } catch (error: unknown) {
      registryReason = `The Hive Registry could not be read: ${error instanceof Error ? error.message.slice(0, 200) : 'request failed'}`;
    }
  }
  if (!endpoint) {
    return { name, status: 'missing', source: 'none', capabilities: [],
      reason: `Set ${setting}${registry.client || registry.error ? '' : ', or MAGNUS_HIVE_REGISTRY_URL and MAGNUS_HIVE_REGISTRY_TOKEN_FILE to find it in the Hive Registry'}${registryReason ? `. ${registryReason}` : ''}`.slice(0, 300) };
  }
  if (name === 'hiveskills' && !plainUrl(endpoint, true))
    return { name, status: 'awaiting_configuration', source, endpoint, capabilities: [], reason: 'HiveSkills must be reached over HTTPS; set MAGNUS_ARDENT_HIVESKILLS_URL' };
  const probe = await deps.probe(healthUrl(name, endpoint));
  if (!probe.ok) return { name, status: 'missing', source, endpoint, capabilities: [], reason: `${name} at ${endpoint} ${probe.reason}`.slice(0, 300) };
  // Confirmed entries hold; an unconfirmed one only when the version the product reports is its since or newer.
  const fromRegistry = offered?.filter(item => item.confirmed || versionAtLeast(probe.version, item.since)).map(item => item.name) ?? null;
  const known = fromRegistry ?? probe.capabilities;
  const capabilities = [...new Set(known ?? [])].sort();
  if (name === 'hivemem') {
    // Magnus sends its enrollment credential only to the HiveMem it was configured with, never to a discovered one.
    if (source === 'registry') return { name, status: 'awaiting_configuration', source, endpoint, capabilities,
      reason: `Found in the Hive Registry. Magnus sends its HiveMem enrollment credential only to an explicitly configured HiveMem: set MAGNUS_ARDENT_HIVEMEM_URL=${endpoint} (with its client or enrollment token) to use it`.slice(0, 300) };
    const problem = hiveMemCredentialProblem(env, endpoint);
    if (problem) return { name, status: 'awaiting_configuration', source, endpoint, capabilities, reason: problem.slice(0, 300) };
  }
  const lacking = known === null ? [] : DISCOVERY_EXPECTED_CAPABILITIES[name].filter(item => !capabilities.includes(item));
  if (lacking.length) return { name, status: 'unsupported', source, endpoint, capabilities,
    reason: `${name}${probe.version ? ` ${probe.version}` : ''} does not offer ${lacking.join(', ')}; its endpoint is still used` };
  return { name, status: 'usable', source, endpoint, capabilities };
}

async function build(): Promise<ArdentDependency[]> {
  const env = deps.env();
  let registry: { client: RegistryClient | null; error: string | null };
  try { registry = { client: deps.registry(env), error: null }; }
  catch (error: unknown) { registry = { client: null, error: `Hive Registry discovery is off: ${error instanceof Error ? error.message : 'misconfigured'}` }; }
  const report = await Promise.all(DISCOVERY_DEPENDENCIES.map(name => resolveOne(name, env, registry)));
  cache = { at: deps.now(), report };
  return report;
}

/** The dependency report: the cached one while it is younger than five minutes, unless `refresh` asks for a new one. */
export async function dependencyReport(options: { refresh?: boolean } = {}): Promise<ArdentDependency[]> {
  if (!options.refresh && cache && deps.now() - cache.at < DISCOVERY_REFRESH_MS) return cache.report;
  pending ??= build().finally(() => { pending = null; });
  return pending;
}

/** The last report's entry for a dependency, without waiting (undefined before the first report). */
export function cachedDependency(name: DependencyName): ArdentDependency | undefined {
  return cache?.report.find(item => item.name === name);
}

/**
 * The endpoint the Registry resolved for a dependency whose setting is unset, for code that reads its setting
 * synchronously; null when the setting is set, nothing was resolved, the endpoint did not answer, or the
 * dependency is HiveMem. Callers send no Magnus credential to it.
 */
export function discoveredEndpoint(name: DependencyName, env: NodeJS.ProcessEnv = process.env): string | null {
  // HiveMem enrollment carries Magnus's credential, so a discovered HiveMem is never a default.
  if (name === 'hivemem' || env[OVERRIDES[name]]) return null;
  const entry = cachedDependency(name);
  return entry?.source === 'registry' && entry.endpoint && entry.status !== 'missing' ? entry.endpoint : null;
}

let timer: ReturnType<typeof setInterval> | undefined;
/** Refresh the report now and every five minutes. */
export function startDependencyDiscovery(): void {
  if (timer) return;
  const refresh = () => { void dependencyReport({ refresh: true }).catch((error: unknown) => {
    console.warn(`[discovery] dependency refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }); };
  refresh();
  timer = setInterval(refresh, DISCOVERY_REFRESH_MS);
  timer.unref();
}
export function stopDependencyDiscovery(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
