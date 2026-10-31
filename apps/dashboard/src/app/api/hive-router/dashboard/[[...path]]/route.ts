/**
 * Reverse proxy for the Hive Router admin UI.
 *
 * The router owns its own Vite admin app on the standalone admin plane. Magnus UI
 * embeds it through this same-origin proxy so browsers do not need direct access
 * to the router host or its private-CA certificate.
 *
 * Optional: responds 503 until HIVE_ROUTER_ADMIN_URL is configured.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, COOKIE_NAME } from '@/lib/auth';
import { hiveRouterFetch } from '@/lib/hive-router-fetch';
import { hiveRouterAdminUrl } from '../../../../../../runtime-integrations.mjs';

const PROXY_BASE = '/api/hive-router/dashboard';
const ROUTER_SESSION_COOKIE = 'hive_router_admin';

async function assertDashboardSession(req: NextRequest): Promise<NextResponse | null> {
  const sessionToken = req.cookies.get(COOKIE_NAME)?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}

function upstreamPath(path?: string[]): string {
  if (!path || path.length === 0) return '/';
  return `/${path.join('/')}`;
}

function rewriteTextAsset(text: string): string {
  return text
    .replaceAll('"/assets/', `"${PROXY_BASE}/assets/`)
    .replaceAll("'/assets/", `'${PROXY_BASE}/assets/`)
    .replaceAll('`/assets/', `\`${PROXY_BASE}/assets/`)
    .replaceAll('"/api/', `"${PROXY_BASE}/api/`)
    .replaceAll("'/api/", `'${PROXY_BASE}/api/`)
    .replaceAll('`/api/', `\`${PROXY_BASE}/api/`)
    .replaceAll('"/api-docs/', `"${PROXY_BASE}/api-docs/`)
    .replaceAll("'/api-docs/", `'${PROXY_BASE}/api-docs/`)
    .replaceAll('`/api-docs/', `\`${PROXY_BASE}/api-docs/`);
}

function shouldRewrite(contentType: string): boolean {
  return contentType.includes('text/html')
    || contentType.includes('javascript')
    || contentType.includes('text/css');
}

function routerCookieHeader(req: NextRequest): string | undefined {
  const value = req.cookies.get(ROUTER_SESSION_COOKIE)?.value;
  return value ? `${ROUTER_SESSION_COOKIE}=${value}` : undefined;
}

function rewriteSetCookiePath(value: string): string {
  if (/;\s*path=/i.test(value)) {
    return value.replace(/;\s*path=[^;]*/i, `; Path=${PROXY_BASE}`);
  }
  return `${value}; Path=${PROXY_BASE}`;
}

async function proxyHandler(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const unauthorized = await assertDashboardSession(req);
  if (unauthorized) return unauthorized;

  const routerBase = hiveRouterAdminUrl();
  if (!routerBase) {
    return NextResponse.json(
      { error: 'Hive Router is not configured. Set HIVE_ROUTER_ADMIN_URL to enable it.' },
      { status: 503 },
    );
  }

  const { path } = await params;
  const search = req.nextUrl.searchParams.toString();
  const targetUrl = `${routerBase}${upstreamPath(path)}${search ? `?${search}` : ''}`;

  const headers: Record<string, string> = {};
  for (const header of ['accept', 'content-type', 'x-trace-id']) {
    const value = req.headers.get(header);
    if (value) headers[header] = value;
  }
  const routerCookie = routerCookieHeader(req);
  if (routerCookie) headers.cookie = routerCookie;

  const init: RequestInit = {
    method: req.method,
    headers,
    cache: 'no-store',
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await req.text();
    if (body) init.body = body;
  }

  try {
    const upstream = await hiveRouterFetch(targetUrl, {
      ...init,
      redirect: 'manual',
    });

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', contentType);
    responseHeaders.set('Cache-Control', 'no-cache, no-store');

    const setCookie = upstream.headers.get('set-cookie');
    if (setCookie) responseHeaders.set('Set-Cookie', rewriteSetCookiePath(setCookie));

    if (shouldRewrite(contentType)) {
      return new NextResponse(rewriteTextAsset(await upstream.text()), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Hive Router unreachable: ${message}` },
      { status: 502 },
    );
  }
}

export const GET = proxyHandler;
export const POST = proxyHandler;
export const PUT = proxyHandler;
export const PATCH = proxyHandler;
export const DELETE = proxyHandler;
