#!/usr/bin/env node
// Move the pinned Hermes Agent bootstrap script used by POST /hermes/install.
//
//   node scripts/update-hermes-install-pin.mjs           # latest stable release
//   node scripts/update-hermes-install-pin.mjs v0.23.4   # a specific tag
//
// Resolves the tag to its commit (git ls-remote), downloads scripts/install.sh at
// that commit, hashes it and rewrites HERMES_INSTALL_PIN in
// src/executors/hermes-install-pin.ts. Review the upstream script diff before
// committing the new pin.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'NousResearch/hermes-agent';
const PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'executors', 'hermes-install-pin.ts');
const MAX_BYTES = 512 * 1024;

async function latestTag() {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'magnus-hermes-install-pin' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`release feed returned HTTP ${response.status}`);
  const release = await response.json();
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string') throw new Error('latest release is not a stable release');
  return release.tag_name;
}

function tagCommit(tag) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(tag)) throw new Error(`invalid tag: ${tag}`);
  const output = execFileSync('git', ['ls-remote', '--tags', `https://github.com/${REPOSITORY}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { encoding: 'utf8', timeout: 30_000 });
  const rows = output.trim().split('\n').filter(Boolean).map(row => row.split('\t'));
  const commit = rows.find(row => row[1] === `refs/tags/${tag}^{}`)?.[0] ?? rows.find(row => row[1] === `refs/tags/${tag}`)?.[0];
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error(`tag ${tag} was not found`);
  return commit;
}

async function scriptSha256(commit) {
  const response = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/scripts/install.sh`,
    { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`install.sh download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES || !bytes.toString('utf8').startsWith('#!/usr/bin/env bash')) throw new Error('install.sh does not look like the bootstrap script');
  return createHash('sha256').update(bytes).digest('hex');
}

const tag = process.argv[2] ?? await latestTag();
const commit = tagCommit(tag);
const sha256 = await scriptSha256(commit);
const source = readFileSync(PIN_FILE, 'utf8');
const block = /(\/\/ update-hermes-install-pin:start\n)[\s\S]*?(\/\/ update-hermes-install-pin:end)/;
if (!block.test(source)) throw new Error(`pin markers not found in ${PIN_FILE}`);
writeFileSync(PIN_FILE, source.replace(block, `$1export const HERMES_INSTALL_PIN = {
  tag: '${tag}',
  commit: '${commit}',
  scriptSha256: '${sha256}',
} as const;
$2`));
console.log(`Hermes install pin: ${tag} ${commit} sha256 ${sha256}`);
