#!/usr/bin/env node
// Fails when Magnus pins an older @hivemagnus/ardent than the latest published release.
// Magnus deploys and manages Ardent agents, so every Ardent release needs a matching Magnus update:
// bump the pins below, run `npm install`, `npm run ardent:openapi:write`, and update the node-agent
// allowlists for any new management routes.
//   node scripts/check-ardent-latest.mjs                 compare with the npm registry
//   node scripts/check-ardent-latest.mjs --latest X.Y.Z  compare with a given version (offline tests)
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@hivemagnus/ardent';
const semver = /^(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(left, right) {
  const a = semver.exec(left);
  const b = semver.exec(right);
  if (!a || !b) throw new Error(`Expected exact X.Y.Z versions, got ${left} and ${right}`);
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Every place Magnus pins the Ardent package. They must agree with each other. */
export function pinnedArdentVersions(root) {
  const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const shrinkwrap = read('packages/agent/npm-shrinkwrap.json');
  return {
    'package.json': read('package.json').devDependencies?.[PACKAGE],
    'packages/agent/package.json': read('packages/agent/package.json').devDependencies?.[PACKAGE],
    'packages/agent/npm-shrinkwrap.json': shrinkwrap.packages?.[`node_modules/${PACKAGE}`]?.version,
  };
}

export function checkArdentPins(pins, latest) {
  const problems = [];
  const values = new Set(Object.values(pins));
  for (const [file, version] of Object.entries(pins)) {
    if (typeof version !== 'string' || !semver.test(version)) problems.push(`${file}: ${PACKAGE} must be pinned to an exact version`);
  }
  if (values.size > 1) problems.push(`${PACKAGE} pins disagree: ${JSON.stringify(pins)}`);
  if (!problems.length) {
    const [pinned] = values;
    const order = compareVersions(pinned, latest);
    if (order < 0) problems.push(`Magnus pins ${PACKAGE}@${pinned}, but ${latest} is the latest release. Update Magnus for the new Ardent (pins, npm install, npm run ardent:openapi:write, node-agent allowlists).`);
    if (order > 0) problems.push(`Magnus pins ${PACKAGE}@${pinned}, which is newer than the published ${latest}`);
  }
  return problems;
}

async function latestPublished() {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for ${PACKAGE}`);
  const latest = (await response.json())['dist-tags']?.latest;
  if (typeof latest !== 'string') throw new Error(`npm registry has no latest dist-tag for ${PACKAGE}`);
  return latest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(import.meta.dirname, '..');
  const flag = process.argv.indexOf('--latest');
  const latest = flag > 0 ? process.argv[flag + 1] : await latestPublished();
  const pins = pinnedArdentVersions(root);
  const problems = checkArdentPins(pins, latest);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`Magnus pins the latest ${PACKAGE}@${latest}`);
}
