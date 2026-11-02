import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { magnusHome } from './magnus-home.js';

/**
 * `run/server-runtime.json` tells upgrade tooling which version is actually
 * serving (the public health endpoints deliberately omit the version).
 */
export function runtimeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env['MAGNUS_RUNTIME_FILE']?.trim() || join(magnusHome(env), 'run', 'server-runtime.json');
}

/** `host` is the bind address, so tooling probes the address the server listens on. */
export function writeRuntimeFile(details: { version: string; port: number; host?: string }, env: NodeJS.ProcessEnv = process.env): void {
  const path = runtimeFilePath(env);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...details, pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    console.warn(`[startup] could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The server this runtime file names, when its process is still alive on this host. */
export function runningServer(env: NodeJS.ProcessEnv = process.env): { pid: number; version: string } | null {
  const path = runtimeFilePath(env);
  if (!existsSync(path)) return null;
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; version?: unknown };
    const pid = Number(info.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null;
    }
    return { pid, version: String(info.version ?? 'unknown') };
  } catch {
    return null;
  }
}
