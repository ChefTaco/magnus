import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function rootControlled(path: string): Promise<void> {
  if (!path.startsWith('/') || await realpath(path) !== path) throw new Error('Root-controlled canonical path required');
  for (let cursor = path;; cursor = dirname(cursor)) {
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022) throw new Error('Root-controlled non-writable path required');
    if (cursor === '/') break;
  }
}
