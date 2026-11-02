/**
 * A managed Magnus project on disk:
 *
 *   magnus-project.json          this state file
 *   package.json, package-lock.json   pins of the version that is serving
 *   config/magnus-server.env, config/magnus-ui.env   0600
 *   data/                        the server's MAGNUS_HOME
 *   versions/<X.Y.Z>/            one npm install per version
 *   current -> versions/<X.Y.Z>  what the services run
 *   backups/                     pre-migration database dumps
 *   run/upgrade.lock, run/server-runtime.json
 *   units/                       generated systemd units (or compose.yml)
 */
import { randomBytes } from 'node:crypto';
import {
  chownSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const PROJECT_FILE = 'magnus-project.json';

export type Supervisor = 'systemd' | 'none';
export type Component = 'server' | 'ui';

export interface HistoryEntry {
  action: 'init' | 'adopt' | 'upgrade' | 'rollback' | 'restore';
  from: string | null;
  to: string;
  at: string;
  result: 'ok' | 'reverted' | 'failed';
  /** Migrations applied by this step; a rollback across them needs the dump. */
  migrations: string[];
  backup?: string;
  restoreCommand?: string;
  reason?: string;
  /** The subset of `migrations` that only a database restore undoes. */
  oneWay?: string[];
}

/**
 * Written before an upgrade touches the database and cleared when it ends, so
 * an upgrade that was killed midway is noticed by the next command.
 */
export interface UpgradeJournal {
  phase: 'backup' | 'migrate' | 'check' | 'switch' | 'restart' | 'health' | 'revert';
  from: string;
  to: string;
  backup?: string;
  migrations: string[];
  oneWay: string[];
  startedAt: string;
  pid: number;
}

export type DatabaseConfig =
  | { kind: 'external' }
  | { kind: 'compose'; composeFile: string; service: string; user: string; database: string };

export interface ProjectState {
  schema: 1;
  createdAt: string;
  supervisor: Supervisor;
  /** systemd: system units (root) or user units (systemctl --user). */
  scope: 'system' | 'user';
  components: Component[];
  units: Record<Component, string>;
  envFiles: Record<Component, string>;
  database: DatabaseConfig;
  ports: Record<Component, number>;
  current: string | null;
  previous: string | null;
  keepVersions: number;
  /** Dumps kept in backups/ (default 5); the newest of each label always stays. */
  keepBackups?: number;
  /** Node.js the units run (and the upgrade uses for npm and the server CLI); default: the units' ExecStart. */
  nodePath?: string;
  /** docker compose project of the bundled PostgreSQL and Redis (projects before 1.1.3: magnus-deps). */
  composeProject?: string;
  inProgress?: UpgradeJournal;
  history: HistoryEntry[];
}

export const DEFAULT_KEEP_BACKUPS = 5;

export class Project {
  constructor(readonly dir: string, public state: ProjectState) {}

  static file(dir: string): string {
    return join(dir, PROJECT_FILE);
  }

  static exists(dir: string): boolean {
    return existsSync(Project.file(dir));
  }

  static load(dir: string): Project {
    const path = Project.file(dir);
    if (!existsSync(path)) throw new Error(`No Magnus project at ${dir} (missing ${PROJECT_FILE}). Create one with \`magnus init\` or \`magnus adopt\`.`);
    let state: ProjectState;
    try {
      state = JSON.parse(readFileSync(path, 'utf8')) as ProjectState;
    } catch (error) {
      throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). `
        + `${existsSync(`${path}.bak`) ? `The previous state is in ${path}.bak: check it and copy it over.` : 'Repair the file by hand.'}`);
    }
    if (state.schema !== 1) throw new Error(`${path} has schema ${String(state.schema)}; this version of magnus understands schema 1. Upgrade with \`npx @hivemagnus/magnus@latest\`.`);
    return new Project(resolve(dir), state);
  }

  save(): void {
    const file = Project.file(this.dir);
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    writeAtomic(file, `${JSON.stringify(this.state, null, 2)}\n`, 0o644);
  }

  /** Node.js binary the services run. */
  nodePath(): string {
    if (this.state.nodePath) return this.state.nodePath;
    try {
      const unit = readFileSync(this.path('units', `${this.state.units.server}.service`), 'utf8');
      const exec = /^ExecStart=(\S+)/m.exec(unit)?.[1];
      if (exec) return exec;
    } catch { /* no generated unit */ }
    return process.execPath;
  }

  composeProject(): string {
    return this.state.composeProject ?? 'magnus-deps';
  }

  keepBackups(): number {
    return this.state.keepBackups ?? DEFAULT_KEEP_BACKUPS;
  }

  path(...segments: string[]): string {
    return join(this.dir, ...segments);
  }

  envFile(component: Component): string {
    const file = this.state.envFiles[component];
    return isAbsolute(file) ? file : this.path(file);
  }

  versionDir(version: string): string {
    return this.path('versions', version);
  }

  bin(version: string | 'current', name: 'magnus-server' | 'magnus-ui' | 'magnus'): string {
    const root = version === 'current' ? this.path('current') : this.versionDir(version);
    const entry = {
      'magnus-server': ['@hivemagnus', 'magnus-server', 'dist', 'cli.js'],
      'magnus-ui': ['@hivemagnus', 'magnus-ui', 'bin', 'magnus-ui.mjs'],
      magnus: ['@hivemagnus', 'magnus', 'dist', 'cli.js'],
    }[name];
    return join(root, 'node_modules', ...entry);
  }

  /** Version `current` points at, read from the link itself. */
  linkedVersion(): string | null {
    try {
      return readlinkSync(this.path('current')).split(/[\\/]/).pop() ?? null;
    } catch {
      return null;
    }
  }

  /** Atomically repoint `current` (symlink to a temp name, then rename over). */
  switchCurrent(version: string): void {
    if (!existsSync(this.versionDir(version))) throw new Error(`versions/${version} is not installed`);
    const temporary = this.path(`current.${process.pid}.tmp`);
    rmSync(temporary, { force: true });
    symlinkSync(join('versions', version), temporary, 'dir');
    renameSync(temporary, this.path('current'));
  }

  record(entry: HistoryEntry): void {
    this.state.history.push(entry);
    if (this.state.history.length > 50) this.state.history.splice(0, this.state.history.length - 50);
  }
}

function fsyncPath(path: string, flags: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, flags);
    fsyncSync(fd);
  } catch { /* directories cannot be opened for fsync on every platform */ } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Write a temp file, fsync it, rename it over `path` and fsync the directory,
 * so a crash leaves either the old or the new content, never a torn file.
 */
export function writeAtomic(path: string, content: string, mode: number, owner?: { uid: number; gid: number }): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (owner) {
    try {
      // Only root can give a file away; elsewhere the owner already matches.
      if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
        chownSync(temporary, owner.uid, owner.gid);
      }
    } catch { /* keep the writer as owner */ }
  }
  renameSync(temporary, path);
  fsyncPath(dirname(path), 'r');
}

/** What a lock file records about its holder. */
export interface LockInfo {
  pid: number;
  /** Linux boot id: a pid from an earlier boot is meaningless. */
  bootId: string;
  /** Start time of the holder (clock ticks since boot), so a reused pid is not mistaken for it. */
  startTime: string;
  /** Shared with a handed-over child so it can take the lock without a gap. */
  token: string;
  command: string;
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

export function bootId(): string {
  return readOptional('/proc/sys/kernel/random/boot_id');
}

/** Field 22 of /proc/<pid>/stat; '' where /proc is unavailable. */
export function processStartTime(pid: number): string {
  const stat = readOptional(`/proc/${pid}/stat`);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19] ?? '';
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A lock file is the holder's pid on the first line (all older engines read
 * only that), then the JSON details.
 */
export function parseLock(content: string): LockInfo | null {
  const [first = '', ...rest] = content.trim().split('\n');
  if (!/^\d+$/.test(first.trim())) return null;
  const pid = Number(first.trim());
  try {
    const info = JSON.parse(rest.join('\n') || '{}') as Partial<LockInfo>;
    return { pid, bootId: info.bootId ?? '', startTime: info.startTime ?? '', token: info.token ?? '', command: info.command ?? '' };
  } catch {
    return { pid, bootId: '', startTime: '', token: '', command: '' };
  }
}

/** Whether the process a lock names is still the one that took it. */
export function lockHolderAlive(info: LockInfo): boolean {
  if (info.bootId && bootId() && info.bootId !== bootId()) return false;
  if (!processAlive(info.pid)) return false;
  if (info.startTime && processStartTime(info.pid) && processStartTime(info.pid) !== info.startTime) return false;
  return true;
}

export interface LockOptions {
  /** Take over a lock whose token matches (the engine that handed over to this one). */
  inheritToken?: string;
  /** Remove any existing lock first (`--break-lock`). */
  breakLock?: boolean;
  command?: string;
}

export type Lock = (() => void) & { token: string; path: string };

function lockContent(token: string, command: string): string {
  const info: Omit<LockInfo, 'pid'> = { bootId: bootId(), startTime: processStartTime(process.pid), token, command };
  return `${process.pid}\n${JSON.stringify(info)}\n`;
}

/**
 * Exclusive lock file. A lock whose holder is gone (dead pid, other boot,
 * reused pid) is taken over; concurrent takeovers are safe because the stale
 * file is first renamed to a private name and checked before it is removed.
 */
export function acquireLock(path: string, options: LockOptions = {}): Lock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString('hex');
  const command = options.command ?? 'magnus';
  const make = (): Lock => {
    const release = (() => {
      // Never remove a lock another process (a handed-over child) has taken since.
      if (parseLock(readOptional(path))?.token === token) rmSync(path, { force: true });
    }) as Lock;
    release.token = token;
    release.path = path;
    return release;
  };
  if (options.breakLock) rmSync(path, { force: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, lockContent(token, command));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return make();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const content = readOptional(path);
    const holder = parseLock(content);
    if (holder && options.inheritToken && holder.token === options.inheritToken) {
      writeAtomic(path, lockContent(token, command), 0o600);
      return make();
    }
    if (holder && lockHolderAlive(holder)) {
      throw new Error(`Another magnus command (pid ${holder.pid}${holder.command ? `, ${holder.command}` : ''}) holds the lock ${path}. `
        + 'Wait for it to finish. If that process is not a magnus command, re-run with --break-lock.');
    }
    // Stale: move it to a private name, then make sure it is the file we judged.
    const grabbed = join(dirname(path), `.${basename(path)}.${process.pid}.${token.slice(0, 8)}.stale`);
    try {
      renameSync(path, grabbed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (readOptional(grabbed) !== content) {
      // Another process replaced the stale lock with a live one first: put it back.
      try { linkSync(grabbed, path); } catch { /* a third lock exists; it wins */ }
    }
    rmSync(grabbed, { force: true });
  }
  throw new Error(`Could not take the lock ${path}; another magnus command keeps taking it.`);
}

/** Owner of a path (uid), or null. */
export function ownerOf(path: string): number | null {
  try {
    return statSync(path).uid;
  } catch {
    return null;
  }
}

/** Walk up from `start` looking for magnus-project.json. */
export function findProjectDir(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (Project.exists(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
