import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let agentRoot: string;
let routes: typeof import('./file-sync-executor.js');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-sync-'));
  agentRoot = join(dir, 'agent');
  await mkdir(agentRoot);
  await writeFile(join(agentRoot, '.env'), 'RESULT_SIGNING_SECRET=fixture\n');
  await writeFile(join(dir, 'public.txt'), 'hello');
  await symlink(join(agentRoot, '.env'), join(dir, 'link-to-env'));
  await symlink('/proc/self/environ', join(dir, 'link-to-proc'));
  process.env['AGENT_INSTALL_DIR'] = agentRoot;
  routes = await import('./file-sync-executor.js');
});
afterAll(async () => {
  delete process.env['AGENT_INSTALL_DIR'];
  await rm(dir, { recursive: true, force: true });
});

const read = (path: string) => routes.fileRoutes.request(`/read?filePath=${encodeURIComponent(path)}`);

describe('file routes', () => {
  it('reads ordinary files', async () => {
    const response = await read(join(dir, 'public.txt'));
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { content: string } }).data.content).toBe('hello');
  });

  it('denies agent state directly and through symlinks', async () => {
    for (const path of [join(agentRoot, '.env'), join(dir, 'link-to-env'), join(dir, 'link-to-proc'), '/proc/self/environ'])
      expect((await read(path)).status).toBe(403);
  });

  it('blocks only whole path segments', async () => {
    expect((await read('/devices-not-dev')).status).not.toBe(403);
  });

  it('refuses writes into agent state', async () => {
    const response = await routes.fileRoutes.request('/write', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: join(dir, 'link-to-env'), content: 'x' }) });
    expect(response.status).toBe(403);
  });
});
