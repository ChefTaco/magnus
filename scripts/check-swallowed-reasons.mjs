#!/usr/bin/env node
// A catch that answers with an HTTP error and drops the cause hides why a request
// failed: four fleet-wide upgrade failures in one day were all the same error
// relabelled that way. In the upgrade, ledger, managed-http, enrollment and scheduler
// paths, a `catch` or a promise `.catch` that replies must log the cause or carry it
// in the reply, or say why it need not with a `// no-reason-needed: why` comment.
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

const LOGGED = /\b(logger\.(warn|error)|console\.(warn|error)|warn[A-Z]\w*)\(/;

/** A handler that replies and neither logs the error nor carries it in the reply hides the cause. */
function hidesCause(body, name) {
  if (!HTTP_REPLY.test(body) || MARKER.test(body) || LOGGED.test(body)) return false;
  if (!name) return true;
  // Only asking what type it is does not tell anyone what went wrong.
  return !new RegExp(`\\b${name}\\b`).test(body.replaceAll(new RegExp(`\\b${name}\\s+instanceof\\b`, 'g'), ''));
}

/** The catch blocks and promise catches of one source text that reply with an HTTP error and give no reason. */
export function findSwallowedReasons(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const report = (node, body) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ line: line + 1, excerpt: body.trim().split('\n')[0].slice(0, 100) });
  };
  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const body = node.block.getFullText(source);
      if (hidesCause(body, node.variableDeclaration?.name.getText(source))) report(node, body);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
      const [handler] = node.arguments;
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const body = handler.body.getFullText(source);
        if (hidesCause(body, handler.parameters[0]?.name.getText(source))) report(node, body);
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
    console.error('Catch blocks that reply with an HTTP error hide the cause. Log it at WARN (no secrets), or add `// no-reason-needed: why`:');
    for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.excerpt}`);
    process.exit(1);
  }
  console.log(`Swallowed reason check passed (${scopedFiles(defaultRoot).length} files).`);
}
