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
    await expect(isolation.verifyFrameGrant(grant, 'hermes')).resolves.toEqual({
      app: 'hermes', username: 'admin', sessionId: SESSION_ID, installationId: 'install-a',
    });
    // A Hermes grant does not open the router proxy, and the reverse.
    await expect(isolation.verifyFrameGrant(grant, 'router')).resolves.toBeNull();
    const router = await isolation.mintFrameGrant({ app: 'router', session });
    await expect(isolation.verifyFrameGrant(router, 'hermes')).resolves.toBeNull();
  });

  it('dies with the console session that minted it', async () => {
    const grant = await isolation.mintFrameGrant({ app: 'hermes', installationId: 'install-a', session });
    sessions.live.clear();
    await expect(isolation.verifyFrameGrant(grant, 'hermes')).resolves.toBeNull();
  });

  it('expires with the console session and refuses tampering or a session cookie', async () => {
    const expired = await isolation.mintFrameGrant({ app: 'hermes', installationId: 'install-a', session: { ...session, exp: Math.floor(Date.now() / 1000) - 5 } });
    await expect(isolation.verifyFrameGrant(expired, 'hermes')).resolves.toBeNull();
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

  it('puts the storage stand-in before the page scripts', () => {
    const html = isolation.injectFrameCompat('<!doctype html><html><head><meta charset="utf-8"><script src="/a.js"></script></head></html>');
    expect(html.indexOf(isolation.FRAME_COMPAT_SCRIPT)).toBeLessThan(html.indexOf('/a.js'));
    expect(html.startsWith('<!doctype html><html><head>')).toBe(true);
    expect(isolation.injectFrameCompat('<p>x</p>').startsWith(isolation.FRAME_COMPAT_SCRIPT)).toBe(true);
  });
});
