import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createArdentRoutes, hermesTrafficConsumersDisabled, readArdentState, verifiedInstalledArdentPackage } from './ardent-manager.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
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
    const admission = await routes.request('/action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'example', action: 'task-submit', body: { prompt: 'Test', idempotency_key: '00000000-0000-4000-8000-000000000002' } }) });
    expect(admission.status).toBe(200);
    expect(await admission.json()).toEqual({ task_id: '00000000-0000-4000-8000-000000000001', state: 'queued' });
    expect(requests).toEqual(['/api/v1/profile', '/api/v1/profile', '/api/v1/status', '/api/v1/profile', `/api/v1/artifacts/${artifactId}`, '/api/v1/profile', '/api/v1/config/validate', '/api/v1/profile', '/api/v1/tasks']);
  });
});
