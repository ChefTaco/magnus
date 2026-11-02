#!/usr/bin/env node
// UPGRADING.md shows the same remedies catalogue as the console and the CLI.
// The table between the markers is generated from packages/contracts/src/upgrade-remedies.ts.
//
//   node scripts/check-upgrade-remedies.mjs           check
//   node scripts/check-upgrade-remedies.mjs --write   regenerate the table
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPGRADE_REMEDIES } from '../packages/contracts/src/upgrade-remedies.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const START = '<!-- upgrade-remedies:start -->';
const END = '<!-- upgrade-remedies:end -->';

const cell = (text) => text.replaceAll('|', '\\|');

export function remediesTable(remedies = UPGRADE_REMEDIES) {
  const kind = (entry) => entry.class === 'release' ? (entry.stopsRun ? 'release, stops at once' : 'release')
    : entry.ambiguous ? 'node, ambiguous' : entry.transient ? 'node, tried again' : entry.informational ? 'expected' : 'node';
  return ['| Code | Kind | Cause | Remedy |', '|---|---|---|---|',
    ...Object.entries(remedies).map(([code, entry]) => `| \`${code}\` | ${kind(entry)} | ${cell(entry.cause)} | ${cell(entry.remedy)} |`)].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = join(root, 'UPGRADING.md');
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < 0) {
    console.error(`UPGRADING.md lacks the ${START} markers.`);
    process.exit(1);
  }
  const next = `${text.slice(0, start)}${START}\n${remediesTable()}\n${text.slice(end)}`;
  if (process.argv.includes('--write')) writeFileSync(path, next);
  else if (next !== text) {
    console.error('UPGRADING.md: the remedies table differs from the catalogue. Run: node scripts/check-upgrade-remedies.mjs --write');
    process.exit(1);
  }
  console.log(`Upgrade remedies table is current (${Object.keys(UPGRADE_REMEDIES).length} codes).`);
}
