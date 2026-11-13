/**
 * A root agent must not execute a program that another account can replace,
 * or run a program against a home that another account controls (plugins and
 * configuration there are code): that account would then run code as root.
 * `ownerExecution` decides which account such a program runs as. An agent that
 * is not root runs everything as itself, unchanged.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PathController =
  | { kind: 'root' }
  | { kind: 'account'; uid: number }
  | { kind: 'unsafe'; path: string };

export interface OwnerAccount { name: string; uid: number; gid: number; home: string }

export type OwnerExecution =
  | { ok: true; command: string; uid?: number; gid?: number; cwd?: string; env: Record<string, string> }
  | { ok: false; code: 126 | 127; reason: string };

interface PathInfo { uid: number; mode: number; isSymbolicLink(): boolean; isDirectory(): boolean }

export interface OwnerExecutionDeps {
  /** The agent's effective uid. */
  euid: number;
  lstat(path: string): Promise<PathInfo>;
  realpath(path: string): Promise<string>;
  account(uid: number): Promise<OwnerAccount | null>;
  pathEnv: string;
}

function ancestry(path: string): string[] {
  const chain: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    chain.unshift(current);
    if (dirname(current) === current) return chain;
  }
}

async function chainController(path: string, deps: Pick<OwnerExecutionDeps, 'lstat'>): Promise<PathController> {
  for (const component of ancestry(path)) {
    let info: PathInfo;
    try {
      info = await deps.lstat(component);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The rest of the path does not exist yet: whoever controls the last existing directory controls it.
      if (code === 'ENOENT' || code === 'ENOTDIR') break;
      return { kind: 'unsafe', path: component };
    }
    if (info.uid !== 0) return { kind: 'account', uid: info.uid };
    // A symlink's own mode says nothing. A sticky directory (such as /tmp) lets only an entry's owner replace it.
    const sticky = info.isDirectory() && (info.mode & 0o1000) !== 0;
    if (!info.isSymbolicLink() && (info.mode & 0o002) !== 0 && !sticky) return { kind: 'unsafe', path: component };
  }
  return { kind: 'root' };
}

/**
 * Who can replace `path`: the first account other than root that owns a
 * component of it, as written and as resolved through symlinks. Group write
 * access is not judged (Debian's /usr/local is group-writable by `staff`).
 */
export async function pathController(path: string, deps: Pick<OwnerExecutionDeps, 'lstat' | 'realpath'>): Promise<PathController> {
  const written = await chainController(path, deps);
  if (written.kind !== 'root') return written;
  let real: string;
  try { real = await deps.realpath(path); } catch { return written; }
  return real === resolve(path) ? written : chainController(real, deps);
}

async function passwdAccount(uid: number): Promise<OwnerAccount | null> {
  const parse = (text: string): OwnerAccount | null => {
    for (const line of text.split('\n')) {
      const fields = line.split(':');
      if (fields.length >= 6 && Number(fields[2]) === uid && /^[a-z_][a-z0-9_.-]*\$?$/i.test(fields[0]!) && fields[5]!.startsWith('/')) {
        const gid = Number(fields[3]);
        if (Number.isSafeInteger(gid) && gid >= 0) return { name: fields[0]!, uid, gid, home: fields[5]! };
      }
    }
    return null;
  };
  try {
    const local = parse(await readFile('/etc/passwd', 'utf8'));
    if (local) return local;
  } catch { /* minimal containers */ }
  try {
    return parse((await execFileAsync('/usr/bin/getent', ['passwd', String(uid)], { timeout: 5_000, env: { PATH: '/usr/bin:/bin' } })).stdout);
  } catch {
    return null;
  }
}

const realDeps = (): OwnerExecutionDeps => ({
  euid: process.geteuid?.() ?? -1,
  lstat,
  realpath,
  account: passwdAccount,
  pathEnv: process.env['PATH'] ?? '',
});

async function findOnPath(command: string, pathEnv: string): Promise<string | null> {
  for (const entry of pathEnv.split(delimiter)) {
    if (!entry.startsWith('/')) continue;
    const candidate = join(entry, command);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* next entry */ }
  }
  return null;
}

/**
 * How to run `command` (a path, or a name looked up on PATH) against `home`.
 * As root: unchanged when root alone controls both; as the controlling
 * account (uid, gid, its own HOME and session bus) when another account
 * controls either; refused when no single account can be named.
 */
export async function ownerExecution(command: string, options: { home?: string } = {}, overrides: Partial<OwnerExecutionDeps> = {}): Promise<OwnerExecution> {
  const deps = { ...realDeps(), ...overrides };
  if (deps.euid !== 0) return { ok: true, command, env: {} };
  const absolute = command.includes('/') ? resolve(command) : await findOnPath(command, deps.pathEnv);
  if (!absolute) return { ok: false, code: 127, reason: `${command} was not found on PATH` };
  try { await deps.lstat(absolute); } catch { return { ok: false, code: 127, reason: `${absolute} does not exist` }; }
  const controllers = [
    ...(options.home ? [await pathController(options.home, deps)] : []),
    await pathController(absolute, deps),
  ];
  const unsafe = controllers.find(controller => controller.kind === 'unsafe');
  if (unsafe?.kind === 'unsafe') return { ok: false, code: 126, reason: `${unsafe.path} can be replaced by any account; refusing to run ${absolute} as root` };
  const owner = controllers.find(controller => controller.kind === 'account');
  if (owner?.kind !== 'account') return { ok: true, command: absolute, env: {} };
  const account = await deps.account(owner.uid);
  if (!account) return { ok: false, code: 126, reason: `uid ${owner.uid} controls ${absolute} or its home but has no account; refusing to run it as root` };
  return {
    ok: true, command: absolute, uid: account.uid, gid: account.gid, cwd: account.home,
    env: {
      HOME: account.home, USER: account.name, LOGNAME: account.name,
      XDG_RUNTIME_DIR: `/run/user/${account.uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${account.uid}/bus`,
      PATH: `${account.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    },
  };
}
