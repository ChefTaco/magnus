import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdtemp, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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

  it('never serves, lists into or overwrites the node identity key', async () => {
    await mkdir(join(agentRoot, 'identity'));
    await writeFile(join(agentRoot, 'identity/node.key'), 'fixture-key-material', { mode: 0o600 });
    await symlink(join(agentRoot, 'identity/node.key'), join(dir, 'link-to-key'));
    for (const path of [join(agentRoot, 'identity/node.key'), join(agentRoot, 'identity'), join(dir, 'link-to-key')]) {
      const response = await read(path);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('fixture-key-material');
    }
    const write = await routes.fileRoutes.request('/write', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: join(agentRoot, 'identity/node.key'), content: 'x' }) });
    expect(write.status).toBe(403);
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

const write = (body: object) => routes.fileRoutes.request('/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('atomic file writes', () => {
  it('replaces the file by rename, keeps its mode and leaves no temporary file', async () => {
    const target = join(dir, 'atomic', 'app.conf');
    await mkdir(join(dir, 'atomic'));
    await writeFile(target, 'old');
    await chmod(target, 0o644);
    const before = await stat(target);
    const response = await write({ filePath: target, content: 'new' });
    expect(response.status).toBe(200);
    expect(await readFile(target, 'utf8')).toBe('new');
    const after = await stat(target);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o7777).toBe(0o644);
    expect(await readdir(join(dir, 'atomic'))).toEqual(['app.conf']);
  });

  it('creates new files 0600 unless a mode is given, regardless of the umask', async () => {
    const plain = join(dir, 'created', 'plain.txt'); const shared = join(dir, 'created', 'shared.txt');
    expect((await write({ filePath: plain, content: 'a' })).status).toBe(200);
    expect((await stat(plain)).mode & 0o7777).toBe(0o600);
    const previous = process.umask(0o077);
    try { expect((await write({ filePath: shared, content: 'b', mode: '0644' })).status).toBe(200); } finally { process.umask(previous); }
    expect((await stat(shared)).mode & 0o7777).toBe(0o644);
    expect((await write({ filePath: shared, content: 'c', mode: '999' })).status).toBe(400);
  });

  it('writes through a link to an allowed file without replacing the link', async () => {
    const real = join(dir, 'linked-real.txt'); const link = join(dir, 'linked.txt');
    await writeFile(real, 'old'); await symlink(real, link);
    expect((await write({ filePath: link, content: 'via link' })).status).toBe(200);
    expect(await readlink(link)).toBe(real);
    expect(await readFile(real, 'utf8')).toBe('via link');
  });

  it('refuses when the target is not a regular file', async () => {
    const directory = join(dir, 'a-directory'); await mkdir(directory);
    expect((await write({ filePath: directory, content: 'x' })).status).toBe(409);
    expect((await lstat(directory)).isDirectory()).toBe(true);
  });

  it('requires privileged root mode to set an owner or group', async () => {
    const response = await write({ filePath: join(dir, 'owned.txt'), content: 'x', owner: 'operator' });
    if (process.geteuid?.() !== 0) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'AGENT_NOT_PRIVILEGED', feature: 'file-ownership' } });
    }
  });
});

describe('file reads open before judging the file', () => {
  it('refuses a FIFO without blocking and reports non-files as 400', async () => {
    const fifo = join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect((await read(fifo)).status).toBe(400);
    expect((await read(dir)).status).toBe(400);
  });
});

describe('MAGNUS_AGENT_FILE_ROOTS', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('limits reads and writes to the listed directories, symlinks resolved', async () => {
    const allowed = join(dir, 'allowed'); await mkdir(allowed);
    await writeFile(join(allowed, 'ok.txt'), 'ok');
    await symlink(join(dir, 'public.txt'), join(allowed, 'escape'));
    vi.stubEnv('MAGNUS_AGENT_FILE_ROOTS', ` ${allowed} ,/nonexistent-root`);
    expect((await read(join(allowed, 'ok.txt'))).status).toBe(200);
    expect((await read(join(dir, 'public.txt'))).status).toBe(403);
    expect((await read(join(allowed, 'escape'))).status).toBe(403);
    expect((await read(join(allowed, '..', 'public.txt'))).status).toBe(403);
    expect((await write({ filePath: join(allowed, 'new.txt'), content: 'x' })).status).toBe(200);
    expect((await write({ filePath: join(dir, 'outside.txt'), content: 'x' })).status).toBe(403);
  });

  it('admits the target of a root that is itself a symlink', async () => {
    const realRoot = join(dir, 'real-root'); await mkdir(realRoot); await writeFile(join(realRoot, 'f.txt'), 'f');
    await symlink(realRoot, join(dir, 'root-link'));
    vi.stubEnv('MAGNUS_AGENT_FILE_ROOTS', join(dir, 'root-link'));
    expect((await read(join(dir, 'root-link', 'f.txt'))).status).toBe(200);
  });

  it('fails closed on an invalid value and reports it as a configuration error', async () => {
    const { fileRoots } = await import('./file-roots.js');
    expect(fileRoots({ MAGNUS_AGENT_FILE_ROOTS: 'relative/dir' }).errors).toHaveLength(1);
    expect(fileRoots({ MAGNUS_AGENT_FILE_ROOTS: '/' }).errors).toHaveLength(1);
    expect(fileRoots({ MAGNUS_AGENT_FILE_ROOTS: ' , ' }).errors).toHaveLength(1);
    expect(fileRoots({}).roots).toBeNull();
    vi.stubEnv('MAGNUS_AGENT_FILE_ROOTS', 'relative/dir');
    expect((await read(join(dir, 'public.txt'))).status).toBe(403);
  });
});
