#!/usr/bin/env node
/** Repository-only documentation checks; no generated application build needed. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function checkRepositoryDocs(root, files) {
  const failures = [];
  const maps = ['README.md', 'AGENTS.md', 'docs/APP_ARCHITECTURE.md'];
  let packages = 0;
  for (const scope of ['apps', 'services', 'packages']) {
    const directory = resolve(root, scope);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${scope}/${entry.name}`;
      if (!existsSync(resolve(root, path, 'package.json'))) continue;
      packages++;
      for (const guide of ['AGENTS.md', 'README.md']) {
        if (!existsSync(resolve(root, path, guide))) failures.push(`${path} is missing ${guide}`);
      }
      for (const map of maps) {
        const file = resolve(root, map);
        const tableRows = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
        if (!tableRows.some(row => row.startsWith(`| \`${path}\` |`))) failures.push(`${map} is missing package ${path}`);
      }
    }
  }
  let links = 0;
  for (const file of files.filter(file => file.endsWith('.md'))) {
    const source = resolve(root, file);
    if (!existsSync(source)) continue; // A staged deletion still appears in ls-files.
    const lines = readFileSync(source, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      for (const match of lines[index].matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const target = match[1].replace(/^<|>$/g, '');
        if (/^[a-zA-Z][\w+.-]*:/.test(target) || target.startsWith('#') || target.startsWith('/') || target.includes('{')) continue;
        let path;
        try { path = decodeURIComponent(target.split('#')[0].split('?')[0]); }
        catch { failures.push(`${file}:${index + 1}: malformed local link`); continue; }
        if (!path) continue;
        links++;
        if (!existsSync(resolve(dirname(source), path))) failures.push(`${file}:${index + 1}: missing local link target ${path}`);
      }
    }
  }
  return { failures, packages, links };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..');
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\0').filter(Boolean);
  const result = checkRepositoryDocs(root, files);
  if (result.failures.length) {
    for (const failure of result.failures) console.error(failure);
    process.exitCode = 1;
  } else {
    console.log(`Repository documentation check passed (${result.packages} packages, ${result.links} local links).`);
  }
}
