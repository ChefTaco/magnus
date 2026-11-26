import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/auth', () => ({ COOKIE_NAME: 'magnus_session', verifySessionToken: async () => ({ username: 'admin' }) }));
vi.mock('@/lib/hive-router-fetch', () => ({ hiveRouterFetch: mocks.fetch }));
vi.mock('../../../../../../runtime-integrations.mjs', () => ({ hiveRouterAdminUrl: () => 'https://router.example.com' }));

const { GET, POST } = await import('./route');
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (method: string, body?: string) => new NextRequest('https://magnus.example.com/api/hive-router/dashboard/api/x', {
  method, headers: { cookie: 'magnus_session=signed', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }),
});

describe('Hive Router admin proxy', () => {
  beforeEach(() => { mocks.fetch.mockReset(); vi.unstubAllEnvs(); });

  it('relays every Set-Cookie, each scoped to the proxy path', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'hive_router_admin=a; Path=/; HttpOnly');
    headers.append('set-cookie', 'csrf=b; Path=/');
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 200, headers }));
    const response = await GET(request('GET'), context(['api', 'x']));
    expect(response.headers.getSetCookie()).toEqual([
      'hive_router_admin=a; Path=/api/hive-router/dashboard; HttpOnly',
      'csrf=b; Path=/api/hive-router/dashboard',
    ]);
  });

  it('refuses a request body over the proxy limit without calling the router', async () => {
    vi.stubEnv('DASHBOARD_PROXY_BODY_LIMIT_BYTES', '8');
    const response = await POST(request('POST', '{"too":"large"}'), context(['api', 'x']));
    expect(response.status).toBe(413);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('stops reading an oversized router response', async () => {
    mocks.fetch.mockResolvedValue(new Response('x', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': String(64 * 1024 * 1024) } }));
    expect((await GET(request('GET'), context(['big']))).status).toBe(502);
  });
});
