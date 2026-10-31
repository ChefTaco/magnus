import { type NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, COOKIE_NAME } from '@/lib/auth';
import { orchestraFetch } from '@/lib/orchestra-fetch';
import type { HermesInstallation } from '@/types/orchestra';
import { requestHermesDashboardOverSsh } from '@/lib/hermes-ssh-proxy';
import { chooseHermesInstallation, normalizeHermesInstallations } from '../../../../../../runtime-hermes-security.mjs';
import { hermesEnabled } from '../../../../../../runtime-integrations.mjs';

export const runtime = 'nodejs';

const PROXY_BASE = '/api/hermes/dashboard';
const DASHBOARD_INSTALLATION_COOKIE = 'magnus_hermes_dashboard_installation_id';
const DASHBOARD_SESSION_TOKEN_COOKIE = 'magnus_hermes_dashboard_session_token';
interface DashboardTarget {
  installation: HermesInstallation;
}

let installationCache: { data: HermesInstallation[]; expiresAt: number } | null = null;
let installationRequest: Promise<HermesInstallation[]> | null = null;

async function loadHermesInstallations(): Promise<HermesInstallation[]> {
  if (installationCache && installationCache.expiresAt > Date.now()) return installationCache.data;
  if (installationRequest) return installationRequest;
  installationRequest = (async () => {
    const res = await orchestraFetch<{ success: boolean; data: HermesInstallation[] }>('installations');
    const data = normalizeHermesInstallations(res.data) as HermesInstallation[];
    installationCache = { data, expiresAt: Date.now() + 5_000 };
    return data;
  })();
  try {
    return await installationRequest;
  } finally {
    installationRequest = null;
  }
}

async function requireSession(req: NextRequest): Promise<NextResponse | null> {
  const sessionToken = req.cookies.get(COOKIE_NAME)?.value;
  if (!sessionToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const session = await verifySessionToken(sessionToken);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return null;
}

function firstParam(req: NextRequest, name: string): string | null {
  const value = req.nextUrl.searchParams.get(name);
  return value && value.trim() ? value.trim() : null;
}

async function resolveDashboardTarget(req: NextRequest): Promise<{ target: DashboardTarget | null; error: string | null }> {
  const installationId = firstParam(req, 'installationId');
  const nodeId = firstParam(req, 'nodeId');
  const cookieInstallationId = req.cookies.get(DASHBOARD_INSTALLATION_COOKIE)?.value ?? null;

  try {
    const selection = chooseHermesInstallation(
      await loadHermesInstallations(),
      installationId,
      nodeId,
      cookieInstallationId,
    );
    return { target: selection.installation ? { installation: selection.installation as HermesInstallation } : null, error: selection.error };
  } catch (err) {
    const correlationId = crypto.randomUUID();
    console.error(`[hermes-target:${correlationId}] installation inventory failed`, err);
    return { target: null, error: 'control_api_unavailable' };
  }
}

function upstreamSearchParams(req: NextRequest): string {
  const params = new URLSearchParams(req.nextUrl.searchParams);
  params.delete('installationId');
  params.delete('nodeId');
  return params.toString();
}

function proxiedDashboardPath(path: string, installationId: string): string {
  if (path.startsWith('api/')) return `${PROXY_BASE}/${path}`;
  const separator = path.includes('?') ? '&' : '?';
  return `${PROXY_BASE}/${path}${separator}installationId=${encodeURIComponent(installationId)}`;
}

function rewriteDashboardText(text: string, installationId: string): string {
  const alreadyProxied = 'api/hermes/dashboard';
  return text
    .replaceAll('}/dashboard-plugins/${', '}' + PROXY_BASE + '/dashboard-plugins/${')
    .replace(/(dashboard-plugins\/[^`"']+)([`"'])/g, (_match, path: string, quote: string) => {
      if (path.includes('installationId=')) return `${path}${quote}`;
      return `${path}?installationId=${encodeURIComponent(installationId)}${quote}`;
    })
    .replace(/\b(href|src|action)=(["'])\/(?!api\/hermes\/dashboard(?:\/|$))([^"']*)/g, (_match, attr: string, quote: string, path: string) => {
      return `${attr}=${quote}${proxiedDashboardPath(path, installationId)}`;
    })
    .replace(/(["'`])\/(?!api\/hermes\/dashboard(?:\/|$))((?:api\/|ws(?:\/|$)|assets\/|dashboard-plugins\/|favicon\.ico)[^"'`]*)/g, (_match, quote: string, path: string) => {
      if (path.startsWith(alreadyProxied)) return `${quote}/${path}`;
      return `${quote}${proxiedDashboardPath(path, installationId)}`;
    })
    .replace(/url\((['"]?)\/(assets\/|fonts-terminal\/)([^)'"]+)\1\)/g, (_match, quote: string, prefix: string, path: string) => {
      return `url(${quote}${proxiedDashboardPath(`${prefix}${path}`, installationId)}${quote})`;
    });
}

function responseHeaders(contentType: string): Headers {
  const headers = new Headers();
  headers.set('content-type', contentType);
  headers.set('cache-control', 'no-cache, no-store');
  headers.set('content-security-policy', "frame-ancestors 'self'");
  headers.set('x-frame-options', 'SAMEORIGIN');
  return headers;
}

function dashboardSessionToken(text: string): string | null {
  return text.match(/window\.__HERMES_SESSION_TOKEN__=\"([^\"]+)\"/)?.[1] ?? null;
}

function withDashboardCookie(response: NextResponse, installation: HermesInstallation | null, sessionToken?: string | null): NextResponse {
  if (installation) {
    response.cookies.set(DASHBOARD_INSTALLATION_COOKIE, installation.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
  }
  if (sessionToken) {
    response.cookies.set(DASHBOARD_SESSION_TOKEN_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
  }
  return response;
}

function rewriteRedirectLocation(req: NextRequest, installation: HermesInstallation, location: string): string {
  try {
    const upstream = new URL(location, `http://127.0.0.1:${installation.dashboardPort}`);
    if (upstream.hostname !== '127.0.0.1' && upstream.hostname !== 'localhost') return location;

    const proxyUrl = req.nextUrl.clone();
    proxyUrl.pathname = `${PROXY_BASE}${upstream.pathname}`;
    proxyUrl.search = upstream.search;
    return proxyUrl.toString();
  } catch {
    return location;
  }
}

async function proxyHandler(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;
  if (!hermesEnabled()) {
    return NextResponse.json({ error: 'Hermes Agent integration is not enabled. Set MAGNUS_HERMES_ENABLED=true to enable it.' }, { status: 503 });
  }

  const { path } = await params;
  const proxyPath = path?.join('/') ?? '';
  const upstreamPath = proxyPath ? `/${proxyPath}` : '/';
  const { target, error: selectionError } = await resolveDashboardTarget(req);
  if (!target) {
    return NextResponse.json(
      { success: false, error: selectionError ?? 'installation_unavailable' },
      { status: selectionError === 'installation_required' ? 400 : selectionError === 'control_api_unavailable' ? 502 : 404 },
    );
  }
  const search = upstreamSearchParams(req);

  const headers: Record<string, string> = {};
  const accept = req.headers.get('accept');
  if (accept) headers['accept'] = accept;
  const contentType = req.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  const authorization = req.headers.get('authorization');
  const dashboardSessionTokenValue = req.cookies.get(DASHBOARD_SESSION_TOKEN_COOKIE)?.value ?? null;
  if (authorization) headers['authorization'] = authorization;
  else if (dashboardSessionTokenValue) headers['authorization'] = `Bearer ${dashboardSessionTokenValue}`;

  const init: RequestInit = {
    method: req.method,
    headers,
    cache: 'no-store',
    redirect: 'manual',
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const bodyText = await req.text().catch(() => '');
    if (bodyText) init.body = bodyText;
  }

  try {
    const upstream = await requestHermesDashboardOverSsh({
      installation: target.installation,
      req,
      upstreamPath,
      search,
      body: init.body as string | undefined,
      headers,
    });
    const upstreamContentType = String(upstream.headers['content-type'] ?? 'application/octet-stream');

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers['location'];
      if (typeof location === 'string') {
        const response = NextResponse.redirect(
          rewriteRedirectLocation(req, target.installation, location),
          upstream.status,
        );
        return withDashboardCookie(response, target.installation);
      }
    }

    if (upstreamContentType.includes('text/') || upstreamContentType.includes('javascript') || upstreamContentType.includes('json')) {
      const text = upstream.body.toString('utf-8');
      const shouldRewrite = upstreamContentType.includes('html') || upstreamContentType.includes('javascript') || upstreamContentType.includes('json') || upstreamContentType.includes('css');
      return withDashboardCookie(new NextResponse(shouldRewrite ? rewriteDashboardText(text, target.installation.id) : text, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstreamContentType),
      }), target.installation, dashboardSessionToken(text));
    }

    return withDashboardCookie(new NextResponse(new Uint8Array(upstream.body), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstreamContentType),
    }), target.installation);
  } catch (err: unknown) {
    const correlationId = crypto.randomUUID();
    console.error(`[hermes-http:${correlationId}] dashboard proxy failed`, err);
    return NextResponse.json(
      { success: false, error: 'hermes_proxy_unavailable', correlationId },
      { status: 502, headers: { 'x-correlation-id': correlationId } },
    );
  }
}

export const GET = proxyHandler;
export const POST = proxyHandler;
export const PUT = proxyHandler;
export const PATCH = proxyHandler;
export const DELETE = proxyHandler;
