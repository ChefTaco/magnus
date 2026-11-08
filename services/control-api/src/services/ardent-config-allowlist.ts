import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { ARDENT_SERVICE_CONFIG_PATHS } from '@hivemagnus/magnus-contracts';

/** Segments compared whole, so a key that contains a dot never matches an allowed path. */
const ALLOWED = new Set(ARDENT_SERVICE_CONFIG_PATHS.map(path => JSON.stringify(path.split('.'))));

type Tree = Record<string, unknown>;
const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (tree: Tree | undefined, key: string): unknown => tree !== undefined && Object.hasOwn(tree, key) ? tree[key] : undefined;

function parse(text: string, label: string): unknown {
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`The ${label} configuration is not valid YAML`);
  return doc.toJS({ maxAliasCount: 100 }) as unknown;
}

/**
 * Every value path whose value differs between two config.yaml texts. Maps are compared key by
 * key (a missing map counts as empty); any other value, arrays included, is compared whole.
 * Comments and formatting are not values.
 */
export function changedConfigPaths(before: string, after: string): string[][] {
  const changed: string[][] = [];
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if ((isTree(a) || a === undefined) && (isTree(b) || b === undefined) && (isTree(a) || isTree(b))) {
      const left = isTree(a) ? a : undefined;
      const right = isTree(b) ? b : undefined;
      for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) walk(own(left, key), own(right, key), [...path, key]);
      return;
    }
    if (!isDeepStrictEqual(a, b)) changed.push(path);
  };
  walk(parse(before, 'current'), parse(after, 'new'), []);
  return changed;
}

const dotted = (path: string[]) => path.join('.') || '(document)';

/**
 * What an edit from a linked service changes, dotted for the audit and for errors, and which of those
 * changes fall outside ARDENT_SERVICE_CONFIG_PATHS. The edit is allowed only when `forbidden` is empty.
 */
export function classifyServiceConfigEdit(before: string, after: string): { changed: string[]; forbidden: string[] } {
  const paths = changedConfigPaths(before, after);
  return { changed: paths.map(dotted).sort(), forbidden: paths.filter(path => !ALLOWED.has(JSON.stringify(path))).map(dotted).sort() };
}
