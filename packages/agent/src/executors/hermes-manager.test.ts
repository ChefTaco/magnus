import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectHermesState,
  configureHermes,
  configureHermesDiscoveryForTests,
  hermesCliHealth,
  hermesInstallationStatus,
  hermesRoutes,
  hermesVersionProbeCountForTests,
  onHermesVersionProbeSettled,
  settleHermesVersionProbesForTests,
} from './hermes-manager.js';

describe('Hermes runtime manager', () => {
  let home: string;
  let bin: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hermes-agent-'));
    bin = join(home, 'hermes');
    await writeFile(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERMES_HOME/calls"
if [ "$1" = "version" ] || [ "$1" = "--version" ]; then
  echo 'Hermes Agent v0.12.0'
  exit 0
fi
if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then
  echo 'running'
  exit 0
fi
exit 0
`, 'utf8');
    await chmod(bin, 0o755);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('configures the Magnus Router and HiveMem and reports managed posture', async () => {
    const configured = await configureHermes(
      { hermesHome: home, hermesBin: bin },
      {
        openaiRuntime: 'codex_app_server',
        router: { baseUrl: 'https://router.example/v1', model: 'magnus/auto', apiKey: 'router-test-key' },
        hiveMem: {
          apiUrl: 'https://hive.example',
          token: 'hive-test-token',
          workspaceId: 'default',
          defaultScope: 'private',
          recallMode: 'hybrid',
          pluginFiles: [{ path: '__init__.py', content: '# HiveMem test plugin\n' }],
        },
      },
    );

    expect(configured.state.configuration.magnusRouterConfigured).toBe(true);
    expect(configured.state.configuration.hiveMemConfigured).toBe(true);
    const config = await readFile(join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('provider: custom');
    expect(config).toContain('openai_runtime: codex_app_server');
    expect(configured.state.configuration.openaiRuntime).toBe('codex_app_server');
    expect(config).toContain('base_url: "https://router.example/v1"');
    expect(config).toContain('provider: hivemem');
    const env = await readFile(join(home, '.env'), 'utf8');
    expect(env).toContain('MAGNUS_ROUTER_API_KEY=router-test-key');
    expect(env).toContain('HERMES_HIVEMEM_TOKEN=hive-test-token');

    await writeFile(join(home, 'config.yaml'), config.replace('https://router.example/v1', 'https://other.example/v1'), 'utf8');
    const drifted = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(drifted.configuration.magnusRouterConfigured).toBe(false);
  });

  it('inherits installation posture for profiles when Hermes only reports their names', async () => {
    await writeFile(join(home, 'config.yaml'), `model:
  provider: openai-codex
  default: gpt-5.6-luna
`, 'utf8');
    await writeFile(join(home, '.env'), `API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
`, 'utf8');
    await writeFile(bin, `#!/bin/sh
if [ "$1" = "version" ] || [ "$1" = "--version" ]; then
  echo 'Hermes Agent v0.12.0'
  exit 0
fi
if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then
  echo 'running'
  exit 0
fi
if [ "$1" = "profile" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then
  echo '[{"name":"default","is_default":true}]'
  exit 0
fi
exit 0
`, 'utf8');
    await chmod(bin, 0o755);

    const state = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(state.profiles).toEqual([expect.objectContaining({
      name: 'default',
      gatewayStatus: 'running',
      providerSummary: 'openai-codex',
      modelSummary: 'gpt-5.6-luna',
      apiServerEnabled: true,
      apiServerPort: 8642,
    })]);
  });

  it.each([
    ['Active: inactive (dead)', 'inactive', 'detected'],
    ['not running', 'inactive', 'detected'],
    ['Active: active (running)', 'running', 'running'],
    ['Active: failed (Result: exit-code)', 'failed', 'detected'],
  ])('reports %j as gateway %s and installation %s', async (output, gatewayStatus, status) => {
    await writeFile(join(home, 'config.yaml'), 'model:\n  provider: custom\n', 'utf8');
    await writeFile(bin, `#!/bin/sh
if [ "$1" = "version" ] || [ "$1" = "--version" ]; then echo 'Hermes Agent v0.12.0'; exit 0; fi
if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then echo '${output}'; exit 0; fi
exit 0
`, 'utf8');
    await expect(collectHermesState({ hermesHome: home, hermesBin: bin }, true)).resolves.toMatchObject({ gatewayStatus, status });
  });

  it('does not let one running gateway count for profiles that reported nothing', async () => {
    await writeFile(bin, `#!/bin/sh
if [ "$1" = "version" ] || [ "$1" = "--version" ]; then echo 'Hermes Agent v0.12.0'; exit 0; fi
if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then echo 'running'; exit 0; fi
if [ "$1" = "profile" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then
  echo '[{"name":"default","is_default":true},{"name":"research"},{"name":"ops","gateway_status":"not running"},{"name":"live","gateway_status":"active"}]'
  exit 0
fi
exit 0
`, 'utf8');
    const state = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(Object.fromEntries(state.profiles.map((profile) => [profile['name'], profile['gatewayStatus']]))).toEqual({
      default: 'running', research: 'unknown', ops: 'inactive', live: 'running',
    });
  });

  it('normalizes the gateway column of profile list text', async () => {
    await writeFile(bin, `#!/bin/sh
if [ "$1" = "version" ] || [ "$1" = "--version" ]; then echo 'Hermes Agent v0.12.0'; exit 0; fi
if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then echo 'stopped'; exit 0; fi
if [ "$1" = "profile" ] && [ "$2" = "list" ] && [ "$3" != "--json" ]; then
  printf '%s\\n' '│ research │ gpt-example │ not running │' '│ ops │ gpt-example │ running │' '│ idle │ gpt-example │ — │'
  exit 0
fi
exit 1
`, 'utf8');
    const state = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(Object.fromEntries(state.profiles.map((profile) => [profile['name'], profile['gatewayStatus']]))).toEqual({
      research: 'inactive', ops: 'running', idle: 'unknown',
    });
  });

  it('reports a Hermes home without a working binary as degraded leftover data', () => {
    const base = { installed: true, runnable: false, gatewayStatus: 'unknown', configPresent: true } as const;
    expect(hermesInstallationStatus(base)).toBe('degraded');
    expect(hermesInstallationStatus({ ...base, runnable: true })).toBe('detected');
    expect(hermesInstallationStatus({ ...base, runnable: true, configPresent: false })).toBe('needs_setup');
    expect(hermesInstallationStatus({ ...base, runnable: true, gatewayStatus: 'running' })).toBe('running');
    expect(hermesInstallationStatus({ ...base, installed: false })).toBe('not_installed');
  });

  it('uses unattended Hermes uninstall flags while preserving configuration by default', async () => {
    const response = await hermesRoutes.request('/uninstall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hermesHome: home, hermesBin: bin, confirm: true }),
    });

    expect(response.status).toBe(200);
    const calls = await readFile(join(home, 'calls'), 'utf8');
    expect(calls).toContain('uninstall --yes');
    expect(calls).not.toContain('uninstall --full --yes');
  });

  it('passes --full only for explicitly destructive Hermes uninstall', async () => {
    const response = await hermesRoutes.request('/uninstall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hermesHome: home, hermesBin: bin, confirm: true, keepConfiguration: false }),
    });

    expect(response.status).toBe(200);
    const calls = await readFile(join(home, 'calls'), 'utf8');
    expect(calls).toContain('uninstall --full --yes');
  });
});

describe('Hermes reconciler endpoints', () => {
  let home: string;
  let bin: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hermes-agent-rec-'));
    bin = join(home, 'hermes');
    await writeFile(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERMES_HOME/calls"
exit 0
`, 'utf8');
    await chmod(bin, 0o755);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('skills/sync installs each requested skill via the CLI', async () => {
    const response = await hermesRoutes.request('/skills/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hermesHome: home,
        hermesBin: bin,
        profile: 'default',
        skills: [
          { slug: 'magnus-skills/cool', pinnedVersion: '1.2.3', enabled: true },
          { slug: 'magnus-skills/drop', enabled: false },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const calls = await readFile(join(home, 'calls'), 'utf8');
    expect(calls).toContain('skill install --profile default magnus-skills/cool@1.2.3');
    expect(calls).toContain('skill remove --profile default magnus-skills/drop');
  });

  it('toolsets/apply enables a toolset', async () => {
    const response = await hermesRoutes.request('/toolsets/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hermesHome: home,
        hermesBin: bin,
        toolset: 'file-tools',
        enabled: true,
        approvalMode: 'auto',
      }),
    });
    expect(response.status).toBe(200);
    const calls = await readFile(join(home, 'calls'), 'utf8');
    expect(calls).toContain('tools enable file-tools');
  });

  it('plugins/install pins a version when provided', async () => {
    const response = await hermesRoutes.request('/plugins/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hermesHome: home, hermesBin: bin, pluginSlug: 'hivemem', pinnedVersion: '0.1.0' }),
    });
    expect(response.status).toBe(200);
    const calls = await readFile(join(home, 'calls'), 'utf8');
    expect(calls).toContain('plugins install hivemem@0.1.0');
  });

  it('role/apply invokes the role apply subcommand', async () => {
    const response = await hermesRoutes.request('/role/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hermesHome: home, hermesBin: bin, profile: 'default', roleName: 'curator' }),
    });
    expect(response.status).toBe(200);
    const calls = await readFile(join(home, 'calls'), 'utf8');
    expect(calls).toContain('role apply --profile default curator');
  });

  it('validation rejects malformed payload', async () => {
    const response = await hermesRoutes.request('/skills/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hermesHome: home, hermesBin: bin, skills: [{ slug: 'bad slug!' }] }),
    });
    expect(response.status).toBe(400);
  });
});

describe('Hermes discovery with a slow version probe', () => {
  let home: string;
  let bin: string;

  /** A Hermes whose `version` is not a command and whose `--version` takes longer than discovery waits. */
  async function writeSlowHermes(version = 'Hermes Agent v0.13.0', sleepSeconds = '0.6'): Promise<void> {
    await writeFile(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERMES_HOME/calls"
if [ "$1" = "version" ]; then echo "error: unknown command 'version'" >&2; exit 2; fi
if [ "$1" = "--version" ]; then sleep ${sleepSeconds}; echo '${version}'; exit 0; fi
if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then echo 'running'; exit 0; fi
if [ "$1" = "profile" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then exit 2; fi
if [ "$1" = "profile" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '│ default │ gpt-example │ running │' '│ research │ gpt-example │ not running │'
  exit 0
fi
exit 0
`, 'utf8');
    await chmod(bin, 0o755);
  }

  async function calls(): Promise<string[]> {
    return (await readFile(join(home, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hermes-agent-slow-'));
    bin = join(home, 'hermes');
    // Only the fixture: never a Hermes that happens to be installed where the tests run.
    configureHermesDiscoveryForTests({
      versionWaitMs: 100,
      versionBudgetMs: 5_000,
      livenessTimeoutMs: 5_000,
      homeCandidates: async (requested) => [requested],
      binCandidates: (requested) => [requested],
    });
  });

  afterEach(async () => {
    await settleHermesVersionProbesForTests();
    configureHermesDiscoveryForTests();
    await rm(home, { recursive: true, force: true });
  });

  it('reports a Hermes whose --version is slow as runnable, then caches its version', async () => {
    await writeSlowHermes();
    let settled = 0;
    const unsubscribe = onHermesVersionProbeSettled(() => { settled += 1; });
    try {
      const first = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
      expect(first).toMatchObject({ installed: true, version: null, gatewayStatus: 'running', status: 'running' });
      expect(first.rawChecks).toMatchObject({ binaryDetected: true, versionProbe: 'pending' });
      expect(first.profiles.map((profile) => profile['name'])).toEqual(['default', 'research']);

      await settleHermesVersionProbesForTests();
      expect(settled).toBe(1);
      const second = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
      expect(second).toMatchObject({ version: 'Hermes Agent v0.13.0', status: 'running' });
      expect(second.rawChecks).toMatchObject({ versionProbe: 'ok' });
      await collectHermesState({ hermesHome: home, hermesBin: bin }, true);

      const made = await calls();
      expect(made.filter((call) => call === 'version')).toHaveLength(1);
      expect(made.filter((call) => call === '--version')).toHaveLength(1);
      expect(hermesVersionProbeCountForTests()).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it('keeps a Hermes runnable with no version when the version probe runs out of time', async () => {
    configureHermesDiscoveryForTests({
      versionWaitMs: 50,
      versionBudgetMs: 300,
      livenessTimeoutMs: 5_000,
      homeCandidates: async (requested) => [requested],
      binCandidates: (requested) => [requested],
    });
    await writeSlowHermes('Hermes Agent v0.13.0', '3');
    await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    await settleHermesVersionProbesForTests();
    const state = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(state).toMatchObject({ installed: true, version: null, status: 'running' });
    expect(state.rawChecks).toMatchObject({ binaryDetected: true, versionProbe: 'timeout' });
    // The timed-out probe is not repeated on every discovery.
    expect((await calls()).filter((call) => call === '--version')).toHaveLength(1);
  });

  it('falls back to --version when version is not a command', async () => {
    await writeSlowHermes('Hermes Agent v0.13.1', '0');
    configureHermesDiscoveryForTests({
      versionWaitMs: 5_000,
      homeCandidates: async (requested) => [requested],
      binCandidates: (requested) => [requested],
    });
    const state = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(state).toMatchObject({ version: 'Hermes Agent v0.13.1', status: 'running' });
    expect(state.rawChecks).toMatchObject({ versionProbe: 'ok' });
  });

  it('probes the version again when the binary changes, and forgets it when the binary disappears', async () => {
    await writeSlowHermes('Hermes Agent v0.13.0', '0');
    await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    await settleHermesVersionProbesForTests();
    expect((await collectHermesState({ hermesHome: home, hermesBin: bin }, true)).version).toBe('Hermes Agent v0.13.0');

    await writeSlowHermes('Hermes Agent v0.14.0-updated', '0');
    await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    await settleHermesVersionProbesForTests();
    expect((await collectHermesState({ hermesHome: home, hermesBin: bin }, true)).version).toBe('Hermes Agent v0.14.0-updated');
    expect((await calls()).filter((call) => call === '--version')).toHaveLength(2);
    expect(hermesVersionProbeCountForTests()).toBe(1);

    await rm(bin);
    const gone = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(gone).toMatchObject({ version: null });
    expect(gone.rawChecks).toMatchObject({ binaryDetected: false, versionProbe: 'not_found' });
    expect(hermesVersionProbeCountForTests()).toBe(0);
  });

  it('reports a binary that fails both the version probe and the liveness check as degraded, without hidden profile directories', async () => {
    await writeFile(join(home, 'config.yaml'), 'model:\n  provider: custom\n', 'utf8');
    await mkdir(join(home, 'profiles', 'default'), { recursive: true });
    await mkdir(join(home, 'profiles', 'research'), { recursive: true });
    await mkdir(join(home, 'profiles', '.deleted', 'old-profile'), { recursive: true });
    await writeFile(bin, '#!/bin/sh\necho "broken" >&2\nexit 1\n', 'utf8');
    await chmod(bin, 0o755);

    const state = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(state).toMatchObject({ installed: true, status: 'degraded', version: null });
    expect(state.profiles.map((profile) => profile['name']).sort()).toEqual(['default', 'research']);
  });

  it('ignores hidden entries in profile list output', async () => {
    await writeFile(bin, `#!/bin/sh
if [ "$1" = "version" ] || [ "$1" = "--version" ]; then echo 'Hermes Agent v0.12.0'; exit 0; fi
if [ "$1" = "profile" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then
  echo '[{"name":"default","is_default":true},{"name":".deleted"}]'
  exit 0
fi
exit 0
`, 'utf8');
    await chmod(bin, 0o755);
    const state = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(state.profiles.map((profile) => profile['name'])).toEqual(['default']);
  });
});

describe('the hermes-cli health check reads the discovery cache', () => {
  let root: string;
  let home: string;
  let bin: string;

  /** `version` is not a command, `--version` takes `sleepSeconds`, `profile list` answers unless broken. */
  async function writeHermes(sleepSeconds: string, broken = false): Promise<void> {
    await mkdir(join(home, 'hermes-agent', 'venv', 'bin'), { recursive: true });
    await writeFile(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERMES_HOME/calls"
if [ "$1" = "version" ]; then echo "error: unknown command 'version'" >&2; exit 2; fi
if [ "$1" = "--version" ]; then sleep ${sleepSeconds}; ${broken ? 'exit 1' : "echo 'Hermes Agent v0.13.0'; exit 0"}; fi
if [ "$1" = "profile" ] && [ "$2" = "list" ]; then ${broken ? 'exit 1' : "echo '│ default │ gpt-example │ running │'; exit 0"}; fi
exit 0
`, 'utf8');
    await chmod(bin, 0o755);
  }
  const versionCalls = async () => (await readFile(join(home, 'calls'), 'utf8').catch(() => '')).split('\n').filter(call => call === '--version').length;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-cli-health-'));
    // The layout of a user-installed Hermes, so the check derives the same home as discovery.
    home = join(root, '.hermes');
    bin = join(home, 'hermes-agent', 'venv', 'bin', 'hermes');
    configureHermesDiscoveryForTests({ versionWaitMs: 50, versionBudgetMs: 5_000, livenessTimeoutMs: 5_000,
      homeCandidates: async (requested) => [requested], binCandidates: (requested) => [requested] });
  });

  afterEach(async () => {
    await settleHermesVersionProbesForTests();
    configureHermesDiscoveryForTests();
    await rm(root, { recursive: true, force: true });
  });

  it('passes within its wait for a Hermes whose --version is slow, from what discovery found, without probing again', async () => {
    await writeHermes('3');
    await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    const started = Date.now();
    const health = await hermesCliHealth(bin, 1_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(health).toEqual({ ok: true, message: 'runnable (answers profile list); version probe still running' });
    expect(await versionCalls()).toBe(1);
  });

  it('reports the cached version once the probe has settled', async () => {
    await writeHermes('0.2');
    await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    await settleHermesVersionProbesForTests();
    expect(await hermesCliHealth(bin)).toEqual({ ok: true, message: 'Hermes Agent v0.13.0' });
    expect(await versionCalls()).toBe(1);
  });

  it('before any discovery: starts the shared probe, answers from the liveness command, and starts no second probe', async () => {
    await writeHermes('3');
    const started = Date.now();
    expect(await hermesCliHealth(bin, 1_500)).toEqual({ ok: true, message: 'runnable (answers profile list); version probe still running' });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(await hermesCliHealth(bin, 1_500)).toMatchObject({ ok: true });
    expect(hermesVersionProbeCountForTests()).toBe(1);
    expect(await versionCalls()).toBe(1);
  });

  it('fails for a Hermes that answers neither command, and for a missing one', async () => {
    await writeHermes('0', true);
    expect(await hermesCliHealth(bin, 1_500)).toEqual({ ok: false, message: expect.stringContaining('profile list failed') });
    expect(await hermesCliHealth(join(root, 'missing', 'hermes'), 500)).toMatchObject({ ok: false });
  });
});
