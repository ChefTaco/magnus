import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const SESSION_ID = '00000000-0000-4000-8000-000000000004';
vi.mock('../runtime-local-sessions.mjs', () => ({
  verifyLocalSession: async (session: { sessionId?: string; provider?: string }) => session.provider === 'hive' || session.sessionId === SESSION_ID,
}));
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-0123456789abcdef';
const { default: proxy } = await import('./proxy');
const { mintFrameGrant } = await import('../runtime-embed-isolation.mjs');

/** A well-formed grant another console signed: right shape and claims, wrong key. */
async function foreignGrant(): Promise<string> {
  const { SignJWT } = await import('jose');
  return new SignJWT({ app: 'hermes', u: 'admin', sid: 'foreign-session', sexp: Math.floor(Date.now() / 1000) + 600, ins: 'install-a' })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer('magnus-dashboard').setAudience('magnus-embedded-dashboard')
    .setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode('fixture-another-console-secret-0123456789'));
}

describe('dashboard authentication proxy', () => {
  it('no longer exempts the retired internal drain route from authentication', async () => {
    expect((await proxy(new NextRequest('https://magnus.example/api/internal/resource-enrollment/drain', { method: 'POST' }))).status).toBe(401);
  });
  it('returns JSON 401 for unauthenticated API requests', async () => {
    const response = await proxy(new NextRequest('https://magnus.example/api/proxy/events/stream'));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ error: 'authentication_required' });
  });

  it('redirects unauthenticated page requests to login', async () => {
    const response = await proxy(new NextRequest('https://magnus.example/hermes-security'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://magnus.example/login');
  });
});

describe('cross-site requests', () => {
  afterEach(() => vi.unstubAllEnvs());
  const post = (path: string, headers: Record<string, string>) =>
    proxy(new NextRequest(`https://magnus.example.com${path}`, { method: 'POST', headers: { host: 'magnus.example.com', ...headers } }));

  it('refuses a state change from another origin before authentication, login included', async () => {
    vi.stubEnv('DASHBOARD_PUBLIC_ORIGIN', 'https://magnus.example.com');
    for (const path of ['/api/proxy/commands', '/api/terminal/session', '/api/control-nodes', '/api/auth/login']) {
      const response = await post(path, { origin: 'https://evil.example.com', cookie: 'magnus_session=x' });
      expect(response.status, path).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'cross_site_request_refused' });
    }
    expect((await post('/api/proxy/commands', { origin: 'null' })).status).toBe(403);
    expect((await post('/api/proxy/commands', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await post('/api/proxy/commands', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('lets same-origin and non-browser requests through to authentication', async () => {
    vi.stubEnv('DASHBOARD_PUBLIC_ORIGIN', 'https://console.example.com');
    expect((await post('/api/proxy/commands', { origin: 'https://console.example.com' })).status).toBe(401);
    expect((await post('/api/proxy/commands', { origin: 'https://magnus.example.com' })).status).toBe(401);
    expect((await post('/api/proxy/commands', { 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await post('/api/proxy/commands', {})).status).toBe(401);
    expect((await proxy(new NextRequest('https://magnus.example.com/api/proxy/nodes', { headers: { origin: 'https://evil.example.com' } }))).status).toBe(401);
  });
});

describe('embedded dashboard isolation', () => {
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    proxy(new NextRequest(`https://magnus.example.com${path}`, { method, headers: { host: 'magnus.example.com', ...headers } }));
  const session = { username: 'admin', sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 };

  it('lets a frame request through on its grant alone, cross-site writes included', async () => {
    const grant = await mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    const path = `/api/hermes/dashboard/_frame/${grant}/api/status`;
    expect((await get(path, { origin: 'null', 'sec-fetch-site': 'cross-site' })).headers.get('x-middleware-next')).toBe('1');
    expect((await get(path, { origin: 'null' }, 'POST')).headers.get('x-middleware-next')).toBe('1');
    expect((await get(path, { origin: 'null' }, 'OPTIONS')).headers.get('x-middleware-next')).toBe('1');
  });

  it('refuses a frame request with a bad or foreign grant, even with a console cookie', async () => {
    for (const grant of ['forged', await foreignGrant()]) {
      const response = await get(`/api/hermes/dashboard/_frame/${grant}/api/status`, { cookie: 'magnus_session=x', origin: 'null' });
      expect(response.status).toBe(401);
      expect(response.headers.get('access-control-allow-origin')).toBe('null');
    }
  });

  it('passes an expired grant only for a navigation (to be re-minted) or a static asset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 3600 * 1000);
    const grant = await mintFrameGrant({ app: 'hermes', installationId: 'install-a', session: { ...session, exp: Math.floor(Date.now() / 1000) + 7200 } });
    vi.useRealTimers();
    const base = `/api/hermes/dashboard/_frame/${grant}`;
    const api = await get(`${base}/api/status`, { origin: 'null' });
    expect(api.status).toBe(401);
    await expect(api.json()).resolves.toEqual({ error: 'frame_grant_expired' });
    expect((await get(`${base}/sessions`, { 'sec-fetch-mode': 'navigate' })).headers.get('x-middleware-next')).toBe('1');
    expect((await get(`${base}/assets/index.js`, {})).headers.get('x-middleware-next')).toBe('1');
    for (const path of ['/assets/%2e%2e/api/status', '/assets/%252e%252e/api/status', '/assets/..%2fapi/status', '/assets/%5c..%5capi', '/assets/%2E%2e/api']) {
      expect((await get(`${base}${path}`, {})).status, path).toBe(401);
    }
  });

  it('refuses console API reads from a sandboxed page or another site', async () => {
    for (const headers of <Record<string, string>[]>[{ origin: 'null' }, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }, { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' }]) {
      const response = await get('/api/proxy/nodes', { cookie: 'magnus_session=x', ...headers });
      expect(response.status, JSON.stringify(headers)).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'cross_site_request_refused' });
    }
    // Navigations (an identity provider returning to the callback) and same-origin reads still pass.
    expect((await get('/api/auth/hive/callback', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).status).not.toBe(403);
    expect((await get('/api/proxy/nodes', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })).status).toBe(401);
    expect((await get('/api/health', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })).status).not.toBe(403);
  });
});
