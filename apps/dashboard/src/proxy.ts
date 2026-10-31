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

export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // This exact internal endpoint authenticates its dedicated machine credential in the handler.
  if (pathname === '/api/internal/resource-enrollment/drain' && req.method === 'POST') return NextResponse.next();

  // Allow public paths and static assets
  if (
    PUBLIC_PATHS.some((p) => pathname === p) ||
    pathname.startsWith('/governor/share/') ||
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
