import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ardentArtifactMaxBytes, ardentPackageNames, ardentUserUnit, createArdentRoutes, hermesTrafficConsumersDisabled, readArdentState, relayBody, verifiedInstalledArdentPackage, writeProfileCredential } from './ardent-manager.js';

const dirs: string[] = [];
const servers: Server[] = [];
const originalPackages = process.env['MAGNUS_AGENT_ARDENT_PACKAGES'];
afterEach(async () => {
  if (originalPackages === undefined) delete process.env['MAGNUS_AGENT_ARDENT_PACKAGES']; else process.env['MAGNUS_AGENT_ARDENT_PACKAGES'] = originalPackages;
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('node-local Ardent inventory and management boundary', () => {
  it('reinstalls a same-version Ardent package when its receipt or installed bytes differ', async () => {
    const install = await mkdtemp(join(tmpdir(), 'magnus-ardent-install-receipt-'));
    dirs.push(install);
    const packageRoot = join(install, 'node_modules/@hivemagnus/ardent');
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    const files = [
      ['dist/cli.js', 'export const release = 1;\n'],
      ['package.json', '{"name":"@hivemagnus/ardent","version":"0.1.7"}\n'],
    ] as const;
    for (const [name, content] of files) await writeFile(join(packageRoot, name), content);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const tree = digest(files.map(([name, content]) => name + ' ' + digest(content) + '\n').sort().join(''));
    const staged = { version: '0.1.7', sha256: digest('release-package') };
    await writeFile(join(install, 'package-receipt.json'), JSON.stringify({
      schemaVersion: 1, name: '@hivemagnus/ardent', version: staged.version,
      sha256: staged.sha256, packageTreeSha256: tree,
    }));
    expect(await verifiedInstalledArdentPackage(install, staged)).toBe(true);
    expect(await verifiedInstalledArdentPackage(install, { ...staged, sha256: digest('other-package') })).toBe(false);
    await writeFile(join(packageRoot, 'dist/cli.js'), 'export const release = 2;\n');
    expect(await verifiedInstalledArdentPackage(install, staged)).toBe(false);
  });
  it('permits restart beside Hermes only when all Hermes traffic consumers are explicitly disabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'magnus-ardent-handover-'));
    dirs.push(home);
    await mkdir(join(home, '.hermes'));
    const config = join(home, '.hermes/config.yaml');
    const env = join(home, '.hermes/.env');
    await writeFile(config, 'telegram:\n  enabled: false\nmattermost:\n  enabled: false\na2a:\n  enabled: false\n');
    await writeFile(env, 'A2A_PORT=\n');
    expect(await hermesTrafficConsumersDisabled(home)).toBe(true);
    await writeFile(env, 'A2A_PORT=9900\n');
    expect(await hermesTrafficConsumersDisabled(home)).toBe(false);
    await writeFile(env, 'A2A_PORT=\n');
    await writeFile(config, 'telegram:\n  enabled: true\nmattermost:\n  enabled: false\na2a:\n  enabled: false\n');
    expect(await hermesTrafficConsumersDisabled(home)).toBe(false);
  });
  it('reports only a staged package bound to the agent release manifest', async () => {
    const home = await mkdtemp(join(tmpdir(), 'magnus-ardent-package-'));
    dirs.push(home);
    const archive = join(home, 'ardent-package.tgz');
    const sidecar = join(home, 'ardent-package.json');
    const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const packageBytes = 'package fixture';
    const details = JSON.stringify({ name: '@hivemagnus/ardent', version: '0.1.0', sha256: digest(packageBytes) });
    await writeFile(archive, packageBytes);
    await writeFile(sidecar, details);
    await writeFile(join(home, 'component-manifest.json'), JSON.stringify({ component: 'agent', files: [
      { path: 'ardent-package.tgz', sha256: digest(packageBytes) }, { path: 'ardent-package.json', sha256: digest(details) },
    ] }));
    const previous = process.env['ARDENT_STAGED_PACKAGE'];
    process.env['ARDENT_STAGED_PACKAGE'] = archive;
    try {
      const target = { owner: 'fixture', home, root: join(home, '.ardent'), install: join(home, '.local/share/ardent') };
      const valid = await readArdentState(target) as { stagedPackage: { version: string } | null; stagedPackageError: string | null };
      expect(valid.stagedPackage?.version).toBe('0.1.0');
      expect(valid.stagedPackageError).toBeNull();
      await writeFile(archive, 'tampered');
      const tampered = await readArdentState(target) as { stagedPackage: unknown; stagedPackageError: string | null };
      expect(tampered.stagedPackage).toBeNull();
      expect(tampered.stagedPackageError).toMatch(/differs/);
    } finally {
      if (previous === undefined) delete process.env['ARDENT_STAGED_PACKAGE']; else process.env['ARDENT_STAGED_PACKAGE'] = previous;
    }
  });
  it('proves profile identity with its private token and proxies only bounded reads', async () => {
    const requests: string[] = [];
    const artifactId = 'a'.repeat(64);
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.headers.authorization !== 'Bearer private-fixture-token') { response.writeHead(401).end('{}'); return; }
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/v1/profile') response.end(JSON.stringify({ profile: 'example', product: 'Magnus Ardent' }));
      else if (request.url === '/api/v1/status') response.end(JSON.stringify({ profile: 'example', backend: 'llamacpp', tasks: 1 }));
      else if (request.url === `/api/v1/artifacts/${artifactId}`) response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(Buffer.from([0, 1, 2, 255]));
      else if (request.url === '/api/v1/config/validate' && request.method === 'POST') response.end(JSON.stringify({ valid: true }));
      else if (request.url === '/api/v1/tasks' && request.method === 'POST') response.writeHead(202).end(JSON.stringify({ task_id: '00000000-0000-4000-8000-000000000001', state: 'queued' }));
      else response.writeHead(404).end('{}');
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener absent');
    const home = await mkdtemp(join(tmpdir(), 'magnus-ardent-node-'));
    dirs.push(home);
    const root = join(home, '.ardent');
    const install = join(home, '.local/share/ardent');
    const profile = join(root, 'profiles/example');
    await mkdir(profile, { recursive: true });
    await mkdir(join(install, 'node_modules/@hivemagnus/ardent'), { recursive: true });
    await writeFile(join(install, 'node_modules/@hivemagnus/ardent/package.json'), JSON.stringify({ name: '@hivemagnus/ardent', version: '0.1.0' }));
    await writeFile(join(profile, 'config.yaml'), `schema_version: 1\nprofile: example\nname: Example\nexecution:\n  backend: llamacpp\napi:\n  host: 127.0.0.1\n  port: ${address.port}\n  token_env: ARDENT_API_TOKEN\na2a:\n  enabled: false\nchannels:\n  telegram:\n    enabled: false\n  mattermost:\n    enabled: false\n`);
    await writeFile(join(profile, '.env'), 'ARDENT_API_TOKEN=private-fixture-token\n', { mode: 0o600 });
    const target = { owner: 'fixture', home, root, install };
    const state = await readArdentState(target) as { installed: boolean; version: string; profiles: { id: string; running: boolean }[] };
    expect(state.installed).toBe(true);
    expect(state.version).toBe('0.1.0');
    expect(state.profiles).toEqual([expect.objectContaining({ id: 'example', running: true })]);
    const routes = createArdentRoutes(async () => target);
    const status = await routes.request('/profiles/example/api/status');
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ profile: 'example', backend: 'llamacpp', tasks: 1 });
    const artifact = await routes.request(`/profiles/example/api/artifacts/${artifactId}`);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(await artifact.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 255]));
    expect((await routes.request('/profiles/example/api/artifacts/../../config')).status).not.toBe(200);
    expect((await routes.request('/profiles/example/api/memory/search')).status).toBe(404);
    expect((await routes.request('/profiles/../api/status')).status).not.toBe(200);
    const validated = await routes.request('/action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'example', action: 'config-validate', body: { text: 'schema_version: 1' } }) });
    expect(validated.status).toBe(200);
    expect(await validated.json()).toEqual({ valid: true });
    expect((await routes.request('/action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'example', action: 'channel-test', target: '../private' }) })).status).toBe(400);
    // Ardent has no Hermes profile importer; the action was removed rather than left to fail at run time.
    expect((await routes.request('/action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'example', action: 'profile-import-hermes', body: { apply: false } }) })).status).toBe(400);
    const admission = await routes.request('/action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'example', action: 'task-submit', body: { prompt: 'Test', idempotency_key: '00000000-0000-4000-8000-000000000002' } }) });
    expect(admission.status).toBe(200);
    expect(await admission.json()).toEqual({ task_id: '00000000-0000-4000-8000-000000000001', state: 'queued' });
    expect(requests).toEqual(['/api/v1/profile', '/api/v1/profile', '/api/v1/status', '/api/v1/profile', `/api/v1/artifacts/${artifactId}`, '/api/v1/profile', '/api/v1/config/validate', '/api/v1/profile', '/api/v1/tasks']);
  });
});

describe('accepted Ardent package names', () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  async function installFixture(name: string) {
    const home = await mkdtemp(join(tmpdir(), 'magnus-ardent-names-'));
    dirs.push(home);
    const install = join(home, '.local/share/ardent');
    const packageRoot = join(install, 'node_modules', ...name.split('/'));
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    const files = [['dist/cli.js', 'export {};\n'], ['package.json', JSON.stringify({ name, version: '0.1.9' })]] as const;
    for (const [file, content] of files) await writeFile(join(packageRoot, file), content);
    const tree = digest(files.map(([file, content]) => file + ' ' + digest(content) + '\n').sort().join(''));
    const staged = { version: '0.1.9', sha256: digest('legacy-package') };
    await writeFile(join(install, 'package-receipt.json'), JSON.stringify({ schemaVersion: 1, name, ...staged, packageTreeSha256: tree }));
    return { home, install, staged, target: { owner: 'fixture', home, root: join(home, '.ardent'), install } };
  }

  it('defaults to the public package and validates the configured list', () => {
    expect(ardentPackageNames(undefined)).toEqual(['@hivemagnus/ardent']);
    expect(ardentPackageNames('')).toEqual(['@hivemagnus/ardent']);
    expect(ardentPackageNames(' @hivemagnus/ardent , @legacy-scope/ardent,@legacy-scope/ardent ')).toEqual(['@hivemagnus/ardent', '@legacy-scope/ardent']);
    for (const invalid of ['ardent', '@scope/../x', '@Scope/ardent', '@scope/ardent/extra', ',', '@scope/ar dent'])
      expect(() => ardentPackageNames(invalid), invalid).toThrow(/MAGNUS_AGENT_ARDENT_PACKAGES/);
  });

  it('ignores an installed legacy package unless its name is accepted', async () => {
    const { install, staged, target } = await installFixture('@legacy-scope/ardent');
    delete process.env['MAGNUS_AGENT_ARDENT_PACKAGES'];
    expect((await readArdentState(target) as { installed: boolean }).installed).toBe(false);
    expect(await verifiedInstalledArdentPackage(install, staged)).toBe(false);
    process.env['MAGNUS_AGENT_ARDENT_PACKAGES'] = '@hivemagnus/ardent,@legacy-scope/ardent';
    const state = await readArdentState(target) as { installed: boolean; version: string; packageName: string };
    expect(state).toMatchObject({ installed: true, version: '0.1.9', packageName: '@legacy-scope/ardent' });
    expect(await verifiedInstalledArdentPackage(install, staged)).toBe(true);
    expect(await verifiedInstalledArdentPackage(install, { ...staged, name: '@legacy-scope/ardent' })).toBe(true);
    expect(await verifiedInstalledArdentPackage(install, { ...staged, name: '@hivemagnus/ardent' })).toBe(false);
    expect(ardentUserUnit(target, 'example', '@legacy-scope/ardent')).toContain(join(install, 'node_modules/@legacy-scope/ardent/dist/cli.js'));
    expect(ardentUserUnit(target, 'example')).toContain(join(install, 'node_modules/@hivemagnus/ardent/dist/cli.js'));
  });

  it('accepts a legacy staged sidecar only for an accepted package name', async () => {
    const home = await mkdtemp(join(tmpdir(), 'magnus-ardent-legacy-stage-'));
    dirs.push(home);
    const archive = join(home, 'ardent-package.tgz');
    const packageBytes = 'legacy package fixture';
    // Older release builders wrote exactly this sidecar shape.
    const details = JSON.stringify({ name: '@legacy-scope/ardent', version: '0.1.5', sha256: digest(packageBytes) }) + '\n';
    await writeFile(archive, packageBytes);
    await writeFile(join(home, 'ardent-package.json'), details);
    await writeFile(join(home, 'component-manifest.json'), JSON.stringify({ component: 'agent', files: [
      { path: 'ardent-package.tgz', sha256: digest(packageBytes) }, { path: 'ardent-package.json', sha256: digest(details) },
    ] }));
    const previous = process.env['ARDENT_STAGED_PACKAGE'];
    process.env['ARDENT_STAGED_PACKAGE'] = archive;
    try {
      const target = { owner: 'fixture', home, root: join(home, '.ardent'), install: join(home, '.local/share/ardent') };
      const rejected = await readArdentState(target) as { stagedPackage: unknown; stagedPackageError: string | null };
      expect(rejected.stagedPackage).toBeNull();
      expect(rejected.stagedPackageError).toMatch(/not accepted/);
      process.env['MAGNUS_AGENT_ARDENT_PACKAGES'] = '@hivemagnus/ardent,@legacy-scope/ardent';
      const accepted = await readArdentState(target) as { stagedPackage: { name: string; version: string } | null };
      expect(accepted.stagedPackage).toMatchObject({ name: '@legacy-scope/ardent', version: '0.1.5' });
    } finally {
      if (previous === undefined) delete process.env['ARDENT_STAGED_PACKAGE']; else process.env['ARDENT_STAGED_PACKAGE'] = previous;
    }
  });

  it('reports profile channels with keys beyond the built-in adapters', async () => {
    const { home, target } = await installFixture('@hivemagnus/ardent');
    const profile = join(home, '.ardent/profiles/example');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'config.yaml'), 'schema_version: 1\nprofile: example\nname: Example\nexecution:\n  backend: codex\napi:\n  host: 127.0.0.1\n  port: 9\n  token_env: ARDENT_API_TOKEN\na2a:\n  enabled: false\nchannels:\n  telegram:\n    enabled: true\n  legacy-chat:\n    enabled: false\n    url: https://chat.example.com\n');
    await writeFile(join(profile, '.env'), 'ARDENT_API_TOKEN=fixture-token\n', { mode: 0o600 });
    const state = await readArdentState(target) as { profiles: Array<{ id: string; channels: Record<string, boolean>; error: string | null }> };
    expect(state.profiles).toEqual([expect.objectContaining({ id: 'example', error: null, channels: { telegram: true, 'legacy-chat': false } })]);
  });
});

describe('Ardent Studio bridge', () => {
  const taskId = '00000000-0000-4000-8000-0000000000aa';
  async function fixtureProfile(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void) {
    const requests: Array<{ url: string; method: string; body: string; lastEventId?: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        requests.push({ url: request.url ?? '', method: request.method ?? '', body,
          ...(typeof request.headers['last-event-id'] === 'string' ? { lastEventId: request.headers['last-event-id'] } : {}) });
        if (request.headers.authorization !== 'Bearer private-fixture-token') { response.writeHead(401).end('{}'); return; }
        if (request.url === '/api/v1/profile') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ profile: 'example', product: 'Magnus Ardent' })); return; }
        handler(request, response);
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener absent');
    const home = await mkdtemp(join(tmpdir(), 'magnus-ardent-studio-'));
    dirs.push(home);
    const root = join(home, '.ardent');
    const profile = join(root, 'profiles/example');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'config.yaml'), `schema_version: 1\nprofile: example\nname: Example\nexecution:\n  backend: llamacpp\napi:\n  host: 127.0.0.1\n  port: ${address.port}\n  token_env: ARDENT_API_TOKEN\na2a:\n  enabled: false\n`);
    await writeFile(join(profile, '.env'), 'ARDENT_API_TOKEN=private-fixture-token\n', { mode: 0o600 });
    const target = { owner: 'fixture', home, root, install: join(home, '.local/share/ardent') };
    return { routes: createArdentRoutes(async () => target), requests };
  }
  const action = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('reports the studio capability with its inventory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'magnus-ardent-capability-'));
    dirs.push(home);
    const state = await readArdentState({ owner: 'fixture', home, root: join(home, '.ardent'), install: join(home, 'install') }) as { capabilities?: { studio?: number } };
    expect(state.capabilities).toEqual({ studio: 2 });
  });

  it('opens sessions and submits session-bound tasks with bounded input', async () => {
    const { routes, requests } = await fixtureProfile((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/v1/sessions') response.end(JSON.stringify({ id: taskId, caller: 'management', context: 'direct', key: 'studio:p1', created_ms: 1, updated_ms: 1 }));
      else if (request.url === '/api/v1/tasks') response.writeHead(202).end(JSON.stringify({ task_id: taskId, state: 'queued' }));
      else response.writeHead(404).end('{}');
    });
    const opened = await routes.request('/action', action({ profile: 'example', action: 'session-open', body: { key: 'studio:p1' } }));
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ id: taskId, key: 'studio:p1' });
    expect((await routes.request('/action', action({ profile: 'example', action: 'session-open', body: { key: '' } }))).status).toBe(400);
    expect((await routes.request('/action', action({ profile: 'example', action: 'session-open', body: { key: 'k', extra: 1 } }))).status).toBe(400);
    const submitted = await routes.request('/action', action({ profile: 'example', action: 'task-submit',
      body: { prompt: 'x'.repeat(16000), idempotency_key: '00000000-0000-4000-8000-000000000002', session_id: taskId } }));
    expect(submitted.status).toBe(200);
    expect((await routes.request('/action', action({ profile: 'example', action: 'task-submit',
      body: { prompt: 'x'.repeat(16001), idempotency_key: '00000000-0000-4000-8000-000000000003' } }))).status).toBe(400);
    expect((await routes.request('/action', action({ profile: 'example', action: 'task-submit',
      body: { prompt: 'Test', idempotency_key: '00000000-0000-4000-8000-000000000003', session_id: 'not-a-session' } }))).status).toBe(400);
    expect(requests.filter(item => item.url !== '/api/v1/profile').map(item => [item.method, item.url, JSON.parse(item.body)])).toEqual([
      ['POST', '/api/v1/sessions', { key: 'studio:p1' }],
      ['POST', '/api/v1/tasks', { prompt: 'x'.repeat(16000), idempotency_key: '00000000-0000-4000-8000-000000000002', session_id: taskId }],
    ]);
  });

  it('relays task stream events as they arrive, with the resume cursor', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { routes, requests } = await fixtureProfile((request, response) => {
      if (request.url?.startsWith(`/api/v1/tasks/${taskId}/stream`)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: task.delta\ndata: {"step":1,"text":"Hel"}\n\n');
        void gate.then(() => response.end('event: task.done\ndata: {"state":"completed"}\n\n'));
        return;
      }
      response.writeHead(404).end('{}');
    });
    const response = await routes.request(`/profiles/example/api/tasks/${taskId}/stream?after=7`, { headers: { 'Last-Event-ID': '9' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    const first = await reader.read();
    // The first event is readable while the upstream is still open: nothing waits for the end.
    expect(new TextDecoder().decode(first.value)).toContain('"text":"Hel"');
    release();
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
    expect(rest).toContain('task.done');
    expect(requests.at(-1)).toMatchObject({ url: `/api/v1/tasks/${taskId}/stream?after=7`, lastEventId: '9' });
    expect((await routes.request(`/profiles/example/api/tasks/${taskId}/stream?after=x`)).status).toBe(400);
  });

  it('streams artifacts above 2 MiB and refuses ones above the configured cap', async () => {
    const artifactId = 'b'.repeat(64);
    const size = 3 * 1024 * 1024;
    const { routes } = await fixtureProfile((request, response) => {
      if (request.url === `/api/v1/artifacts/${artifactId}`) {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        const chunk = Buffer.alloc(256 * 1024, 7);
        for (let sent = 0; sent < size; sent += chunk.length) response.write(chunk);
        response.end();
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
    });
    const previous = process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'];
    try {
      delete process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'];
      const artifact = await routes.request(`/profiles/example/api/artifacts/${artifactId}`);
      expect(artifact.status).toBe(200);
      expect(artifact.headers.get('content-type')).toBe('application/octet-stream');
      expect((await artifact.arrayBuffer()).byteLength).toBe(size);
      const missing = await routes.request(`/profiles/example/api/artifacts/${'c'.repeat(64)}`);
      expect(missing.status).toBe(404);
      process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'] = String(1024 * 1024);
      const capped = await routes.request(`/profiles/example/api/artifacts/${artifactId}`);
      await expect(capped.arrayBuffer()).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES']; else process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'] = previous;
    }
  });

  const mission = { id: 'project-1:brief', revision: 1, parent_task: null, constraints: [], allowed_actions: ['analyze', 'create_artifact'],
    resources: ['tool:artifact_write', 'project:p1'], deadline: 4_102_444_800, acceptance_criteria: ['A brief exists'], expected_artifacts: ['brief.md'] };
  const missionBody = { session_id: taskId, objective: 'Write the brief', mission, context_items: [{ title: 'Notes', text: 'Fixture context' }],
    labels: { 'studio.project': 'p1' }, idempotency_key: 'mission:project-1:brief:1' };

  it('submits missions and previews, pauses and resumes tasks and records development notes', async () => {
    const { routes, requests } = await fixtureProfile((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/v1/sessions') response.end(JSON.stringify({ id: taskId, caller: 'management', context: 'mission', key: 'studio:p1', created_ms: 1, updated_ms: 1 }));
      else if (request.url === '/api/v1/missions' || request.url === '/api/v1/preview/tasks') response.writeHead(202).end(JSON.stringify({ task_id: taskId, state: 'queued' }));
      else if (request.url === `/api/v1/tasks/${taskId}/pause`) response.end(JSON.stringify({ task_id: taskId, state: 'running', admission: 'paused' }));
      else if (request.url === `/api/v1/tasks/${taskId}/resume`) response.writeHead(409).end(JSON.stringify({ error: { code: 'CONFLICT', message: 'Task already finished' } }));
      else if (request.url === '/api/v1/development') response.writeHead(201).end(JSON.stringify({ id: 'dev_1' }));
      else response.writeHead(404).end('{}');
    });
    const run = async (body: unknown) => routes.request('/action', action({ profile: 'example', ...body as object }));
    expect((await run({ action: 'session-open', body: { key: 'studio:p1', context: 'mission' } })).status).toBe(200);
    expect((await run({ action: 'session-open', body: { key: 'studio:p1', context: 'peer' } })).status).toBe(400);
    // Ardent answers 202; the agent settles the admission as 200 like task-submit.
    const submitted = await run({ action: 'mission-submit', body: missionBody });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ task_id: taskId, state: 'queued' });
    expect((await run({ action: 'preview-submit', body: { prompt: 'Say hello', overrides: { soul: '# Soul', model: 'fixture-model' } } })).status).toBe(200);
    const paused = await run({ action: 'task-pause', target: taskId });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ task_id: taskId, state: 'running', admission: 'paused' });
    // A finished task's 409 reaches the caller unchanged.
    expect((await run({ action: 'task-resume', target: taskId })).status).toBe(409);
    expect((await run({ action: 'development-note', body: { kind: 'operator_note', title: 'Tone', body: 'Shorter answers', author: 'operator' } })).status).toBe(201);
    expect(requests.filter(item => item.url !== '/api/v1/profile').map(item => [item.method, item.url])).toEqual([
      ['POST', '/api/v1/sessions'], ['POST', '/api/v1/missions'], ['POST', '/api/v1/preview/tasks'],
      ['POST', `/api/v1/tasks/${taskId}/pause`], ['POST', `/api/v1/tasks/${taskId}/resume`], ['POST', '/api/v1/development'],
    ]);
    expect(JSON.parse(requests.find(item => item.url === '/api/v1/missions')!.body)).toEqual(missionBody);
    expect(JSON.parse(requests.find(item => item.url === '/api/v1/sessions')!.body)).toEqual({ key: 'studio:p1', context: 'mission' });
  });

  it('refuses malformed or oversized mission, preview, pause and note requests before Ardent sees them', async () => {
    const { routes, requests } = await fixtureProfile((_request, response) => { response.writeHead(500).end('{}'); });
    const run = async (body: unknown) => (await routes.request('/action', action({ profile: 'example', ...body as object }))).status;
    expect(await run({ action: 'mission-submit', body: { ...missionBody, extra: true } })).toBe(400);
    expect(await run({ action: 'mission-submit', body: { ...missionBody, mission: { ...mission, allowed_actions: [] } } })).toBe(400);
    expect(await run({ action: 'mission-submit', body: { ...missionBody, objective: 'x'.repeat(16_001) } })).toBe(400);
    expect(await run({ action: 'mission-submit', body: { ...missionBody, context_items: [{ title: 'Big', text: 'x'.repeat(64 * 1024) }] } })).toBe(400);
    expect(await run({ action: 'mission-submit', body: { ...missionBody, idempotency_key: undefined } })).toBe(400);
    expect(await run({ action: 'preview-submit', body: { prompt: 'Hi', overrides: { temperature: 1 } } })).toBe(400);
    expect(await run({ action: 'task-pause' })).toBe(400);
    expect(await run({ action: 'task-pause', target: taskId, body: { now: true } })).toBe(400);
    expect(await run({ action: 'task-resume', target: '../config' })).toBe(400);
    expect(await run({ action: 'development-note', body: { kind: 'Bad Kind', title: 'x', body: 'y' } })).toBe(400);
    expect(await run({ action: 'development-note', body: { kind: 'note', title: 'x', body: 'y', author: 'runtime' } })).toBe(400);
    // A preview may carry a full soul and identity, which is more than the 200 KB other actions get.
    const soul = 'x'.repeat(131_072);
    expect(await run({ action: 'preview-submit', body: { prompt: 'Hi', overrides: { soul, identity: soul } } })).toBe(500);
    expect(requests.filter(item => item.url !== '/api/v1/profile').map(item => item.url)).toEqual(['/api/v1/preview/tasks']);
  });

  it('reads artifact manifests and development history with checked query parameters', async () => {
    const sha = 'd'.repeat(64);
    const { routes, requests } = await fixtureProfile((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === `/api/v1/tasks/${taskId}/artifacts`) response.end(JSON.stringify({ artifacts: [] }));
      else if (request.url === `/api/v1/artifacts/${sha}/manifest`) response.end(JSON.stringify({ task_id: taskId, superseded_by_sha256: null, manifest: { sha256: sha } }));
      else if (request.url?.startsWith('/api/v1/development')) response.end(JSON.stringify({ records: [], next: null }));
      else if (request.url?.startsWith('/api/v1/sessions')) response.end(JSON.stringify({ sessions: [] }));
      else response.writeHead(404).end('{}');
    });
    expect(await (await routes.request(`/profiles/example/api/tasks/${taskId}/artifacts`)).json()).toEqual({ artifacts: [] });
    const manifest = await routes.request(`/profiles/example/api/artifacts/${sha}/manifest`);
    // A manifest is JSON, read like any resource, not relayed as artifact bytes.
    expect(manifest.headers.get('content-type')).toContain('application/json');
    expect(await manifest.json()).toMatchObject({ manifest: { sha256: sha } });
    expect((await routes.request('/profiles/example/api/development?after=eyJhIjoxfQ&limit=20&kind=skill_change&ignored=1')).status).toBe(200);
    expect((await routes.request('/profiles/example/api/sessions?context=mission')).status).toBe(200);
    expect((await routes.request('/profiles/example/api/development?kind=Bad')).status).toBe(400);
    expect((await routes.request('/profiles/example/api/sessions?context=peer')).status).toBe(400);
    expect((await routes.request(`/profiles/example/api/artifacts/${sha}/raw`)).status).toBe(404);
    expect(requests.filter(item => item.url !== '/api/v1/profile').map(item => item.url)).toEqual([
      `/api/v1/tasks/${taskId}/artifacts`, `/api/v1/artifacts/${sha}/manifest`,
      '/api/v1/development?after=eyJhIjoxfQ&limit=20&kind=skill_change', '/api/v1/sessions?context=mission',
    ]);
  });
});

describe('relayBody', () => {
  it('ends an idle event stream cleanly and fails an idle download', async () => {
    const stalled = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
    for (const idle of ['close', 'error'] as const) {
      const abort = new AbortController();
      const upstream = stalled();
      const source = upstream.getReader();
      // An upstream that fails once aborted, as fetch bodies do.
      const linked = new ReadableStream<Uint8Array>({ async pull(controller) {
        const next = await Promise.race([source.read(), new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))]);
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } });
      const relay = relayBody(linked, abort, { idleMs: 20, idle });
      const reader = relay.getReader();
      expect((await reader.read()).value).toEqual(new Uint8Array([1]));
      if (idle === 'close') expect((await reader.read()).done).toBe(true);
      else await expect(reader.read()).rejects.toThrow();
      expect(abort.signal.aborted).toBe(true);
    }
  });

  it('rejects an invalid artifact cap', () => {
    const previous = process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'];
    try {
      process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'] = '0';
      expect(() => ardentArtifactMaxBytes()).toThrow();
      delete process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'];
      expect(ardentArtifactMaxBytes()).toBe(64 * 1024 * 1024);
    } finally {
      if (previous === undefined) delete process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES']; else process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'] = previous;
    }
  });
});

describe('profile HiveMem credential', () => {
  it('sets the token key atomically and keeps every other line private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'magnus-ardent-credential-'));
    dirs.push(dir);
    const { readFile, stat, readdir } = await import('node:fs/promises');
    await writeFile(join(dir, '.env'), 'ARDENT_API_TOKEN=private-fixture-token\nARDENT_HIVEMEM_TOKEN=old.fixture.token\n', { mode: 0o600 });
    await writeProfileCredential(dir, 'ARDENT_HIVEMEM_TOKEN', 'new.fixture.token');
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('ARDENT_API_TOKEN=private-fixture-token\nARDENT_HIVEMEM_TOKEN=new.fixture.token\n');
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['.env']);
    await expect(writeProfileCredential(dir, 'ARDENT_HIVEMEM_TOKEN', 'not a token\nINJECTED=1')).rejects.toThrow();
    const { chmod } = await import('node:fs/promises');
    await chmod(join(dir, '.env'), 0o644);
    await expect(writeProfileCredential(dir, 'ARDENT_HIVEMEM_TOKEN', 'new.fixture.token')).rejects.toThrow(/invalid/);
  });

  it('accepts the credential action only with a token and only as root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'magnus-ardent-credential-route-'));
    dirs.push(home);
    const routes = createArdentRoutes(async () => ({ owner: 'fixture', home, root: join(home, '.ardent'), install: join(home, 'install') }));
    const send = (body: unknown) => routes.request('/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const refused = await send({ profile: 'example', action: 'hivemem-credential-set', body: { token: 'a.b.c' } });
    expect(refused.status).toBe(503);
    expect(JSON.stringify(await refused.json())).not.toContain('a.b.c');
    expect((await send({ profile: 'example', action: 'hivemem-credential-set', target: 'x', body: { token: 'a.b.c' } })).status).toBe(400);
  });
});
