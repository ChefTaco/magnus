/**
 * The OpenAPI document covers the mounted routes. `undocumented-routes.json` lists the routes that
 * still have no entry: it may only shrink. A new route needs a spec entry, and a route that gains
 * one must leave the list. `/orchestra/*` is a deprecated alias of the Hermes reads and is not
 * documented separately.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { app } from '../server.js';
import { buildOpenApiSpec } from './spec.js';

const LIST = new URL('./undocumented-routes.json', import.meta.url);
/** Documented paths served by a catch-all (retired endpoints that answer 410), not by a route of their own. */
const SERVED_BY_CATCH_ALL = /^(?:POST|GET) \/deploy(?:\/|$)/;
/** Wildcard routes and the one parameterized entry that documents them. */
const WILDCARD_ENTRIES = new Map([
  ['GET /ardent/installations/{nodeId}/profiles/{name}/*', 'GET /ardent/installations/{nodeId}/profiles/{name}/{resource}'],
]);

const spec = buildOpenApiSpec() as { paths: Record<string, Record<string, unknown>> };
const documented = new Set(Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)));
const mounted = new Set(app.routes
  .filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/v1/') && !route.path.startsWith('/api/v1/orchestra/'))
  .map((route) => `${route.method} ${route.path.slice('/api/v1'.length).replace(/:([A-Za-z]+)(\{[^}]*\})?/g, '{$1}')}`)
  .map((route) => WILDCARD_ENTRIES.get(route) ?? route));
const undocumented = [...mounted].filter((route) => !documented.has(route)).sort();

describe('OpenAPI route coverage', () => {
  if (process.env['WRITE_UNDOCUMENTED_ROUTES'] === 'true') writeFileSync(LIST, `${JSON.stringify(undocumented, null, 2)}\n`);
  const listed: string[] = JSON.parse(readFileSync(LIST, 'utf8')) as string[];

  it('documents every new route', () => {
    expect(undocumented.filter((route) => !listed.includes(route))).toEqual([]);
  });

  it('lists only routes that exist and still lack an entry', () => {
    expect(listed.filter((route) => !mounted.has(route) || documented.has(route))).toEqual([]);
    expect([...listed].sort()).toEqual(listed);
  });

  it('documents no route the server does not mount', () => {
    expect([...documented].filter((route) => !mounted.has(route) && !SERVED_BY_CATCH_ALL.test(route)).sort()).toEqual([]);
  });
});
