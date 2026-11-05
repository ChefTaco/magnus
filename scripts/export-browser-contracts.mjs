#!/usr/bin/env node
// Export the public browser contract as immutable committed blobs with per-file
// SHA-256 provenance, for a static console to copy and pin. Working-tree edits,
// local state and server source are never exported.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BROWSER_CONTRACT_FILES = ['browser.ts'];

export function exportBrowserContracts(root, output) {
  const git = (args) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: root });
  const revision = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  const files = BROWSER_CONTRACT_FILES.map((path) => {
    const source = `packages/contracts/src/${path}`;
    const bytes = git(['show', `${revision}:${source}`]);
    for (const match of bytes.toString('utf8').matchAll(/from\s+['"]([^'"]+)['"]/gu)) {
      const sibling = BROWSER_CONTRACT_FILES.some((name) => `./${name.replace(/\.ts$/u, '.js')}` === match[1]);
      if (match[1] !== 'zod' && !sibling) throw new Error(`Browser contract imports server implementation: ${match[1]}`);
    }
    return { path, source, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  // Refuses an existing directory or file, so an earlier export is never overwritten.
  mkdirSync(output, { mode: 0o700 });
  for (const file of files) writeFileSync(join(output, file.path), file.bytes, { flag: 'wx', mode: 0o600 });
  const manifest = {
    schema: 1,
    product: 'magnus-browser',
    version: 1,
    repository: 'https://github.com/ChefTaco/magnus',
    revision,
    files: files.map(({ path, source, sha256 }) => ({ path, source, sha256 })),
  };
  writeFileSync(join(output, 'provenance.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--output');
  if (index < 0 || !process.argv[index + 1]) throw new Error('--output NEW_DIRECTORY required');
  const manifest = exportBrowserContracts(fileURLToPath(new URL('../', import.meta.url)), resolve(process.argv[index + 1]));
  console.log(`Exported browser contract at ${manifest.revision}`);
}
