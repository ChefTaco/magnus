#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dashboardEnvironmentReferenceRows } from '../apps/dashboard/runtime-environment.mjs';

const readmePath = resolve(import.meta.dirname, '../apps/dashboard/README.md');
const rows = dashboardEnvironmentReferenceRows();
const table = [
  '<!-- dashboard-environment:start -->',
  '<!-- Generated from runtime-environment.mjs by scripts/check-documentation.mjs. -->',
  '| Variable | Requirement | Default | Purpose |',
  '| --- | --- | --- | --- |',
  ...rows.map((row) => {
    const requirement = row.requirement ?? (row.required ? 'Required' : 'Optional');
    const defaultValue = row.sensitive ? 'None' : row.default == null ? 'None' : `\`${String(row.default)}\``;
    return `| \`${row.name}\` | ${requirement} | ${defaultValue} | ${row.purpose} |`;
  }),
  '<!-- dashboard-environment:end -->',
].join('\n');

const content = readFileSync(readmePath, 'utf8');
const pattern = /<!-- dashboard-environment:start -->[\s\S]*?<!-- dashboard-environment:end -->/;
if (!pattern.test(content)) throw new Error('Dashboard README is missing dashboard environment generation markers');
writeFileSync(readmePath, content.replace(pattern, table));
console.log(`Generated ${rows.length} dashboard environment reference rows.`);
