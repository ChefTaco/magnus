import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const mocks = vi.hoisted(() => ({ ssh: vi.fn(), live: true }));
vi.mock('@/lib/auth', () => ({
  COOKIE_NAME: 'magnus_session',
  verifySessionToken: async (token: string) => token === 'signed'
    ? { username: 'admin', sessionId: '00000000-0000-4000-8000-000000000002', exp: Math.floor(Date.now() / 1000) + 3600, iat: 0 }
    : null,
}));
vi.mock('@/lib/orchestra-fetch', () => ({
  orchestraFetch: async () => ({ success: true, data: [
    { id: 'install-a', nodeId: 'node-a', hostname: 'node-1.example.com', dashboardPort: 9119, dashboardStatus: 'running', status: 'running' },
    { id: 'install-b', nodeId: 'node-b', hostname: 'node-2.example.com', dashboardPort: 9119, dashboardStatus: 'running', status: 'running' },
  ] }),
}));
vi.mock('@/lib/hermes-ssh-proxy', () => ({ requestHermesDashboardOverSsh: mocks.ssh }));
vi.mock('../../../../../../runtime-integrations.mjs', () => ({ hermesEnabled: () => true }));
vi.mock('../../../../../../runtime-local-sessions.mjs', () => ({
  verifyLocalSession: async (session: { sessionId?: string }) => mocks.live && session.sessionId === SESSION_ID,
}));

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-0123456789abcdef';
const { GET, POST, OPTIONS } = await import('./route');
const { mintFrameGrant } = await import('../../../../../../runtime-embed-isolation.mjs');

const context = (path: string[] = []) => ({ params: Promise.resolve({ path }) });
const base = 'https://magnus.example.com/api/hermes/dashboard';
const session = { username: 'admin', sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 };
const html = '<!doctype html><html><head><script>window.__HERMES_SESSION_TOKEN__="fixture-hermes-token";</script>'
  + '<script type="module" src="/assets/index.js"></script></head><body><a href="/sessions">x</a></body></html>';

function upstream(body: string, contentType: string) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': contentType, 'set-cookie': 'upstream=1' }, body: Buffer.from(body) };
}

describe('Hermes dashboard proxy isolation', () => {
  beforeEach(() => { mocks.ssh.mockReset(); mocks.live = true; });

  it('turns a console-session entry into a grant-carrying frame URL and clears the legacy cookies', async () => {
    const req = new NextRequest(`${base}?installationId=install-a&frame=1`, {
      headers: {
        cookie: 'magnus_session=signed; magnus_hermes_dashboard_session_token=old; magnus_hermes_dashboard_installation_id=install-a',
        'sec-fetch-site': 'same-origin',
      },
    });
    const response = await GET(req, context());
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toMatch(/^\/api\/hermes\/dashboard\/_frame\/[\w-]+\.[\w-]+\.[\w-]+\/?$/);
    expect(location.search).toBe('?frame=1');
    expect(response.headers.getSetCookie().join('\n')).toMatch(/magnus_hermes_dashboard_session_token=;.*Max-Age=0/);
    expect(mocks.ssh).not.toHaveBeenCalled();
  });

  it('refuses entry without a console session, or from a sandboxed (cross-site) page', async () => {
    expect((await GET(new NextRequest(`${base}?installationId=install-a`), context())).status).toBe(401);
    const crossSite = new NextRequest(`${base}?installationId=install-b`, { headers: { cookie: 'magnus_session=signed', 'sec-fetch-site': 'cross-site' } });
    expect((await GET(crossSite, context())).status).toBe(403);
    const opaque = new NextRequest(`${base}?installationId=install-b`, { headers: { cookie: 'magnus_session=signed', origin: 'null' } });
    expect((await GET(opaque, context())).status).toBe(403);
  });

  it('serves frame pages sandboxed, from the grant alone, with no console cookies either way', async () => {
    const grant = await mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    mocks.ssh.mockResolvedValue(upstream(html, 'text/html; charset=utf-8'));
    // No console cookie at all, and an installationId that names another installation.
    const req = new NextRequest(`${base}/_frame/${grant}/?installationId=install-b`, { headers: { origin: 'null' } });
    const response = await GET(req, context(['_frame', grant]));
    expect(response.status).toBe(200);
    expect(mocks.ssh.mock.calls[0]![0].installation.id).toBe('install-a');
    expect(mocks.ssh.mock.calls[0]![0].search).toBe('');
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toMatch(/^sandbox /);
    expect(policy).not.toContain('allow-same-origin');
    expect(response.headers.get('access-control-allow-origin')).toBe('null');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.getSetCookie()).toEqual([]);
    const text = await response.text();
    expect(text).toContain(`src="/api/hermes/dashboard/_frame/${grant}/assets/index.js"`);
    expect(text).toContain(`href="/api/hermes/dashboard/_frame/${grant}/sessions"`);
    expect(text.indexOf('localStorage')).toBeLessThan(text.indexOf('__HERMES_SESSION_TOKEN__'));
  });

  it('authorizes later frame API calls with the dashboard token it kept server-side', async () => {
    const grant = await mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    mocks.ssh.mockResolvedValueOnce(upstream(html, 'text/html'));
    await GET(new NextRequest(`${base}/_frame/${grant}/`), context(['_frame', grant]));
    mocks.ssh.mockResolvedValueOnce(upstream('{"ok":true}', 'application/json'));
    const response = await POST(new NextRequest(`${base}/_frame/${grant}/api/status`, {
      method: 'POST', body: '{}', headers: { origin: 'null', cookie: 'magnus_session=signed', 'content-type': 'application/json' },
    }), context(['_frame', grant, 'api', 'status']));
    expect(response.status).toBe(200);
    const call = mocks.ssh.mock.calls[1]![0];
    expect(call.upstreamPath).toBe('/api/status');
    expect(call.headers.authorization).toBe('Bearer fixture-hermes-token');
    expect(call.headers.cookie).toBeUndefined();
  });

  it('refuses a missing, foreign or revoked grant without reaching the node', async () => {
    const router = await mintFrameGrant({ app: 'router', session });
    for (const grant of ['not-a-grant', router]) {
      const response = await GET(new NextRequest(`${base}/_frame/${grant}/api/status`, { headers: { cookie: 'magnus_session=signed' } }), context(['_frame', grant, 'api', 'status']));
      expect(response.status).toBe(401);
    }
    const grant = await mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    mocks.live = false;
    expect((await GET(new NextRequest(`${base}/_frame/${grant}/`), context(['_frame', grant]))).status).toBe(401);
    expect(mocks.ssh).not.toHaveBeenCalled();
  });

  it('answers the sandboxed page preflight', async () => {
    const response = await OPTIONS(new NextRequest(`${base}/_frame/g/api/status`, {
      method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-headers': 'x-hermes-session-token' },
    }), context(['_frame', 'g', 'api', 'status']));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('null');
    expect(response.headers.get('access-control-allow-headers')).toBe('x-hermes-session-token');
  });
});
