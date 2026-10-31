#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'skills');
const entries = readdirSync(dir, { withFileTypes: true });
const items = [];

function yamlList(values) {
  return `[${values.map((value) => JSON.stringify(String(value))).join(', ')}]`;
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function skillMarkdown(manifest) {
  const name = String(manifest.name);
  const title = titleFromSlug(name);
  const description = String(manifest.description);
  const entryPoint = String(manifest.entryPoint);
  const tags = Array.isArray(manifest.tags) ? manifest.tags : [];
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  return `---
name: ${name}
description: ${JSON.stringify(description)}
version: ${manifest.version}
platforms: [linux]
metadata:
  hermes:
    category: magnus
    tags: ${yamlList(tags)}
    requires_toolsets: ["terminal"]
---
# ${title}

## When to Use
Use this skill when managing or auditing a Magnus-managed Linux node and the task matches this capability: ${description}

## Procedure
1. Inspect the local node context and confirm the task is appropriate for this skill.
2. Run \`${entryPoint}\` from this skill directory with \`--help\` first when the expected arguments are unclear.
3. Execute \`${entryPoint}\` with the requested options. Add \`-v\`, \`-vv\`, or \`-vvv\` only when more diagnostic detail is needed.
4. Summarize the findings, actions taken, and any follow-up risk for the operator.

## Requirements
Expected host commands: ${dependencies.length ? dependencies.map((item) => `\`${item}\``).join(', ') : 'none beyond the base system shell'}.

## Verification
Confirm the script exits successfully and that its summary output matches the requested node-management task.
`;
}

for (const e of entries) {
  if (!e.isDirectory()) continue;
  const mp = join(dir, e.name, 'manifest.json');
  try {
    statSync(mp);
  } catch {
    continue;
  }
  const m = JSON.parse(readFileSync(mp, 'utf-8'));
  const skillPath = join(dir, e.name, 'SKILL.md');
  const rendered = skillMarkdown(m);
  let existing = '';
  try {
    existing = readFileSync(skillPath, 'utf-8');
  } catch {}
  if (existing !== rendered) writeFileSync(skillPath, rendered);
  items.push({
    name: m.name,
    version: m.version,
    description: m.description,
    author: m.author,
    entryPoint: m.entryPoint,
    dependencies: m.dependencies ?? [],
    tags: m.tags ?? [],
    path: e.name,
  });
}

items.sort((a, b) => a.name.localeCompare(b.name));

const indexPath = join(dir, 'index.json');
const catalog = {
  schema: 'https://agentskills.io/schema/v1',
  count: items.length,
  skills: items,
};

let previous;
try {
  previous = JSON.parse(readFileSync(indexPath, 'utf8'));
} catch {}

const previousCatalog = previous
  ? { schema: previous.schema, count: previous.count, skills: previous.skills }
  : null;
const catalogUnchanged = JSON.stringify(previousCatalog) === JSON.stringify(catalog);
const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
const generatedAt = catalogUnchanged && typeof previous.generatedAt === 'string'
  ? previous.generatedAt
  : sourceDateEpoch
    ? new Date(Number(sourceDateEpoch) * 1_000).toISOString()
    : new Date().toISOString();
const out = { schema: catalog.schema, generatedAt, count: catalog.count, skills: catalog.skills };

writeFileSync(indexPath, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote skills/index.json and SKILL.md files for ${items.length} skills`);
