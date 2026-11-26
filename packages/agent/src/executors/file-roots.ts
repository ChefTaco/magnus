import { isAbsolute, resolve } from 'node:path';

/**
 * Optional allowlist (`MAGNUS_AGENT_FILE_ROOTS`, comma-separated absolute
 * directories). When set, the file API reaches only paths below one of them,
 * as written and as resolved through symlinks; the denylist still applies.
 */
export function fileRoots(env: NodeJS.ProcessEnv = process.env): { roots: string[] | null; errors: string[] } {
  const raw = env['MAGNUS_AGENT_FILE_ROOTS']?.trim();
  if (!raw) return { roots: null, errors: [] };
  const errors: string[] = []; const roots: string[] = [];
  for (const entry of raw.split(',').map(value => value.trim()).filter(Boolean)) {
    if (!isAbsolute(entry) || entry.includes('\0')) errors.push(`MAGNUS_AGENT_FILE_ROOTS entry ${JSON.stringify(entry)} must be an absolute path`);
    else if (resolve(entry) === '/') errors.push('MAGNUS_AGENT_FILE_ROOTS cannot contain /; leave it unset to allow every path');
    else roots.push(resolve(entry));
  }
  if (!roots.length && !errors.length) errors.push('MAGNUS_AGENT_FILE_ROOTS names no directory');
  return { roots, errors };
}
