import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { magnusHome } from './magnus-home.js';

/**
 * `run/server-runtime.json` tells upgrade tooling which version is actually
 * serving (the public health endpoints deliberately omit the version).
 */
export function runtimeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env['MAGNUS_RUNTIME_FILE']?.trim() || join(magnusHome(env), 'run', 'server-runtime.json');
}

export function writeRuntimeFile(details: { version: string; port: number }, env: NodeJS.ProcessEnv = process.env): void {
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
