/**
 * A managed Magnus project on disk:
 *
 *   magnus-project.json          this state file
 *   package.json, package-lock.json   pins of the version that is serving
 *   config/magnus-server.env, config/magnus-ui.env   0600
 *   versions/<X.Y.Z>/            one npm install per version
 *   current -> versions/<X.Y.Z>  what the services run
 *   backups/                     pre-migration database dumps
 *   run/upgrade.lock, run/server-runtime.json
 *   units/                       generated systemd units (or compose.yml)
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const PROJECT_FILE = 'magnus-project.json';

export type Supervisor = 'systemd' | 'none';
export type Component = 'server' | 'ui';

export interface HistoryEntry {
  action: 'init' | 'adopt' | 'upgrade' | 'rollback';
  from: string | null;
  to: string;
  at: string;
  result: 'ok' | 'reverted' | 'failed';
  /** Migrations applied by this step; a rollback across them needs the dump. */
  migrations: string[];
  backup?: string;
  restoreCommand?: string;
  reason?: string;
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
  history: HistoryEntry[];
}

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
    const state = JSON.parse(readFileSync(path, 'utf8')) as ProjectState;
    if (state.schema !== 1) throw new Error(`${path} has schema ${String(state.schema)}; this version of magnus understands schema 1. Upgrade with \`npx @hivemagnus/magnus@latest\`.`);
    return new Project(resolve(dir), state);
  }

  save(): void {
    writeAtomic(Project.file(this.dir), `${JSON.stringify(this.state, null, 2)}\n`, 0o644);
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

export function writeAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Exclusive lock file; a lock left by a dead process is taken over. */
export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(readFileSync(path, 'utf8'), 10);
      if (Number.isInteger(holder) && processAlive(holder)) {
        throw new Error(`Another magnus command (pid ${holder}) holds ${path}. Wait for it to finish.`);
      }
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take ${path}`);
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
