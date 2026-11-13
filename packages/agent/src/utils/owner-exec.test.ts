import { describe, expect, it } from 'vitest';
import { ownerExecution, pathController, type OwnerExecutionDeps } from './owner-exec.js';

type Entry = { uid: number; mode?: number; link?: string; directory?: boolean };

/** A fake filesystem: path -> owner, mode and optional symlink target. */
function fakes(entries: Record<string, Entry>, euid = 0): Partial<OwnerExecutionDeps> {
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  return {
    euid,
    pathEnv: '/usr/bin',
    lstat: async path => {
      const entry = entries[path];
      if (!entry) throw missing();
      return { uid: entry.uid, mode: entry.mode ?? 0o755, isSymbolicLink: () => entry.link !== undefined, isDirectory: () => entry.directory ?? false };
    },
    realpath: async path => {
      const entry = entries[path];
      if (!entry) throw missing();
      return entry.link ?? path;
    },
    account: async uid => (uid === 1000 ? { name: 'operator', uid: 1000, gid: 1000, home: '/home/operator' } : null),
  };
}

const system: Record<string, Entry> = {
  '/': { uid: 0, directory: true },
  '/usr': { uid: 0, directory: true },
  '/usr/local': { uid: 0, mode: 0o2775, directory: true },
  '/usr/local/bin': { uid: 0, mode: 0o2775, directory: true },
  '/usr/local/bin/hermes': { uid: 0 },
  '/root': { uid: 0, mode: 0o700, directory: true },
  '/home': { uid: 0, directory: true },
  '/home/operator': { uid: 1000, directory: true },
  '/home/operator/.local': { uid: 1000, directory: true },
  '/home/operator/.local/bin': { uid: 1000, directory: true },
  '/home/operator/.local/bin/hermes': { uid: 1000 },
  '/tmp': { uid: 0, mode: 0o1777, directory: true },
  '/srv': { uid: 0, mode: 0o777, directory: true },
  '/srv/hermes': { uid: 0 },
};

describe('owner execution', () => {
  it('leaves an agent that is not root unchanged', async () => {
    await expect(ownerExecution('hermes', { home: '/home/operator/.hermes' }, fakes(system, 1000)))
      .resolves.toEqual({ ok: true, command: 'hermes', env: {} });
  });

  it('runs a root-controlled program against a root-controlled home as root', async () => {
    await expect(ownerExecution('/usr/local/bin/hermes', { home: '/root/.hermes' }, fakes(system)))
      .resolves.toEqual({ ok: true, command: '/usr/local/bin/hermes', env: {} });
  });

  it('never runs a program inside another account\'s home as root', async () => {
    const execution = await ownerExecution('/home/operator/.local/bin/hermes', { home: '/home/operator/.hermes' }, fakes(system));
    expect(execution).toMatchObject({ ok: true, command: '/home/operator/.local/bin/hermes', uid: 1000, gid: 1000, cwd: '/home/operator' });
    expect(execution.ok && execution.env).toMatchObject({ HOME: '/home/operator', USER: 'operator', XDG_RUNTIME_DIR: '/run/user/1000' });
  });

  it('drops to the home\'s owner even when the program itself is root-controlled', async () => {
    await expect(ownerExecution('/usr/local/bin/hermes', { home: '/home/operator/.hermes' }, fakes(system)))
      .resolves.toMatchObject({ ok: true, uid: 1000, gid: 1000 });
  });

  it('follows a root-owned symlink into an account\'s home', async () => {
    const linked = { ...system, '/usr/local/bin/hermes': { uid: 0, link: '/home/operator/.local/bin/hermes' } };
    await expect(pathController('/usr/local/bin/hermes', fakes(linked) as OwnerExecutionDeps)).resolves.toEqual({ kind: 'account', uid: 1000 });
  });

  it('refuses a program any account can replace, and an owner without an account', async () => {
    await expect(ownerExecution('/srv/hermes', {}, fakes(system))).resolves.toMatchObject({ ok: false, code: 126 });
    const orphan = { ...system, '/home/operator': { uid: 4242, directory: true } };
    await expect(ownerExecution('/home/operator/.local/bin/hermes', {}, fakes(orphan))).resolves.toMatchObject({ ok: false, code: 126 });
  });

  it('reports a missing program as not found without starting anything', async () => {
    await expect(ownerExecution('/home/operator/bin/hermes', {}, fakes(system))).resolves.toMatchObject({ ok: false, code: 127 });
  });

  it('accepts a sticky world-writable parent and group-writable system directories', async () => {
    const owned = { ...system, '/tmp/hermes': { uid: 1000 } };
    await expect(pathController('/tmp/hermes', fakes(owned) as OwnerExecutionDeps)).resolves.toEqual({ kind: 'account', uid: 1000 });
    await expect(pathController('/usr/local/bin/hermes', fakes(system) as OwnerExecutionDeps)).resolves.toEqual({ kind: 'root' });
  });
});
