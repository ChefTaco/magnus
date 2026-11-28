/**
 * Reverse proxy for the Hive Router admin UI.
 *
 * Older routers serve their own Vite admin app on the standalone admin plane. Magnus UI
 * serves it through this proxy so browsers do not need direct access
 * to the router host or its private-CA certificate.
 *
 * Optional: responds 503 until HIVE_ROUTER_ADMIN_URL is configured. Deprecated: current Emberpath
 * releases have no admin UI of their own, and the proxy goes away in the next major.
 *
 * Isolated like the Hermes dashboard (`runtime-embed-isolation.mjs`): the entry URL needs the
 * console session and redirects to a frame URL carrying a grant; frame responses are sandboxed
 * into an opaque origin and authorized by the grant alone. The router's own cookies are kept
 * server-side per console session, because an opaque-origin page cannot store them.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, COOKIE_NAME, type SessionPayload } from '@/lib/auth';
import { hiveRouterFetch } from '@/lib/hive-router-fetch';
import { readLimitedBytes, RequestBodyTooLarge } from '@/lib/limited-request-body';
import { readDashboardEnvironment } from '../../../../../../runtime-environment.mjs';
import { hiveRouterAdminUrl } from '../../../../../../runtime-integrations.mjs';
import {
  FRAME_SEGMENT,
  applyFrameHeaders,
  frameEntryAllowed,
  framePreflightHeaders,
  injectFrameCompat,
  mintFrameGrant,
  splitFrameSegments,
  verifyFrameGrant,
} from '../../../../../../runtime-embed-isolation.mjs';

const PROXY_BASE = '/api/hive-router/dashboard';
/** Largest router response the proxy reads (the admin UI's bundles are well below it). */
const MAX_ROUTER_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_JAR_SESSIONS = 256;
const MAX_JAR_COOKIES = 32;
const MAX_COOKIE_BYTES = 4096;

/** Router cookies per console session (the router's admin login and CSRF cookies). */
const cookieJars: Map<string, Map<string, string>> = ((globalThis as { __magnusRouterCookieJars?: Map<string, Map<string, string>> })
  .__magnusRouterCookieJars ??= new Map());

function jarFor(sessionId: string): Map<string, string> {
  let jar = cookieJars.get(sessionId);
  if (jar) {
    cookieJars.delete(sessionId);
  } else {
    jar = new Map();
    while (cookieJars.size >= MAX_JAR_SESSIONS) cookieJars.delete(cookieJars.keys().next().value as string);
  }
  cookieJars.set(sessionId, jar);
  return jar;
}

/** Keep a router Set-Cookie in the session's jar (or drop it when the router expires it). */
function storeRouterCookie(jar: Map<string, string>, setCookie: string): void {
  const [pair = '', ...attributes] = setCookie.split(';');
  const index = pair.indexOf('=');
  if (index <= 0) return;
  const name = pair.slice(0, index).trim();
  const value = pair.slice(index + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || Buffer.byteLength(value) > MAX_COOKIE_BYTES) return;
  const expired = attributes.some((attribute) => {
    const [key = '', raw = ''] = attribute.split('=').map((part) => part.trim());
    if (key.toLowerCase() === 'max-age') return Number(raw) <= 0;
    if (key.toLowerCase() === 'expires') return Date.parse(raw) <= Date.now();
    return false;
  });
  if (expired || value === '') {
    jar.delete(name);
    return;
  }
  if (!jar.has(name) && jar.size >= MAX_JAR_COOKIES) return;
  jar.set(name, value);
}

function jarCookieHeader(jar: Map<string, string>): string | undefined {
  if (jar.size === 0) return undefined;
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function requireSession(req: NextRequest): Promise<SessionPayload | NextResponse> {
  const sessionToken = req.cookies.get(COOKIE_NAME)?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return session;
}

/** Rewrite root-relative asset and API URLs onto the frame base, in one pass (never twice). */
function rewriteTextAsset(text: string, frameBase: string): string {
  return text.replace(/(["'`])\/(assets|api|api-docs)\//g, (_match, quote: string, prefix: string) => `${quote}${frameBase}/${prefix}/`);
}

function shouldRewrite(contentType: string): boolean {
  return contentType.includes('text/html')
    || contentType.includes('javascript')
    || contentType.includes('text/css');
}

function frameJson(req: NextRequest, body: unknown, status: number): NextResponse {
  const headers = applyFrameHeaders(new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' }), req.headers.get('origin'));
  return new NextResponse(JSON.stringify(body), { status, headers });
}

/** Entry: a console-session request. Mint a grant and redirect into the frame. */
async function enterFrame(req: NextRequest, path: string[] | undefined): Promise<NextResponse> {
  const session = await requireSession(req);
  if (session instanceof NextResponse) return session;
  if (!frameEntryAllowed(req.headers)) {
    return NextResponse.json({ error: 'cross_site_request_refused' }, { status: 403 });
  }
  if (!hiveRouterAdminUrl()) {
    return NextResponse.json(
      { error: 'Hive Router is not configured. Set HIVE_ROUTER_ADMIN_URL to enable it.' },
      { status: 503 },
    );
  }
  const grant = await mintFrameGrant({ app: 'router', session });
  const url = req.nextUrl.clone();
  url.pathname = `${PROXY_BASE}/${FRAME_SEGMENT}/${grant}/${(path ?? []).join('/')}`;
  const response = NextResponse.redirect(url, 307);
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

async function proxyHandler(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  const frame = splitFrameSegments(path);
  if (!frame) return enterFrame(req, path);

  // Frame request: the grant is the only authority. Console cookies are ignored.
  const grant = await verifyFrameGrant(frame.grant, 'router');
  if (!grant) return frameJson(req, { error: 'frame_grant_invalid' }, 401);

  const routerBase = hiveRouterAdminUrl();
  if (!routerBase) {
    return frameJson(req, { error: 'Hive Router is not configured. Set HIVE_ROUTER_ADMIN_URL to enable it.' }, 503);
  }

  const frameBase = `${PROXY_BASE}/${FRAME_SEGMENT}/${frame.grant}`;
  const search = req.nextUrl.searchParams.toString();
  const targetUrl = `${routerBase}/${frame.rest.join('/')}${search ? `?${search}` : ''}`;

  const headers: Record<string, string> = {};
  for (const header of ['accept', 'content-type', 'x-trace-id']) {
    const value = req.headers.get(header);
    if (value) headers[header] = value;
  }
  const jar = jarFor(grant.sessionId);
  const routerCookie = jarCookieHeader(jar);
  if (routerCookie) headers.cookie = routerCookie;

  const init: RequestInit = {
    method: req.method,
    headers,
    cache: 'no-store',
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      const body = await readLimitedBytes(req, Number(readDashboardEnvironment('DASHBOARD_PROXY_BODY_LIMIT_BYTES')));
      if (body.byteLength) init.body = body as BodyInit;
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) return frameJson(req, { error: 'Request body too large' }, 413);
      throw error;
    }
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
    applyFrameHeaders(responseHeaders, req.headers.get('origin'));

    // Every cookie the router sets stays server-side, in this console session's jar.
    for (const cookie of upstream.headers.getSetCookie()) storeRouterCookie(jar, cookie);

    const location = upstream.headers.get('location');
    if (location?.startsWith('/')) responseHeaders.set('Location', `${frameBase}${location}`);

    const body = await readLimitedBytes(upstream, MAX_ROUTER_RESPONSE_BYTES);
    if (shouldRewrite(contentType)) {
      let text = rewriteTextAsset(new TextDecoder().decode(body), frameBase);
      if (contentType.includes('text/html')) text = injectFrameCompat(text);
      return new NextResponse(text, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    return new NextResponse(body as BodyInit, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    if (err instanceof RequestBodyTooLarge) return frameJson(req, { error: 'Router response too large' }, 502);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return frameJson(req, { error: `Hive Router unreachable: ${message}` }, 502);
  }
}

/** CORS preflight from the sandboxed (opaque-origin) router UI. */
export async function OPTIONS(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  if (!splitFrameSegments(path)) return new NextResponse(null, { status: 405, headers: { allow: 'GET, HEAD, POST, PUT, PATCH, DELETE' } });
  return new NextResponse(null, { status: 204, headers: framePreflightHeaders(req.headers) });
}

export const GET = proxyHandler;
export const POST = proxyHandler;
export const PUT = proxyHandler;
export const PATCH = proxyHandler;
export const DELETE = proxyHandler;
