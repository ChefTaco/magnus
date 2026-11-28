// Fails when a tracked document names a version that is no longer current, so version claims
// cannot go stale silently. Checked: this repository's own image and package references, links
// into a Hive suite release, "<Product> X.Y.Z pins|ships|installs|…" claims, and "pins <Product>
// X.Y.Z" claims. A claim about another product's release passes only when this repository holds
// that pin itself (`known` below); otherwise name no version and point at the signed suite
// release manifest, which is the only source of those facts. "From X.Y.Z" and "X.Y.Z or later"
// minimums are not claims about the current release and are not checked.
//
// Exempt: the files in `exempt` (release history) and text between
// `<!-- doc-versions: history -->` and `<!-- /doc-versions -->` (dated records).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(read(path));

/**
 * This repository's facts: its product name and version, the image and npm names it publishes,
 * and `known`, the versions of products (its own included) that this repository itself pins,
 * read from the files that hold those pins.
 */
export function repositoryConfig() {
  return {
    product: 'Magnus',
    version: json('package.json').version,
    images: ['magnus-server', 'magnus-fleet-gateway', 'magnus-ui', 'magnus-agent'],
    packages: ['@hivemagnus/magnus', '@hivemagnus/magnus-server', '@hivemagnus/magnus-agent', '@hivemagnus/magnus-contracts',
      '@hivemagnus/magnus-fleet-gateway', '@hivemagnus/magnus-oathweave', '@hivemagnus/magnus-skills', '@hivemagnus/magnus-ui'],
    // Node agents stage this exact Ardent release (packages/agent/package.json).
    known: { Ardent: json('packages/agent/package.json').dependencies['@hivemagnus/ardent'] },
    // Release history: each UPGRADING.md section describes the release it is named after.
    exempt: [/(^|\/)CHANGELOG\.md$/, /^UPGRADING\.md$/],
    extra: [],
  };
}

const PRODUCTS = ['Hive', 'Magnus', 'Ardent', 'ArdentStudio', 'Oathweave', 'Emberpath', 'HiveMem', 'HiveSkills',
  'HiveXUI', 'Cindertrace', 'ChatterMost', 'Emberfold', 'Embermend', 'HiveCommon', 'hive-common', 'Proser'];
const VERSION = String.raw`v?(\d+\.\d+\.\d+)`;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const any = (values) => values.map(escape).join('|');

/** Rules for `config`: each has a pattern whose last group is a version, and `allowed(match)`. */
export function rulesFor(config) {
  const self = config.product.toLowerCase();
  const known = Object.fromEntries(Object.entries(config.known).map(([name, versions]) => [name.toLowerCase(), [versions].flat()]));
  const current = (name) => {
    const key = name.toLowerCase();
    return key === self ? [config.version, ...(known[key] ?? [])] : known[key] ?? [];
  };
  const names = [...new Set([...PRODUCTS, config.product, ...Object.keys(config.known)])].sort((a, b) => b.length - a.length);
  const product = String.raw`(?:@hivemagnus\/)?(${any(names)})`;
  const rules = [
    // The retired npm launcher's documents exist only in the Hive 1.x line, last released as 1.2.2.
    { name: 'Hive suite release link', pattern: new RegExp(String.raw`ChefTaco\/hive\/(?:blob|tree)\/${VERSION}\/`, 'gi'), allowed: () => ['1.2.2'] },
    { name: 'Hive suite release link', pattern: new RegExp(String.raw`ChefTaco\/hive\/releases\/tag\/${VERSION}\b`, 'gi'), allowed: () => [] },
    { name: 'release claim', pattern: new RegExp(String.raw`\b${product}(?: suite)? ${VERSION},? (?:pins|ships|installs|bundles|stages|keeps|includes)\b`, 'gi'), allowed: (m) => current(m[1]) },
    { name: 'pin claim', pattern: new RegExp(String.raw`\b(?:pins|pinned|pinning|stages|bundles)(?: exactly)? \`?${product}[ @]${VERSION}`, 'gi'), allowed: (m) => current(m[1]) },
    ...config.extra,
  ];
  if (config.images.length) rules.push({ name: 'image', pattern: new RegExp(String.raw`ghcr\.io\/cheftaco\/(?:${any(config.images)}):${VERSION}\b`, 'g'), allowed: () => current(self) });
  if (config.packages.length) rules.push({ name: 'package', pattern: new RegExp(String.raw`(?<![\w/-])(?:${any(config.packages)})@(\d+\.\d+\.\d+)\b`, 'g'), allowed: () => current(self) });
  return rules;
}

/** Every stale version reference in `text`, as `line: found (allowed: …)` strings. */
export function staleReferences(text, rules) {
  const problems = [];
  let history = false;
  text.split('\n').forEach((line, index) => {
    if (/<!--\s*doc-versions:\s*history\s*-->/.test(line)) history = true;
    if (/<!--\s*\/doc-versions\s*-->/.test(line)) { history = false; return; }
    if (history) return;
    for (const rule of rules) {
      for (const match of line.matchAll(rule.pattern)) {
        const version = match[match.length - 1];
        const allowed = rule.allowed(match);
        if (!allowed.includes(version)) {
          problems.push(`${index + 1}: ${rule.name} "${match[0]}" (${allowed.length ? `allowed: ${allowed.join(', ')}` : 'name no version'})`);
        }
      }
    }
  });
  return problems;
}

export function check(config = repositoryConfig()) {
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter((path) => path && !config.exempt.some((pattern) => pattern.test(path)));
  const rules = rulesFor(config);
  return files.flatMap((path) => staleReferences(read(path), rules).map((problem) => `${path}:${problem}`));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = repositoryConfig();
  const problems = check(config);
  if (problems.length) {
    console.error(`Stale version references (update them, or name no version and point at the signed suite release):\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`Document version references match ${config.product} ${config.version}`);
}
