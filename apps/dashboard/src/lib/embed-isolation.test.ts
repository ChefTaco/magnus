import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

const sessions = vi.hoisted(() => ({ live: new Set<string>() }));
vi.mock('../../runtime-local-sessions.mjs', () => ({
  verifyLocalSession: async (session: { sessionId?: string }) => sessions.live.has(session.sessionId ?? ''),
}));

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-0123456789abcdef';
const isolation = await import('../../runtime-embed-isolation.mjs');
const { HERMES_FRAME_SANDBOX } = await import('@/components/orchestra/hermes-dashboard-frame');
const nextConfig = (await import('../../next.config')).default;

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const session = { username: 'admin', sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 };

describe('embedded dashboard frame grants', () => {
  beforeEach(() => { sessions.live.clear(); sessions.live.add(SESSION_ID); });

  it('round-trips a grant scoped to one dashboard and installation', async () => {
    const grant = await isolation.mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    await expect(isolation.verifyFrameGrant(grant, 'hermes')).resolves.toMatchObject({
      app: 'hermes', username: 'admin', sessionId: SESSION_ID, installationId: 'install-a', expired: false, sessionExpiresAt: session.exp,
    });
    // A Hermes grant does not open the router proxy, and the reverse.
    await expect(isolation.verifyFrameGrant(grant, 'router')).resolves.toBeNull();
    const router = await isolation.mintFrameGrant({ app: 'router', session });
    await expect(isolation.verifyFrameGrant(router, 'hermes')).resolves.toBeNull();
  });

  it('lives minutes, not as long as the console session', async () => {
    const grant = await isolation.mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    const verified = await isolation.verifyFrameGrant(grant, 'hermes');
    const lifetime = verified!.expiresAt - Math.floor(Date.now() / 1000);
    expect(lifetime).toBeLessThanOrEqual(isolation.FRAME_GRANT_TTL_SECONDS);
    expect(isolation.FRAME_GRANT_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
    // Never past the session itself.
    const short = await isolation.mintFrameGrant({ app: 'hermes', session: { ...session, exp: Math.floor(Date.now() / 1000) + 30 } });
    expect((await isolation.verifyFrameGrant(short, 'hermes'))!.expiresAt).toBe(Math.floor(Date.now() / 1000) + 30);
  });

  it('dies with the console session that minted it', async () => {
    const grant = await isolation.mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    sessions.live.clear();
    await expect(isolation.verifyFrameGrant(grant, 'hermes')).resolves.toBeNull();
  });

  it('expires with the console session and refuses tampering or a session cookie', async () => {
    const expired = await isolation.mintFrameGrant({ app: 'hermes', installationId: 'install-a', session: { ...session, exp: Math.floor(Date.now() / 1000) - 5 } });
    await expect(isolation.verifyFrameGrant(expired, 'hermes')).resolves.toBeNull();
    // An expired session is not revived even where an expired grant is otherwise accepted.
    await expect(isolation.verifyFrameGrant(expired, 'hermes', { allowExpired: true })).resolves.toBeNull();
    const grant = await isolation.mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    await expect(isolation.verifyFrameGrant(`${grant}x`, 'hermes')).resolves.toBeNull();
    // A console session token, signed with the session secret itself, is not a grant.
    const cookie = await new SignJWT({ app: 'hermes', u: 'admin', sid: SESSION_ID, ins: 'install-a' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('magnus-dashboard').setAudience('magnus-embedded-dashboard').setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env['SESSION_SECRET']!));
    await expect(isolation.verifyFrameGrant(cookie, 'hermes')).resolves.toBeNull();
  });

  it('is never minted for a named (Hive) session', async () => {
    await expect(isolation.mintFrameGrant({ app: 'hermes', session: { ...session, provider: 'hive' } })).rejects.toThrow();
    await expect(isolation.mintFrameGrant({ app: 'hermes', session: { username: 'admin', exp: session.exp } })).rejects.toThrow();
  });
});

describe('expired frame grants', () => {
  beforeEach(() => { sessions.live.clear(); sessions.live.add(SESSION_ID); vi.useRealTimers(); });

  async function expiredGrant() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - (isolation.FRAME_GRANT_TTL_SECONDS + 60) * 1000);
    const grant = await isolation.mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    vi.useRealTimers();
    return grant;
  }
  const decide = (grant: string, method: string, upstreamPath: string, headers: Record<string, string> = {}) =>
    isolation.frameGrantDecision({ grant, app: 'hermes', method, headers: new Headers(headers), upstreamPath });

  it('refuses API calls and sockets, serves static build files, and re-mints only navigations', async () => {
    const grant = await expiredGrant();
    await expect(isolation.verifyFrameGrant(grant, 'hermes')).resolves.toBeNull();
    expect((await decide(grant, 'GET', '/api/status')).action).toBe('refuse');
    expect((await decide(grant, 'POST', '/api/status', { 'sec-fetch-mode': 'navigate' })).action).toBe('refuse');
    expect((await decide(grant, 'GET', '/assets/index-abc.js')).action).toBe('allow');
    expect((await decide(grant, 'GET', '/assets/../api/status')).action).toBe('refuse');
    expect((await decide(grant, 'GET', '/dashboard-plugins/kanban/index.js')).action).toBe('allow');
    expect((await decide(grant, 'GET', '/dashboard-plugins/kanban/api/items')).action).toBe('refuse');
    expect((await decide(grant, 'GET', '/sessions', { 'sec-fetch-mode': 'navigate' })).action).toBe('remint');
    // Not once the console session is gone.
    sessions.live.clear();
    expect((await decide(grant, 'GET', '/assets/index-abc.js')).action).toBe('refuse');
    expect((await decide(grant, 'GET', '/sessions', { 'sec-fetch-mode': 'navigate' })).action).toBe('refuse');
  });
});

describe('server-side dashboard state', () => {
  it('keeps tokens per console session and forgets them on sign-out', () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    isolation.frameSessionState({ sessionId: 'session-a', sessionExpiresAt: exp }).hermesTokens.set('install-a', 'token-a');
    isolation.frameSessionState({ sessionId: 'session-b', sessionExpiresAt: exp }).routerCookies.set('admin', 'b');
    expect(isolation.peekFrameSessionState('session-b')?.hermesTokens.size).toBe(0);
    isolation.clearFrameSessionState('session-a');
    expect(isolation.peekFrameSessionState('session-a')).toBeNull();
    expect(isolation.peekFrameSessionState('session-b')?.routerCookies.get('admin')).toBe('b');
    isolation.clearFrameSessionState();
    expect(isolation.peekFrameSessionState('session-b')).toBeNull();
  });

  it('swaps only the placeholder token for the real one', () => {
    expect(isolation.swapFrameToken(`token=${isolation.FRAME_TOKEN_PLACEHOLDER}&x=1`, 'real')).toBe('token=real&x=1');
    expect(isolation.swapFrameToken('?token=other', 'real')).toBe('token=other');
    expect(isolation.swapFrameToken(`token=${isolation.FRAME_TOKEN_PLACEHOLDER}`, undefined)).toBe(`token=${isolation.FRAME_TOKEN_PLACEHOLDER}`);
  });
});

describe('embedded dashboard paths and headers', () => {
  it('splits a frame path into the grant and the upstream path', () => {
    expect(isolation.parseFramePath('/api/hermes/dashboard/_frame/abc.def/api/ws')).toEqual({
      app: 'hermes', base: '/api/hermes/dashboard', grant: 'abc.def',
      frameBase: '/api/hermes/dashboard/_frame/abc.def', upstreamPath: '/api/ws',
    });
    expect(isolation.parseFramePath('/api/hive-router/dashboard/_frame/g')?.upstreamPath).toBe('/');
    expect(isolation.parseFramePath('/api/hermes/dashboard/api/ws')).toBeNull();
    expect(isolation.parseFramePath('/api/proxy/_frame/abc/nodes')).toBeNull();
    expect(isolation.splitFrameSegments(['_frame', 'g', 'api', 'x'])).toEqual({ grant: 'g', rest: ['api', 'x'] });
    expect(isolation.splitFrameSegments(['api', 'x'])).toBeNull();
  });

  it('lets only the console itself or the operator open a dashboard', () => {
    const headers = (values: Record<string, string>) => new Headers(values);
    expect(isolation.frameEntryAllowed(headers({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isolation.frameEntryAllowed(headers({ 'sec-fetch-site': 'none' }))).toBe(true);
    expect(isolation.frameEntryAllowed(headers({}))).toBe(true);
    // A sandboxed dashboard navigating to another installation's entry URL is cross-site.
    expect(isolation.frameEntryAllowed(headers({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isolation.frameEntryAllowed(headers({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isolation.frameEntryAllowed(headers({ origin: 'null' }))).toBe(false);
  });

  it('sandboxes every response without allow-same-origin and sets no cookies', () => {
    const headers = new Headers({ 'set-cookie': 'magnus_session=x' });
    isolation.applyFrameHeaders(headers, 'null');
    const policy = headers.get('content-security-policy') ?? '';
    expect(policy).toMatch(/^sandbox allow-scripts /);
    expect(policy).not.toContain('allow-same-origin');
    expect(policy).not.toContain('allow-top-navigation');
    expect(policy).not.toContain('allow-popups-to-escape-sandbox');
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('access-control-allow-origin')).toBe('null');
    expect(headers.get('access-control-allow-credentials')).toBe('true');
    // Only an opaque origin gets CORS: a real foreign origin is never allowed.
    const foreign = isolation.applyFrameHeaders(new Headers(), 'https://evil.example.com');
    expect(foreign.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps the console frame, the Next.js headers and the route policy in step', async () => {
    expect(HERMES_FRAME_SANDBOX).toBe(isolation.EMBED_IFRAME_SANDBOX);
    expect(HERMES_FRAME_SANDBOX).not.toContain('allow-same-origin');
    const rules = await nextConfig.headers!();
    for (const source of ['/api/hermes/dashboard', '/api/hermes/dashboard/:path+', '/api/hive-router/dashboard', '/api/hive-router/dashboard/:path+']) {
      const rule = rules.find((entry) => entry.source === source)!;
      expect(rule.headers.find((header) => header.key === 'Content-Security-Policy')?.value, source).toBe(isolation.EMBED_CONTENT_SECURITY_POLICY);
      expect(rule.headers.find((header) => header.key === 'Referrer-Policy')?.value, source).toBe('no-referrer');
    }
  });

  it('answers a preflight with only well-formed header names', () => {
    const ok = isolation.framePreflightHeaders(new Headers({ origin: 'null', 'access-control-request-headers': 'content-type, x-hermes-session-token' }));
    expect(ok.get('access-control-allow-headers')).toBe('content-type, x-hermes-session-token');
    expect(ok.get('access-control-allow-origin')).toBe('null');
    const bad = isolation.framePreflightHeaders(new Headers({ origin: 'null', 'access-control-request-headers': 'x-a, x b;c' }));
    expect(bad.get('access-control-allow-headers')).toBeNull();
  });

  it('ships a compatibility script that parses', () => {
    const body = isolation.FRAME_COMPAT_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
    expect(() => new Function(body)).not.toThrow();
    expect(body).toContain('magnus-frame-refresh');
  });

  it('puts the storage stand-in before the page scripts', () => {
    const html = isolation.injectFrameCompat('<!doctype html><html><head><meta charset="utf-8"><script src="/a.js"></script></head></html>');
    expect(html.indexOf(isolation.FRAME_COMPAT_SCRIPT)).toBeLessThan(html.indexOf('/a.js'));
    expect(html.startsWith('<!doctype html><html><head>')).toBe(true);
    expect(isolation.injectFrameCompat('<p>x</p>').startsWith(isolation.FRAME_COMPAT_SCRIPT)).toBe(true);
  });
});
