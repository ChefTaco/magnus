import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHermesState, configureHermes, hermesRoutes } from './hermes-manager.js';

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
