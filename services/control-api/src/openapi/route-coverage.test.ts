/**
 * The OpenAPI document covers exactly the mounted routes: every route has an entry, and every entry
 * is a route. `/orchestra/*` is a deprecated alias of the Hermes reads and is not documented
 * separately.
 */
import { describe, expect, it } from 'vitest';
import { app } from '../server.js';
import { buildOpenApiSpec } from './spec.js';

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
  it('documents every mounted route', () => {
    expect(undocumented).toEqual([]);
  });

  it('sees the mounted routes', () => {
    expect(mounted.size).toBeGreaterThan(300);
  });

  it('documents no route the server does not mount', () => {
    expect([...documented].filter((route) => !mounted.has(route) && !SERVED_BY_CATCH_ALL.test(route)).sort()).toEqual([]);
  });
});
