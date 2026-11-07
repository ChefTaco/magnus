#!/usr/bin/env node
// Checks that package-lock.json agrees with every workspace manifest and that each resolved
// registry artifact carries an integrity hash. Usage: node scripts/validate-lockfile.mjs
import { readFileSync } from 'node:fs';

const root = process.cwd();
const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8'));
const workspacePaths = ['apps/dashboard', 'services/control-api', 'services/fleet-gateway', 'packages/agent', 'packages/contracts', 'packages/oathweave', 'packages/skills'];
const failures = [];

for (const workspacePath of workspacePaths) {
  const manifest = JSON.parse(readFileSync(`${root}/${workspacePath}/package.json`, 'utf8'));
  const entry = lock.packages?.[workspacePath];
  if (!entry) failures.push(`${workspacePath}: missing package-lock workspace entry`);
  else if (entry.name !== manifest.name || entry.version !== manifest.version) {
    failures.push(`${workspacePath}: manifest ${manifest.name}@${manifest.version} disagrees with lock ${entry.name ?? 'unknown'}@${entry.version ?? 'unknown'}`);
  }
}

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!entry?.resolved || entry.link) continue;
  const match = /\/([^/]+)-(\d+\.\d+\.\d+(?:[-+][^/]*)?)\.tgz(?:\?.*)?$/.exec(entry.resolved);
  if (match && match[2] !== entry.version) failures.push(`${path}: lock version ${entry.version} disagrees with resolved artifact ${match[1]}-${match[2]}.tgz`);
  if (!entry.integrity) failures.push(`${path}: resolved artifact is missing an integrity hash`);
  if (!entry.resolved.startsWith('https://registry.npmjs.org/')) failures.push(`${path}: resolved from ${new URL(entry.resolved).origin}, expected the public npm registry`);
}

// This lock travels inside the integrity-pinned agent tarball and is used by Hive's
// privileged npm ci. Reject workspace links and missing integrity, including in nested deps.
const agentManifest = JSON.parse(readFileSync(`${root}/packages/agent/package.json`, 'utf8'));
const agentLock = JSON.parse(readFileSync(`${root}/packages/agent/npm-shrinkwrap.json`, 'utf8'));
if (agentLock.lockfileVersion !== 3 || agentLock.name !== agentManifest.name || agentLock.version !== agentManifest.version || agentLock.packages?.['']?.name !== agentManifest.name || agentLock.packages?.['']?.version !== agentManifest.version ||
    JSON.stringify(agentLock.packages?.['']?.dependencies) !== JSON.stringify(agentManifest.dependencies)) {
  failures.push('agent shrinkwrap differs from its manifest; regenerate and review the standalone dependency graph before release');
}
for (const [path, entry] of Object.entries(agentLock.packages ?? {})) {
  if (!path) continue;
  if (entry.link || !entry.version || !entry.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? '')) {
    failures.push(`agent shrinkwrap ${path}: registry artifact must have an exact version, public URL and sha512 integrity`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Lockfile check passed.');
