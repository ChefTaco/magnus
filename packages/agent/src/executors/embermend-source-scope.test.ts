import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { projectRepositoryScope } from './embermend-source-scope.js';

describe('repository execution source boundary', () => {
  it('removes sibling applications, excluded files, Git objects and symlinks before validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-scope-'));
    try {
      for (const dir of ['apps/catalog/private', 'apps/notes', '.git/objects', 'test']) await mkdir(join(root, dir), { recursive: true });
      for (const file of ['apps/catalog/main.ts', 'apps/catalog/private/key.ts', 'apps/notes/private.ts', '.git/objects/history', 'test/security.mjs', 'package.json']) await writeFile(join(root, file), file);
      await symlink('../../notes', join(root, 'apps/catalog/sibling'));
      await projectRepositoryScope(root, { includedPaths: ['apps/catalog', 'test/security.mjs'], excludedPaths: ['apps/catalog/private'] }, 'prepare');
      expect(await readFile(join(root, 'apps/catalog/main.ts'), 'utf8')).toBe('apps/catalog/main.ts');
      expect(await readFile(join(root, 'test/security.mjs'), 'utf8')).toBe('test/security.mjs');
      for (const file of ['apps/notes', 'apps/catalog/private', 'apps/catalog/sibling', '.git', 'package.json']) await expect(access(join(root, file))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('limits reads to exact requested paths and rejects traversal or hardlinked input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-scope-'));
    try {
      await mkdir(join(root, 'app')); await writeFile(join(root, 'app/read.ts'), 'allowed'); await writeFile(join(root, 'app/other.ts'), 'excluded');
      await expect(projectRepositoryScope(root, { paths: ['../app'] }, 'source')).rejects.toThrow();
      await projectRepositoryScope(root, { paths: ['app/read.ts'] }, 'source');
      await expect(access(join(root, 'app/other.ts'))).rejects.toThrow();
      await link(join(root, 'app/read.ts'), join(root, 'app/alias.ts'));
      await expect(projectRepositoryScope(root, { includedPaths: ['.'], excludedPaths: [] }, 'scan')).rejects.toThrow(/Unsupported/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
