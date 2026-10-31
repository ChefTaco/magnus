import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { parseRouteAliases, resolveRouteAlias, withRouteAliases } from './route-aliases.js';
import { loadEnv } from './env.js';

const legacy = JSON.stringify({
  '/api/v1/resource-leases/legacy/authority-snapshot': '/api/v1/resource-leases/transfer/authority-snapshot',
  '/api/v1/resource-leases/legacy/admission': '/api/v1/resource-leases/admission',
});

describe('route aliases for older clients', () => {
  it('is off by default', () => {
    expect(parseRouteAliases(undefined)).toEqual([]);
    expect(parseRouteAliases(' ')).toEqual([]);
    const fetch = () => new Response('ok');
    expect(withRouteAliases(fetch, [])).toBe(fetch);
  });

  it('rewrites exact and nested legacy prefixes only', () => {
    const aliases = parseRouteAliases(legacy);
    expect(resolveRouteAlias('/api/v1/resource-leases/legacy/authority-snapshot', aliases)).toBe('/api/v1/resource-leases/transfer/authority-snapshot');
    expect(resolveRouteAlias('/api/v1/resource-leases/legacy/admission/node-1/close', aliases)).toBe('/api/v1/resource-leases/admission/node-1/close');
    expect(resolveRouteAlias('/api/v1/resource-leases/legacy/admissions', aliases)).toBeNull();
    expect(resolveRouteAlias('/api/v1/resource-leases/admission/node-1', aliases)).toBeNull();
  });

  it('rejects malformed, traversing, self-referencing and chained aliases', () => {
    for (const raw of ['[]', '{', '"x"', '{"/api/v1/a":1}', '{"/other/a":"/api/v1/b"}', '{"/api/v1/a":"/api/v1/../b"}',
      '{"/api/v1/a/":"/api/v1/b"}', '{"/api/v1/a":"/api/v1/a"}', '{"/api/v1/a":"/api/v1/b","/api/v1/b":"/api/v1/c"}',
      '{"/api/v1/a b":"/api/v1/b"}', '{"/api/v1/a?x=1":"/api/v1/b"}'])
      expect(() => parseRouteAliases(raw), raw).toThrow(/MAGNUS_ROUTE_ALIASES_JSON/);
    expect(() => loadEnv({ MAGNUS_ROUTE_ALIASES_JSON: '{"/x":"/y"}' })).toThrow(/MAGNUS_ROUTE_ALIASES_JSON/);
    expect(loadEnv({ MAGNUS_ROUTE_ALIASES_JSON: legacy }).MAGNUS_ROUTE_ALIASES_JSON).toBe(legacy);
  });

  it('routes the rewritten request, with method, headers, query and body, to the current handler', async () => {
    const app = new Hono();
    app.post('/api/v1/resource-leases/admission/:nodeId/close', async c => c.json({
      path: c.req.path, nodeId: c.req.param('nodeId'), query: c.req.query('q'),
      auth: c.req.header('authorization'), body: await c.req.json<unknown>(),
    }));
    const handler = withRouteAliases(app.fetch, parseRouteAliases(legacy));
    const response = await handler(new Request('http://fixture/api/v1/resource-leases/legacy/admission/node-1/close?q=1', {
      method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ releaseId: 'r-1' }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: '/api/v1/resource-leases/admission/node-1/close', nodeId: 'node-1', query: '1',
      auth: 'Bearer fixture', body: { releaseId: 'r-1' } });
    expect((await handler(new Request('http://fixture/api/v1/resource-leases/legacy/other', { method: 'POST' }))).status).toBe(404);
  });

  it('rewrites requests served by the Node adapter, including streamed bodies', async () => {
    const app = new Hono();
    app.post('/api/v1/resource-leases/transfer/authority-snapshot', async c => c.json({ path: c.req.path, body: await c.req.json<unknown>() }));
    const server = serve({ fetch: withRouteAliases(app.fetch, parseRouteAliases(legacy)), port: 0, hostname: '127.0.0.1' });
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/resource-leases/legacy/authority-snapshot`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: 'n'.repeat(32) }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ path: '/api/v1/resource-leases/transfer/authority-snapshot', body: { nonce: 'n'.repeat(32) } });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
