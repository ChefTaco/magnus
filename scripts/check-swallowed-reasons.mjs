#!/usr/bin/env node
// A catch that answers with an HTTP error and drops the cause hides why a request
// failed: four fleet-wide upgrade failures in one day were all the same error
// relabelled that way. In the upgrade, ledger, managed-http, enrollment and scheduler
// paths, a `catch` or a rejection handler that replies must carry the error in a log
// call or in every reply, or say why it need not with a `// no-reason-needed: why`
// comment. A plain `throw new Error(...)` is not checked: most callers log those.
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

const REPLY_CALLS = new Set(['c.json', 'refuse', 'refused', 'fail']);
const REPLY_NEWS = /^(Response|[A-Za-z]*(Http|Refusal|Admission|Dispatched|AgentResponse|SelfUpgrade)[A-Za-z]*Error)$/;
const LOG_CALL = /^(logger\.(warn|error)|console\.(warn|error)|warn[A-Z]\w*)$/;
const MARKER = /\/\/[ \t]*no-reason-needed:[ \t]*\S/;

/** The identifiers an error is bound to: `e`, or those of a destructured pattern. */
function bindingNames(name) {
  if (!name) return [];
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => bindingNames(element.name));
}

/**
 * Whether the error itself appears inside this expression, as code: a name in a
 * string or a comment says nothing, and neither does asking what type it is.
 */
function mentions(node, names, source) {
  let found = false;
  const walk = (current) => {
    if (found) return;
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return;
    if (ts.isIdentifier(current) && names.includes(current.text)) {
      const parent = current.parent;
      if (!(ts.isPropertyAccessExpression(parent) && parent.name === current) && !(ts.isPropertyAssignment(parent) && parent.name === current)) found = true;
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return found;
}

/** The replies and log calls of a handler, leaving out nested catches and functions: those speak for themselves. */
function handlerCalls(body, source, names) {
  const replies = [];
  const logs = [];
  const walk = (node) => {
    if (ts.isCatchClause(node)) return;
    if (ts.isFunctionLike(node) && node !== body) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (REPLY_CALLS.has(callee)) replies.push(node);
      if (LOG_CALL.test(callee)) logs.push(node);
    }
    if (ts.isNewExpression(node) && REPLY_NEWS.test(node.expression.getText(source))) replies.push(node);
    ts.forEachChild(node, walk);
  };
  walk(body);
  return { replies, logs };
}

/**
 * A handler that replies hides the cause unless a log call carries the error, or
 * every one of its replies does. A concise arrow's body is a reply itself.
 */
function hidesCause(body, names, source) {
  if (MARKER.test(body.getFullText(source))) return false;
  const { replies, logs } = handlerCalls(body, source, names);
  if (!replies.length) return false;
  if (logs.some((call) => call.arguments.some((argument) => mentions(argument, names, source)))) return false;
  return !replies.every((call) => (call.arguments ?? []).some((argument) => mentions(argument, names, source)));
}

/** The catch blocks and rejection handlers of one source text that reply with an HTTP error and give no reason. */
export function findSwallowedReasons(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const named = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) named.set(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name) named.set(node.name.text, node);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const report = (node, body) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ line: line + 1, excerpt: body.getFullText(source).trim().split('\n')[0].slice(0, 100) });
  };
  const checkHandler = (node, handler) => {
    const fn = handler && ts.isIdentifier(handler) ? named.get(handler.text) : handler;
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) || !fn.body) return;
    if (hidesCause(fn.body, bindingNames(fn.parameters[0]?.name), source)) report(node, fn.body);
  };
  const visit = (node) => {
    if (ts.isCatchClause(node) && hidesCause(node.block, bindingNames(node.variableDeclaration?.name), source)) report(node, node.block);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === 'catch') checkHandler(node, node.arguments[0]);
      if (node.expression.name.text === 'then' && node.arguments.length > 1) checkHandler(node, node.arguments[1]);
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
