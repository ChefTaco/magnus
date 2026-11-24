import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegistryClient, RegistryConnection } from '@hivemagnus/hive-common/registry';
import { cachedDependency, dependencyReport, discoveredEndpoint, DISCOVERY_REFRESH_MS, setDiscoveryDeps, versionAtLeast } from './discovery.js';
import { ardentHiveSkillsUrl } from './ardent-hiveskills.js';
import { ardentHiveMemSettings } from './ardent-hivemem.js';
import { emberpathUrl } from './ardent-agent-deploy.js';

const HIVEMEM_CLIENT = { MAGNUS_ARDENT_HIVEMEM_CLIENT_ID: 'magnus-hivemem', MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET: 'fixture-client-secret',
  MAGNUS_ARDENT_HIVEMEM_TOKEN_URL: 'https://identity.example.com/api/v1/oauth/token' };

/** The connections a suite's Registry records with a credential (internal endpoints and service capabilities). */
const CONNECTIONS: Record<string, RegistryConnection & { serviceCapabilities?: unknown }> = {
  hivemem: { id: 'hivemem', consolePath: null, browserPrefix: '/api/hivemem', nativeApis: { memory: 'https://hive.example.com/memory/v1' }, documentation: null,
    internalEndpoints: { api: 'https://hivemem.example.com:18790' }, serviceCapabilities: [{ name: 'memory.v1', since: '1.9.1', confirmed: true }] },
  hiveskills: { id: 'hiveskills', consolePath: null, browserPrefix: '/api/hiveskills', nativeApis: {}, documentation: null,
    internalEndpoints: { api: 'https://skills.example.com:4030' }, serviceCapabilities: [{ name: 'skills.pinned-release.v1', since: '1.9.0', confirmed: true }] },
  emberpath: { id: 'emberpath', consolePath: null, browserPrefix: '/api/emberpath', nativeApis: { model: 'https://hive.example.com/v1' }, documentation: null,
    internalEndpoints: { admin: 'https://models.example.com:9443', model: 'https://models.example.com:4020' },
    serviceCapabilities: [{ name: 'emberpath.execution-trace.v1', since: '2.6.0', confirmed: true }, { name: 'retry-signal.v1', since: '2.6.0', confirmed: true }] },
};

function registry(connections: Record<string, RegistryConnection | undefined> = CONNECTIONS): RegistryClient & { asked: string[] } {
  const asked: string[] = [];
  return { asked, connection: async (id: string) => { asked.push(id); return connections[id]; } } as unknown as RegistryClient & { asked: string[] };
}

function setup(env: NodeJS.ProcessEnv, options: { registry?: RegistryClient | null; down?: string[]; versions?: Record<string, string>; now?: () => number;
  modelsDown?: string[]; services?: Record<string, string>; capabilities?: Record<string, string[]> } = {}) {
  const probed: string[] = [];
  setDiscoveryDeps({
    env: () => env,
    registry: () => options.registry ?? null,
    probe: async (url, kind = 'health') => {
      probed.push(url);
      if (options.down?.some(host => url.includes(host))) return { ok: false, reason: 'does not answer (ECONNREFUSED)' };
      if (kind === 'models') {
        if (options.modelsDown?.some(host => url.includes(host))) return { ok: false, reason: 'model API answered HTTP 502' };
        return { ok: true, version: null, capabilities: null };
      }
      const pick = <T>(table?: Record<string, T>) => Object.entries(table ?? {}).find(([host]) => url.includes(host))?.[1] ?? null;
      return { ok: true, version: pick(options.versions), capabilities: pick(options.capabilities), service: pick(options.services) };
    },
    ...(options.now ? { now: options.now } : {}),
  });
  return probed;
}
const byName = async (refresh = true) => Object.fromEntries((await dependencyReport({ refresh })).map(item => [item.name, item]));

afterEach(() => { setDiscoveryDeps({}); });

describe('dependency discovery', () => {
  it('reports every dependency missing, with source none, when nothing is configured', async () => {
    setup({});
    const report = await byName();
    for (const name of ['hivemem', 'hiveskills', 'emberpath']) {
      expect(report[name]).toMatchObject({ name, status: 'missing', source: 'none', capabilities: [] });
      expect(report[name]!.reason).toContain('MAGNUS_HIVE_REGISTRY_URL');
    }
  });

  it('uses the Registry endpoint and service capabilities when a setting is unset, and consumers default to it', async () => {
    const env = { ...HIVEMEM_CLIENT };
    const probed = setup(env, { registry: registry() });
    const report = await byName();
    expect(report['hiveskills']).toEqual({ name: 'hiveskills', status: 'usable', source: 'registry', endpoint: 'https://skills.example.com:4030/', capabilities: ['skills.pinned-release.v1'] });
    expect(report['emberpath']).toMatchObject({ status: 'usable', source: 'registry', endpoint: 'https://models.example.com:4020/v1',
      capabilities: ['emberpath.execution-trace.v1', 'retry-signal.v1'] });
    // Found, but never used for enrollment: Magnus's HiveMem credential goes only to an explicit MAGNUS_ARDENT_HIVEMEM_URL.
    expect(report['hivemem']).toMatchObject({ status: 'awaiting_configuration', source: 'registry', endpoint: 'https://hivemem.example.com:18790/' });
    expect(report['hivemem']!.reason).toContain('MAGNUS_ARDENT_HIVEMEM_URL=https://hivemem.example.com:18790/');
    expect(probed.sort()).toEqual(['https://hivemem.example.com:18790/health/live', 'https://models.example.com:4020/health/live', 'https://models.example.com:4020/v1/models', 'https://skills.example.com:4030/health/live']);
    // New Agent, skill-install and HiveMem enrollment default to what the Registry resolved.
    vi.stubEnv('MAGNUS_ARDENT_HIVESKILLS_URL', '');
    vi.stubEnv('MAGNUS_ARDENT_EMBERPATH_URL', '');
    expect(discoveredEndpoint('hiveskills', env)).toBe('https://skills.example.com:4030/');
    expect(ardentHiveSkillsUrl(env)).toBe('https://skills.example.com:4030/');
    expect(emberpathUrl()).toBe('https://models.example.com:4020/v1');
    expect(discoveredEndpoint('hivemem', env)).toBeNull();
    expect(() => ardentHiveMemSettings(env)).toThrow('MAGNUS_ARDENT_HIVEMEM_URL is set together with');
    expect(ardentHiveMemSettings({ ...env, MAGNUS_ARDENT_HIVEMEM_URL: 'https://memory.example.com' })?.apiUrl).toBe('https://memory.example.com/');
    vi.unstubAllEnvs();
  });

  it('lets an explicit setting win over the Registry', async () => {
    const env = { MAGNUS_ARDENT_HIVESKILLS_URL: 'https://skills-override.example.com', MAGNUS_ARDENT_EMBERPATH_URL: 'http://192.0.2.20:4020/v1' };
    const probed = setup(env, { registry: registry() });
    const report = await byName();
    expect(report['hiveskills']).toMatchObject({ status: 'usable', source: 'override', endpoint: 'https://skills-override.example.com/' });
    // Registry capabilities describe the installed product, not another address.
    expect(report['hiveskills']!.capabilities).toEqual([]);
    expect(report['emberpath']).toMatchObject({ source: 'override', endpoint: 'http://192.0.2.20:4020/v1' });
    expect(probed).toContain('https://skills-override.example.com/health/live');
    expect(probed).not.toContain('https://skills.example.com:4030/health/live');
    expect(discoveredEndpoint('hiveskills', env)).toBeNull();
    expect(ardentHiveSkillsUrl(env)).toBe('https://skills-override.example.com/');
  });

  it('reports a stopped dependency missing with a reason, and an older Emberpath unsupported', async () => {
    setup({}, { registry: registry({ ...CONNECTIONS, emberpath: { ...CONNECTIONS['emberpath']!, serviceCapabilities: [] } as RegistryConnection }), down: ['skills.example.com'] });
    const report = await byName();
    expect(report['hiveskills']).toMatchObject({ status: 'missing', source: 'registry', endpoint: 'https://skills.example.com:4030/' });
    expect(report['hiveskills']!.reason).toContain('does not answer (ECONNREFUSED)');
    expect(report['emberpath']).toMatchObject({ status: 'unsupported', source: 'registry', capabilities: [] });
    expect(report['emberpath']!.reason).toContain('emberpath.execution-trace.v1');
    // A stopped dependency is not a default; an unsupported one still is.
    expect(discoveredEndpoint('hiveskills', {})).toBeNull();
    expect(discoveredEndpoint('emberpath', {})).toBe('https://models.example.com:4020/v1');
  });

  it('checks Magnus\'s own HiveMem credential for an explicit HiveMem', async () => {
    setup({ MAGNUS_ARDENT_HIVEMEM_URL: 'https://memory.example.com' }, { registry: registry() });
    expect((await byName())['hivemem']).toMatchObject({ status: 'awaiting_configuration', source: 'override', reason: expect.stringContaining('MAGNUS_ARDENT_HIVEMEM_CLIENT_ID') });
    setup({ MAGNUS_ARDENT_HIVEMEM_URL: 'https://memory.example.com', ...HIVEMEM_CLIENT }, { registry: registry() });
    expect((await byName())['hivemem']).toMatchObject({ status: 'usable', source: 'override', endpoint: 'https://memory.example.com/' });
  });

  it('never makes a discovered HiveMem an enrollment endpoint', async () => {
    setup({}, { registry: registry() });
    const report = await byName();
    expect(report['hivemem']).toMatchObject({ status: 'awaiting_configuration', source: 'registry', endpoint: 'https://hivemem.example.com:18790/' });
    expect(report['hivemem']!.reason).toContain('set MAGNUS_ARDENT_HIVEMEM_URL');
    // Without its own credential HiveMem enrollment stays off, whatever the Registry lists.
    expect(ardentHiveMemSettings({})).toBeNull();
  });

  it('checks unconfirmed capabilities against the version the product reports, and skips a product the Registry lacks', async () => {
    const unconfirmed = { ...CONNECTIONS['emberpath']!, serviceCapabilities: [{ name: 'emberpath.execution-trace.v1', since: '2.6.0', confirmed: false }] } as RegistryConnection;
    setup({}, { registry: registry({ emberpath: unconfirmed }), versions: { 'models.example.com': '2.5.3' } });
    let report = await byName();
    expect(report['emberpath']).toMatchObject({ status: 'unsupported', capabilities: [] });
    expect(report['hiveskills']).toMatchObject({ status: 'missing', source: 'none' });
    expect(report['hiveskills']!.reason).toContain('The Hive Registry lists no installed hiveskills');
    setup({}, { registry: registry({ emberpath: unconfirmed }), versions: { 'models.example.com': '2.6.0' } });
    report = await byName();
    expect(report['emberpath']).toMatchObject({ status: 'usable', capabilities: ['emberpath.execution-trace.v1'] });
  });

  it('reports an unusable setting and a Registry that cannot be read', async () => {
    setup({ MAGNUS_ARDENT_HIVESKILLS_URL: 'http://skills.example.com' }, { registry: { connection: async () => { throw new Error('HTTP 401'); } } as unknown as RegistryClient });
    const report = await byName();
    expect(report['hiveskills']).toMatchObject({ status: 'awaiting_configuration', source: 'override' });
    expect(report['emberpath']).toMatchObject({ status: 'missing', source: 'none' });
    expect(report['emberpath']!.reason).toContain('could not be read: HTTP 401');
    setDiscoveryDeps({ env: () => ({ MAGNUS_HIVE_REGISTRY_URL: 'https://hive.example.com/api/registry' }) });
    const off = await byName();
    expect(off['emberpath']!.reason).toContain('MAGNUS_HIVE_REGISTRY_URL and MAGNUS_HIVE_REGISTRY_TOKEN_FILE are set together');
  });

  it('caches the report for five minutes unless asked to refresh', async () => {
    let now = 1_000_000;
    const client = registry();
    setup({}, { registry: client, now: () => now });
    await dependencyReport();
    await dependencyReport();
    expect(client.asked).toHaveLength(3);
    expect(cachedDependency('hiveskills')?.source).toBe('registry');
    now += DISCOVERY_REFRESH_MS;
    await dependencyReport();
    expect(client.asked).toHaveLength(6);
    await dependencyReport({ refresh: true });
    expect(client.asked).toHaveLength(9);
  });

  it('compares numeric versions', () => {
    expect(versionAtLeast('2.6.0', '2.6.0')).toBe(true);
    expect(versionAtLeast('v2.10.0', '2.6.0')).toBe(true);
    expect(versionAtLeast('2.5.9', '2.6.0')).toBe(false);
    expect(versionAtLeast('3.3.0-rc.1', '3.3.0')).toBe(false);
    expect(versionAtLeast(null, '1.0.0')).toBe(false);
  });

  it('checks a console-fronted Emberpath at its model API, not at the console root', async () => {
    // A Hive console serves Emberpath only under /v1; its root health/live is the console's own page.
    const env = { MAGNUS_ARDENT_EMBERPATH_URL: 'https://hive.example.com/v1' };
    const probed = setup(env, { services: { 'hive.example.com/health': 'hivexui' }, versions: { 'hive.example.com/health': '0.12.0' },
      capabilities: { 'hive.example.com/health': ['emberpath.execution-trace.v1', 'retry-signal.v1'] } });
    const report = await byName();
    expect(probed).toContain('https://hive.example.com/v1/models');
    // usable, but the console's version and capabilities are not taken for Emberpath's
    expect(report['emberpath']).toMatchObject({ status: 'usable', source: 'override', endpoint: 'https://hive.example.com/v1', capabilities: [] });
    setup(env, { modelsDown: ['hive.example.com'] });
    expect((await byName())['emberpath']).toMatchObject({ status: 'missing', reason: expect.stringContaining('model API answered HTTP 502') });
  });

  it('takes the version and capabilities from health that is Emberpath\'s own', async () => {
    setup({ MAGNUS_ARDENT_EMBERPATH_URL: 'https://models.example.com:4020/v1' }, { services: { 'models.example.com': 'emberpath' },
      versions: { 'models.example.com': '2.6.0' }, capabilities: { 'models.example.com': ['emberpath.execution-trace.v1', 'retry-signal.v1'] } });
    expect((await byName())['emberpath']).toMatchObject({ status: 'usable', capabilities: ['emberpath.execution-trace.v1', 'retry-signal.v1'] });
  });
});
