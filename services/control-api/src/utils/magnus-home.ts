import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Base directory for server-owned local data (backups, audit logs, state).
 * Defaults to `~/.magnus`; override with `MAGNUS_HOME`.
 */
export function magnusHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['MAGNUS_HOME']?.trim();
  return configured ? resolve(configured) : join(homedir(), '.magnus');
}

/** Resolve a path below {@link magnusHome}. */
export function magnusHomePath(...segments: string[]): string {
  return join(magnusHome(), ...segments);
}
