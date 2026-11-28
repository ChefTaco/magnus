import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  COOKIE_NAME: 'magnus_session',
  verifySessionToken: async (token: string) => token === 'signed'
    ? { username: 'admin', sessionId: '00000000-0000-4000-8000-000000000003', exp: Math.floor(Date.now() / 1000) + 3600, iat: 0 }
    : null,
}));
vi.mock('@/lib/hive-router-fetch', () => ({ hiveRouterFetch: mocks.fetch }));
vi.mock('../../../../../../runtime-integrations.mjs', () => ({ hiveRouterAdminUrl: () => 'https://router.example.com' }));
vi.mock('../../../../../../runtime-local-sessions.mjs', () => ({
  verifyLocalSession: async (session: { sessionId?: string }) => session.sessionId === SESSION_ID,
}));

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-0123456789abcdef';
const { GET, POST } = await import('./route');
const { mintFrameGrant, clearFrameSessionState, FRAME_GRANT_TTL_SECONDS } = await import('../../../../../../runtime-embed-isolation.mjs');
const session = { username: 'admin', sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 };
const grant = await mintFrameGrant({ app: 'router', session });

const context = (path: string[]) => ({ params: Promise.resolve({ path: ['_frame', grant, ...path] }) });
const request = (method: string, body?: string, headers: Record<string, string> = {}) => new NextRequest(`https://magnus.example.com/api/hive-router/dashboard/_frame/${grant}/api/x`, {
  method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body }),
});

describe('Hive Router admin proxy', () => {
  beforeEach(() => { mocks.fetch.mockReset(); vi.unstubAllEnvs(); });

  it('turns a console-session entry into a grant-carrying frame URL', async () => {
    const response = await GET(new NextRequest('https://magnus.example.com/api/hive-router/dashboard', {
      headers: { cookie: 'magnus_session=signed', 'sec-fetch-site': 'same-origin' },
    }), { params: Promise.resolve({}) });
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toMatch(/^\/api\/hive-router\/dashboard\/_frame\/[\w.-]+\/?$/);
    expect(mocks.fetch).not.toHaveBeenCalled();
    const crossSite = await GET(new NextRequest('https://magnus.example.com/api/hive-router/dashboard', {
      headers: { cookie: 'magnus_session=signed', 'sec-fetch-site': 'cross-site' },
    }), { params: Promise.resolve({}) });
    expect(crossSite.status).toBe(403);
  });

  it('keeps the router cookies server-side and sends them back on the next frame request', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'hive_router_admin=a; Path=/; HttpOnly');
    headers.append('set-cookie', 'csrf=b; Path=/');
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 200, headers }));
    const response = await GET(request('GET', undefined, { origin: 'null', cookie: 'magnus_session=signed' }), context(['api', 'x']));
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('content-security-policy')).toMatch(/^sandbox /);
    expect(response.headers.get('access-control-allow-origin')).toBe('null');
    // The console session cookie never reaches the router; the jar does.
    expect(mocks.fetch.mock.calls[0]![1].headers.cookie).toBeUndefined();

    mocks.fetch.mockResolvedValue(new Response('{}', { status: 200, headers: { 'set-cookie': 'csrf=; Max-Age=0', 'content-type': 'application/json' } }));
    await GET(request('GET'), context(['api', 'x']));
    expect(mocks.fetch.mock.calls[1]![1].headers.cookie).toBe('hive_router_admin=a; csrf=b');
    await GET(request('GET'), context(['api', 'x']));
    expect(mocks.fetch.mock.calls[2]![1].headers.cookie).toBe('hive_router_admin=a');

    // Signing out of the console forgets the router login.
    clearFrameSessionState(SESSION_ID);
    await GET(request('GET'), context(['api', 'x']));
    expect(mocks.fetch.mock.calls[3]![1].headers.cookie).toBeUndefined();
  });

  it('rewrites router pages onto the frame base and refuses a foreign grant', async () => {
    mocks.fetch.mockResolvedValue(new Response('<html><head></head><script src="/assets/a.js"></script></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const text = await (await GET(request('GET'), context([]))).text();
    expect(text).toContain(`"/api/hive-router/dashboard/_frame/${grant}/assets/a.js"`);
    const hermes = await mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    const refused = await GET(request('GET'), { params: Promise.resolve({ path: ['_frame', hermes, 'api', 'x'] }) });
    expect(refused.status).toBe(401);
  });

  it('never lets an expired grant reach the router API through an encoded traversal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - (FRAME_GRANT_TTL_SECONDS + 60) * 1000);
    const expired = await mintFrameGrant({ app: 'router', session });
    vi.useRealTimers();
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const get = (segments: string[]) => GET(request('GET'), { params: Promise.resolve({ path: ['_frame', expired, ...segments] }) });
    // Segments as Next.js hands them over, decoded once: `%252e%252e` arrives as `%2e%2e`, and so on.
    for (const segments of [['assets', '%2e%2e', 'api', 'x'], ['assets', '%2E%2e', 'api', 'x'], ['assets', '%5c..%5capi', 'x']]) {
      expect((await get(segments)).status, segments.join('/')).toBe(401);
    }
    for (const segments of [['assets', '..', 'api', 'x'], ['assets', '../api', 'x'], ['assets', '..\\api', 'x'], ['assets', '.', 'x.js']]) {
      expect((await get(segments)).status, segments.join('/')).toBe(400);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
    // A real static file still loads with the expired grant.
    expect((await get(['assets', 'index.js'])).status).toBe(200);
    expect(String(mocks.fetch.mock.calls[0]![0])).toBe('https://router.example.com/assets/index.js');
  });

  it('forwards an odd segment as a literal name that the router cannot normalise away', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await GET(request('GET'), context(['assets', '%2e%2e', 'api', 'x']));
    expect(String(mocks.fetch.mock.calls[0]![0])).toBe('https://router.example.com/assets/%252e%252e/api/x');
    expect((await GET(request('GET'), context(['assets', '..', 'api', 'x']))).status).toBe(400);
    expect(mocks.fetch).toHaveBeenCalledOnce();
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
