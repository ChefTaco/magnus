import { verifyLocalSession } from '@/lib/local-sessions';
import { hiveCredential } from '@/lib/hive-login';
import type { SessionPayload } from '@/lib/auth';
/**
 * Next.js proxy — protects all dashboard routes behind authentication.
 *
 * Checks for a valid `magnus_session` JWT cookie. If missing or expired,
 * redirects to /login. Static assets and explicitly public routes are excluded.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { COOKIE_NAME, getSecretKey, sessionVerificationOptions } from '@/lib/auth-constants';
import { securityConsoleDeepLink } from '@/lib/security-console-route';
import { applyFrameHeaders, parseFramePath, verifyFrameGrant } from '../runtime-embed-isolation.mjs';

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/health',
  '/api/auth/hive/start',
  '/api/auth/hive/callback',
  '/api/auth/hive/configured',
];

function unauthenticatedResponse(req: NextRequest, clearCookie = false): NextResponse {
  const response = req.nextUrl.pathname.startsWith('/api/')
    ? NextResponse.json({ error: 'authentication_required' }, { status: 401 })
    : NextResponse.redirect(new URL('/login', req.url));
  if (clearCookie) response.cookies.set(COOKIE_NAME, '', { maxAge: 0, path: '/' });
  return response;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request check for cookie-authenticated state changes. `SameSite=Lax` does not stop a
 * sibling subdomain (suite apps often share a parent domain), so every non-safe /api request must
 * come from this console: an `Origin` equal to `DASHBOARD_PUBLIC_ORIGIN` or to the request's own
 * host, or, without `Origin`, a `Sec-Fetch-Site` of `same-origin` or `none`. Clients that send
 * neither header (curl, scripts) are not browsers and cannot carry a forged cookie request.
 */
export function crossSiteRequest(req: NextRequest): boolean {
  if (SAFE_METHODS.has(req.method) || !req.nextUrl.pathname.startsWith('/api/')) return false;
  const origin = req.headers.get('origin');
  if (origin !== null) {
    if (origin === 'null') return true;
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return true; }
    const configured = process.env['DASHBOARD_PUBLIC_ORIGIN'];
    if (configured) { try { if (new URL(configured).origin === parsed.origin) return false; } catch { /* invalid setting */ } }
    const host = req.headers.get('host');
    return !(host && parsed.host === host && parsed.protocol === req.nextUrl.protocol);
  }
  const site = req.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}

/**
 * Cross-site reads of the console API. A sandboxed embedded dashboard runs in an opaque origin
 * (`Origin: null`, `Sec-Fetch-Site: cross-site`); none of its fetches, image or script loads may
 * reach a console API, whatever cookies the browser attaches. Navigations (an identity
 * provider's redirect back to the login callback) and the public endpoints stay reachable.
 */
export function crossSiteRead(req: NextRequest): boolean {
  if (!SAFE_METHODS.has(req.method) || !req.nextUrl.pathname.startsWith('/api/')) return false;
  if (PUBLIC_PATHS.includes(req.nextUrl.pathname)) return false;
  if (req.headers.get('origin') === 'null') return true;
  if (req.headers.get('sec-fetch-mode') === 'navigate') return false;
  const site = req.headers.get('sec-fetch-site');
  return site === 'cross-site' || site === 'same-site';
}

export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // Embedded dashboard frames are authorized by their grant alone, never by console cookies.
  const frame = parseFramePath(pathname);
  if (frame) {
    if (req.method === 'OPTIONS') return NextResponse.next();
    if (await verifyFrameGrant(frame.grant, frame.app)) return NextResponse.next();
    const refused = NextResponse.json({ error: 'frame_grant_invalid' }, { status: 401 });
    applyFrameHeaders(refused.headers, req.headers.get('origin'));
    return refused;
  }

  if (crossSiteRequest(req) || crossSiteRead(req)) {
    return NextResponse.json({ error: 'cross_site_request_refused' }, { status: 403 });
  }

  // Allow public paths and static assets
  if (
    PUBLIC_PATHS.some((p) => pathname === p) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname === '/icon.svg'
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;

  if (!token) {
    return unauthenticatedResponse(req);
  }

  try {
    const { payload } = await jwtVerify(token, getSecretKey(), sessionVerificationOptions());
    if (!(await verifyLocalSession(payload as unknown as SessionPayload)))
      return unauthenticatedResponse(req, true);
    if (payload['provider'] === 'hive') {
      await hiveCredential(payload as unknown as SessionPayload, process.env['CONTROL_API_URL']!);
      // Local SSH, host administration and embedded admin gateways use a
      // separate authority. Named sessions delegate only through the API.
      if (
        pathname.startsWith('/api/') &&
        !pathname.startsWith('/api/proxy/') &&
        !['/api/auth/me', '/api/auth/logout'].includes(pathname)
      ) {
        return NextResponse.json(
          { error: 'Use the Control API delegated workflow' },
          { status: 403 },
        );
      }
    }
    return securityConsoleDeepLink(req.nextUrl) ?? NextResponse.next();
  } catch {
    // API clients need a real 401 instead of following an HTML login redirect.
    return unauthenticatedResponse(req, true);
  }
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
