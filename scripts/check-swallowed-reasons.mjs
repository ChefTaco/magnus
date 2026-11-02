#!/usr/bin/env node
// A bare `catch {` that answers with an HTTP error hides why a request failed:
// four fleet-wide upgrade failures in one day were all the same error relabelled
// by such a block. In the upgrade, ledger, managed-http, enrollment and scheduler
// paths, a catch that replies must bind the error and log the cause, or say why
// it need not with a `// no-reason-needed: why` comment in the block.
//
//   node scripts/check-swallowed-reasons.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Directories and name patterns of the paths this rule covers; tests are never scanned. */
export const SCOPE = [
  ['packages/agent/src/upgrade', /\.ts$/],
  ['packages/agent/src/executors', /^(command-|managed-|mutation-barrier|enrollment-|scheduler-|cron-manager)/],
  ['services/control-api/src/services', /^(agent-upgrade|command-resource-leases|command-fence-repair|resource-enrollment|resource-ownership|resource-participant-work|managed-cron)/],
  ['services/control-api/src/routes', /^(agent-upgrades|resource-leases)\./],
  ['services/control-api/src/sdk', /^node-api-client\./],
];

const HTTP_REPLY = /\bc\.json\(|\bnew Response\(|\bnew HttpError\(|\bfail\(|\bthrow new [A-Za-z]*(Http|Response|Refusal)[A-Za-z]*Error\(/;
const MARKER = /\/\/[ \t]*no-reason-needed:[ \t]*\S/;

/** The bare catch blocks of one source text that reply with an HTTP error and give no reason. */
export function findSwallowedReasons(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isCatchClause(node) && !node.variableDeclaration) {
      const block = node.block.getFullText(source);
      if (HTTP_REPLY.test(block) && !MARKER.test(block)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({ line: line + 1, excerpt: block.trim().split('\n')[0].slice(0, 100) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function scopedFiles(root) {
  return SCOPE.flatMap(([dir, pattern]) => {
    const full = join(root, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full).filter((name) => name.endsWith('.ts') && !name.includes('.test.') && pattern.test(name)).map((name) => join(full, name));
  });
}

export function run(root = defaultRoot) {
  return scopedFiles(root).flatMap((file) => findSwallowedReasons(file, readFileSync(file, 'utf8')).map((hit) => ({ file: relative(root, file), ...hit })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = run();
  if (hits.length) {
    console.error('Bare catch blocks that reply with an HTTP error hide the cause. Bind the error and log it at WARN (no secrets), or add `// no-reason-needed: why`:');
    for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.excerpt}`);
    process.exit(1);
  }
  console.log(`Swallowed reason check passed (${scopedFiles(defaultRoot).length} files).`);
}
