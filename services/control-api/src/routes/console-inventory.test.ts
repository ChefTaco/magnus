import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
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
/**
 * Credential routes in the browser class. Owner decision (2026-11-13): an ADMIN may list, revoke and reset a
 * node's keys from the browser, because none of these returns a secret and the server checks the role itself.
 * Everything else that matches CREDENTIAL_PATH stays out: the enrollment token is a secret, and the shared-secret
 * lifecycle routes under /api/v1/credentials/:name are for reviewed runbooks. Adding a route here needs the same review.
 */
const BROWSER_CREDENTIAL_ROUTES = new Set([
  'GET /api/v1/nodes/:nodeId/credentials',
  'POST /api/v1/nodes/:nodeId/credentials/revoke',
  'POST /api/v1/nodes/:nodeId/credentials/reset',
]);
/** Any path segment that starts with "credential" (not /node-credentials, the fleet summary and pending bindings). */
const CREDENTIAL_PATH = /\/credential/u;
const FORBIDDEN_BROWSER_PATH = /terminal|\/auth\/login|ssh-admission|enrollment/u;
const row = (method: string, path: string, auth = 'user:ADMIN', extra = 'yes'): Row => ({ method, path, class: 'browser', auth, extra });

function forbiddenBrowserRows(candidates: Row[]): string[] {
  return candidates.filter((entry) => entry.class === 'browser' && FORBIDDEN_BROWSER_PATH.test(entry.path)).map((entry) => key(entry.method, entry.path));
}

/** Browser rows under a credential path that are not a reviewed route, or that are not ADMIN-only wave 1 rows. */
function credentialBrowserViolations(candidates: Row[]): string[] {
  return candidates.filter((entry) => entry.class === 'browser' && CREDENTIAL_PATH.test(entry.path))
    .filter((entry) => !BROWSER_CREDENTIAL_ROUTES.has(key(entry.method, entry.path)) || entry.auth !== 'user:ADMIN' || !/\byes\b/u.test(entry.extra))
    .map((entry) => key(entry.method, entry.path));
}
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
    '/api/v1/embermend', '/api/v1/shared-resource-leases', '/api/v1/mcp', '/api/v1/security-integration', '/api/v1/hiveskills', '/api/v1/hermes-registry',
  ])('never allows machine surface %s', (prefix) => {
    const matching = rows.filter((row) => row.path.startsWith(prefix) && row.method !== 'ALL');
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.filter((row) => row.class === 'browser')).toEqual([]);
  });

  it('allows no terminal, password login, ssh-admission or enrollment route', () => {
    expect(forbiddenBrowserRows(rows)).toEqual([]);
  });

  it('allows exactly the reviewed node-key routes among credential routes', () => {
    expect(credentialBrowserViolations(rows)).toEqual([]);
    // Each reviewed route is listed, as ADMIN only and in wave 1, and nothing else under /credentials is browser.
    expect(rows.filter((row) => row.class === 'browser' && CREDENTIAL_PATH.test(row.path)).map((row) => key(row.method, row.path)).sort())
      .toEqual([...BROWSER_CREDENTIAL_ROUTES].sort());
    for (const route of ['GET /api/v1/credentials/:name/status', 'POST /api/v1/credentials/:name/retire-previous', 'GET /api/v1/credentials/rotations',
      'POST /api/v1/nodes/:nodeId/enrollment-token']) {
      expect(rows.find((row) => key(row.method, row.path) === route)?.class, route).not.toBe('browser');
    }
  });

  it.each([
    ['a shared-secret lifecycle route', row('GET', '/api/v1/credentials/:name/status')],
    ['a retired shared-secret route turned browser', row('POST', '/api/v1/credentials/rotate')],
    ['another node credential route', row('POST', '/api/v1/nodes/:nodeId/credentials/export')],
    ['a singular credential path', row('GET', '/api/v1/nodes/:nodeId/credential')],
    ['a reviewed route opened to OPERATOR', row('POST', '/api/v1/nodes/:nodeId/credentials/revoke', 'user:ADMIN|OPERATOR')],
    ['a reviewed route without a published contract', row('POST', '/api/v1/nodes/:nodeId/credentials/reset', 'user:ADMIN', '')],
    ['a reviewed path under another method', row('DELETE', '/api/v1/nodes/:nodeId/credentials')],
  ])('refuses %s in the browser class', (_label, candidate) => {
    expect(credentialBrowserViolations([candidate])).toEqual([key(candidate.method, candidate.path)]);
  });

  it.each([
    row('POST', '/api/v1/terminal/ticket'), row('POST', '/api/v1/auth/login'), row('GET', '/api/v1/resource-leases/ssh-admission'),
    row('POST', '/api/v1/node-enrollment/enroll'), row('POST', '/api/v1/nodes/:nodeId/enrollment-token'),
  ])('refuses $method $path in the browser class', (candidate) => {
    expect(forbiddenBrowserRows([candidate])).toEqual([key(candidate.method, candidate.path)]);
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

  it('classifies the OpenAPI document as browser-facing, and only that part of the docs', () => {
    expect(rows.find((row) => key(row.method, row.path) === 'GET /api/docs/openapi.json')).toMatchObject({ class: 'browser', auth: 'public' });
    expect(rows.find((row) => key(row.method, row.path) === 'GET /api/docs')).toMatchObject({ class: 'exclude' });
    expect(markdown).toContain('`GET /api/magnus/docs/openapi.json` to\n`GET /api/docs/openapi.json`');
  });

  it('counts the rows of each class in its table', () => {
    for (const name of CLASSES) {
      const stated = new RegExp(`^\\| \`${name}\` \\|.*\\| (\\d+) \\|.*\\|$`, 'mu').exec(markdown);
      expect(Number(stated?.[1]), name).toBe(rows.filter((row) => row.class === name).length);
    }
  });

  it('publishes an OpenAPI document with no secret value or private detail', async () => {
    const secret = 'fixture-openapi-canary-secret-value';
    for (const name of ['API_SECRET', 'NODE_MANAGER_SECRET', 'JWT_SECRET', 'WEBHOOK_ENCRYPTION_KEY', 'METRICS_TOKEN']) vi.stubEnv(name, secret);
    const response = await app.request('/api/docs/openapi.json');
    vi.unstubAllEnvs();
    expect(response.status).toBe(200);
    const document = await response.text();
    expect(document).not.toContain(secret);
    expect(document).not.toMatch(/\/home\/|\/root\/|\.ts\.net|\.internal\b|-----BEGIN|\bsk-[A-Za-z0-9]{8}/u);
    // The only literal addresses a public document may carry are the documentation ranges.
    const addresses = document.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu) ?? [];
    expect(addresses.filter((address) => !/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./u.test(address))).toEqual([]);
    const { servers } = JSON.parse(document) as { servers: Array<{ url: string }> };
    expect(servers.every((server) => server.url.startsWith('/') || new URL(server.url).hostname === 'localhost')).toBe(true);
  });
});
