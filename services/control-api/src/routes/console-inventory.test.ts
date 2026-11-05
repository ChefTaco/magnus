import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { magnusBrowserRoutes } from '@hivemagnus/magnus-contracts/browser';
import { app } from '../server.js';

const INVENTORY = new URL('../../../../docs/console-api.md', import.meta.url);
const CLASSES = ['browser', 'machine', 'exclude', 'retired'] as const;

interface Row { method: string; path: string; class: string; auth: string; extra: string }

function inventoryRows(markdown: string): Row[] {
  const rows: Row[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\| (GET|POST|PUT|PATCH|DELETE|ALL) \| `([^`]+)` \| (browser|machine|exclude|retired) \| `([^`]*)` \| (.*) \|$/.exec(line);
    if (match) rows.push({ method: match[1]!, path: match[2]!, class: match[3]!, auth: match[4]!, extra: match[5]! });
  }
  return rows;
}

function explicitDenies(markdown: string): string[] {
  const section = markdown.split('## Explicit denies')[1]!.split('\n## ')[0]!;
  return [...section.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|/gmu)].map((match) => `${match[1]} ${match[2]}`);
}

const markdown = readFileSync(INVENTORY, 'utf8');
const rows = inventoryRows(markdown);
const key = (method: string, path: string) => `${method} ${path}`;
/** One server route written as exact rows, because a parameter would also admit /rollouts/:id/cancel. */
const EXPANDED = new Map([
  ['/api/v1/rollouts/:id/:action', ['pause', 'resume', 'abort'].map((action) => `/api/v1/rollouts/:id/${action}`)],
]);
/** Catch-all stubs, the only ALL handlers that are routes rather than middleware. */
const CATCH_ALLS = ['/api/v1/deploy/*', '/api/v1/hermes/*', '/api/v1/orchestra/*', '/api/v1/security-fusion/*'];
const mounted = new Set(app.routes.filter((route) => route.method !== 'ALL').flatMap((route) => {
  const paths = EXPANDED.get(route.path) ?? [route.path];
  return paths.map((path) => key(route.method, path));
}));
const toPattern = (path: string) => new RegExp(`^${path.replace(/\*$/u, '.*').replace(/:[A-Za-z]+/gu, '[^/]+')}$`, 'u');
const normalize = (path: string) => path.replace(/:[A-Za-z]+/gu, ':param');

describe('console API route inventory', () => {
  it('lists each route once, under one class', () => {
    const keys = rows.map((row) => key(row.method, row.path));
    expect(keys.filter((value, index) => keys.indexOf(value) !== index)).toEqual([]);
    expect(new Set(rows.map((row) => row.class))).toEqual(new Set(CLASSES));
  });

  it('matches the routes actually mounted', () => {
    const listed = new Set(rows.filter((row) => row.method !== 'ALL').map((row) => key(row.method, row.path)));
    expect([...mounted].filter((route) => !listed.has(route)).sort()).toEqual([]);
    expect([...listed].filter((route) => !mounted.has(route)).sort()).toEqual([]);
  });

  it('lists exactly the catch-all stubs as retired', () => {
    const allRows = rows.filter((row) => row.method === 'ALL');
    expect(allRows.map((row) => row.path).sort()).toEqual([...CATCH_ALLS].sort());
    expect(allRows.every((row) => row.class === 'retired')).toBe(true);
    for (const path of CATCH_ALLS) expect(app.routes.some((route) => route.method === 'ALL' && route.path === path)).toBe(true);
  });

  it.each([
    '/api/v1/heartbeat', '/api/v1/discovery', '/api/v1/logs/ingest', '/api/v1/resource-leases/enrollment',
    '/api/v1/shared-resource-leases', '/api/v1/mcp', '/api/v1/security-integration', '/api/v1/hiveskills', '/api/v1/hermes-registry',
  ])('never allows machine surface %s', (prefix) => {
    const matching = rows.filter((row) => row.path.startsWith(prefix) && row.method !== 'ALL');
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.filter((row) => row.class === 'browser')).toEqual([]);
  });

  it('allows no terminal, credential or password login route', () => {
    const browser = rows.filter((row) => row.class === 'browser').map((row) => row.path);
    expect(browser.filter((path) => /terminal|\/credentials|\/auth\/login|ssh-admission/u.test(path))).toEqual([]);
  });

  it('marks wave 1 exactly where the browser contract publishes a route', () => {
    const published = new Set(magnusBrowserRoutes.map((route) =>
      key(route.method, normalize(`/api/v1${route.path.replace(/\{([^}]+)\}/gu, ':$1')}`))));
    const wave1 = rows.filter((row) => row.class === 'browser' && /\byes\b/u.test(row.extra))
      .map((row) => key(row.method, normalize(row.path)));
    expect(wave1.filter((route) => !published.has(route)).sort()).toEqual([]);
    expect([...published].filter((route) => !wave1.includes(route)).sort()).toEqual([]);
  });

  it('names every non-browser route that a browser pattern would also admit', () => {
    const browser = rows.filter((row) => row.class === 'browser');
    const shadowed = rows
      .filter((row) => row.class !== 'browser' && row.method !== 'ALL')
      .filter((row) => browser.some((candidate) => candidate.method === row.method && candidate.path.includes(':')
        && toPattern(candidate.path).test(row.path.replace(/:[A-Za-z]+/gu, 'param-value'))))
      .map((row) => key(row.method, row.path));
    expect(explicitDenies(markdown).sort()).toEqual(shadowed.sort());
  });

  it('keeps private details out of the inventory', () => {
    expect(markdown).not.toMatch(/\/home\/|\.ts\.net/u);
  });
});
