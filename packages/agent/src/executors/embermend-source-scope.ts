import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { z } from 'zod';

const selector = z.string().min(1).max(4096).refine(value => {
  if (value === '.') return true;
  const path = value.replace(/\/$/, '');
  return !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && posix.normalize(path) === path && !path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git');
}, 'Canonical repository scope required');
const selectors = z.array(selector).max(1000);
const matches = (path: string, selected: string): boolean => selected === '.' || path === selected.replace(/\/$/, '') || path.startsWith(selected.replace(/\/$/, '') + '/');

/** Remove unadmitted source before any repository-controlled process can run. */
export async function projectRepositoryScope(workspace: string, raw: unknown, mode: 'scan' | 'prepare' | 'source'): Promise<void> {
  const scope = mode === 'source'
    ? z.object({ paths: selectors.min(1) }).parse(raw)
    : z.object({ includedPaths: selectors.min(1), excludedPaths: selectors }).parse(raw);
  const included = 'paths' in scope ? scope.paths : scope.includedPaths;
  const excluded = 'paths' in scope ? [] : scope.excludedPaths;
  let members = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++members > 100000) throw new Error('Repository member budget exceeded');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      const admitted = included.some(item => matches(path, item));
      const ancestor = included.some(item => item.replace(/\/$/, '').startsWith(path + '/'));
      if (entry.name === '.git' || info.isSymbolicLink() || excluded.some(item => matches(path, item)) || !admitted && !(info.isDirectory() && ancestor)) {
        await rm(absolute, { recursive: true, force: true });
      } else if (info.isDirectory()) {
        await chmod(absolute, 0o755); await visit(absolute, path);
      } else if (info.isFile() && info.nlink === 1) {
        await chmod(absolute, 0o644 | (info.mode & 0o111));
      } else throw new Error('Unsupported repository filesystem member');
    }
  };
  await visit(workspace, ''); await chmod(workspace, 0o755);
}
