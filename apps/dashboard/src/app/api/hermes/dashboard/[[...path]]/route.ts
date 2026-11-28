import { type NextRequest, NextResponse } from 'next/server';
import { orchestraFetch } from '@/lib/orchestra-fetch';
import type { HermesInstallation } from '@/types/orchestra';
import { requestHermesDashboardOverSsh } from '@/lib/hermes-ssh-proxy';
import { chooseHermesInstallation, normalizeHermesInstallations } from '../../../../../../runtime-hermes-security.mjs';
import { hermesEnabled } from '../../../../../../runtime-integrations.mjs';
import { authorizeFrame, enterFrame as enterFrameWith, frameJson, requireConsoleSession } from '@/lib/embedded-frame';
import {
  FRAME_SEGMENT,
  FRAME_TOKEN_PLACEHOLDER,
  applyFrameHeaders,
  frameEntryAllowed,
  framePreflightHeaders,
  frameSessionState,
  injectFrameCompat,
  splitFrameSegments,
  swapFrameToken,
} from '../../../../../../runtime-embed-isolation.mjs';

export const runtime = 'nodejs';

/**
 * Reverse proxy for the Hermes dashboard of one installation, isolated from the console.
 *
 * The console's frame (or an operator's tab) opens the entry URL with its session cookie; the
 * proxy answers with a redirect to a frame URL that carries a short-lived grant for that one
 * installation (`runtime-embed-isolation.mjs`). Frame responses are sandboxed into an opaque
 * origin, so the dashboard's script never runs with console authority: frame requests are
 * authorized by the grant alone, and console cookies are neither read nor set on them.
 *
 * The dashboard's real session token never reaches the page: the proxy keeps it per console
 * session and installation, shows the page a placeholder, and sends the real one upstream.
 */
const PROXY_BASE = '/api/hermes/dashboard';
/** Cookies earlier releases set for the dashboard; cleared on entry. */
const LEGACY_DASHBOARD_COOKIES = ['magnus_hermes_dashboard_installation_id', 'magnus_hermes_dashboard_session_token'];
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

function firstParam(req: NextRequest, name: string): string | null {
  const value = req.nextUrl.searchParams.get(name);
  return value && value.trim() ? value.trim() : null;
}

async function resolveDashboardTarget(req: NextRequest): Promise<{ target: DashboardTarget | null; error: string | null }> {
  const installationId = firstParam(req, 'installationId');
  const nodeId = firstParam(req, 'nodeId');

  try {
    const selection = chooseHermesInstallation(await loadHermesInstallations(), installationId, nodeId, null);
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

/** Hermes's own token injection: `window.__HERMES_SESSION_TOKEN__="…"` (or JSON-quoted). */
const SESSION_TOKEN_PATTERN = /window\.__HERMES_SESSION_TOKEN__\s*=\s*(["'])([^"'\\]+)\1/;

function dashboardSessionToken(text: string): string | null {
  return SESSION_TOKEN_PATTERN.exec(text)?.[2] ?? null;
}

/** Replace every copy of the real token in what the sandboxed page receives. */
function withoutSessionToken(text: string, token: string | undefined): string {
  return token ? text.replaceAll(token, FRAME_TOKEN_PLACEHOLDER) : text;
}

/** Rewrite the dashboard's root-relative URLs onto this frame's base (`.../_frame/<grant>`). */
function rewriteDashboardText(text: string, frameBase: string): string {
  const alreadyProxied = 'api/hermes/dashboard';
  const proxied = (path: string) => `${frameBase}/${path}`;
  return text
    .replaceAll('}/dashboard-plugins/${', '}' + frameBase + '/dashboard-plugins/${')
    .replace(/\b(href|src|action)=(["'])\/(?!api\/hermes\/dashboard(?:\/|$))([^"']*)/g, (_match, attr: string, quote: string, path: string) => {
      return `${attr}=${quote}${proxied(path)}`;
    })
    .replace(/(["'`])\/(?!api\/hermes\/dashboard(?:\/|$))((?:api\/|ws(?:\/|$)|assets\/|dashboard-plugins\/|favicon\.ico)[^"'`]*)/g, (_match, quote: string, path: string) => {
      if (path.startsWith(alreadyProxied)) return `${quote}/${path}`;
      return `${quote}${proxied(path)}`;
    })
    .replace(/url\((['"]?)\/(assets\/|fonts-terminal\/)([^)'"]+)\1\)/g, (_match, quote: string, prefix: string, path: string) => {
      return `url(${quote}${proxied(`${prefix}${path}`)}${quote})`;
    });
}

function frameHeaders(req: NextRequest, contentType?: string): Headers {
  const headers = new Headers();
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-cache, no-store');
  return applyFrameHeaders(headers, req.headers.get('origin'));
}

function rewriteRedirectLocation(req: NextRequest, installation: HermesInstallation, frameBase: string, location: string): string {
  try {
    const upstream = new URL(location, `http://127.0.0.1:${installation.dashboardPort}`);
    if (upstream.hostname !== '127.0.0.1' && upstream.hostname !== 'localhost') return location;

    const proxyUrl = req.nextUrl.clone();
    proxyUrl.pathname = `${frameBase}${upstream.pathname}`;
    proxyUrl.search = upstream.search;
    return proxyUrl.toString();
  } catch {
    return location;
  }
}

/** Entry: a console-session request for the dashboard. Mint a grant and redirect into the frame. */
async function enterFrame(req: NextRequest, path: string[] | undefined): Promise<NextResponse> {
  const session = await requireConsoleSession(req);
  if (session instanceof NextResponse) return session;
  if (!frameEntryAllowed(req.headers)) {
    return NextResponse.json({ error: 'cross_site_request_refused' }, { status: 403 });
  }
  if (!hermesEnabled()) {
    return NextResponse.json({ error: 'Hermes Agent integration is not enabled. Set MAGNUS_HERMES_ENABLED=true to enable it.' }, { status: 503 });
  }
  const { target, error: selectionError } = await resolveDashboardTarget(req);
  if (!target) {
    return NextResponse.json(
      { success: false, error: selectionError ?? 'installation_unavailable' },
      { status: selectionError === 'installation_required' ? 400 : selectionError === 'control_api_unavailable' ? 502 : 404 },
    );
  }
  const response = await enterFrameWith(req, {
    app: 'hermes',
    session,
    installationId: target.installation.id,
    path: path ?? [],
    search: upstreamSearchParams(req),
  });
  for (const name of LEGACY_DASHBOARD_COOKIES) {
    if (req.cookies.has(name)) response.cookies.set(name, '', { maxAge: 0, path: '/' });
  }
  return response;
}

async function proxyHandler(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  const frame = splitFrameSegments(path);
  if (!frame) return enterFrame(req, path);

  // Frame request: the grant is the only authority. Console cookies are ignored (except to
  // re-mint an expired grant on a navigation, see authorizeFrame).
  const authorized = await authorizeFrame(req, { app: 'hermes', grant: frame.grant, rest: frame.rest });
  if (authorized instanceof NextResponse) return authorized;
  const { grant, upstreamPath } = authorized;
  if (!grant.installationId) return frameJson(req, { error: 'frame_grant_invalid' }, 401);
  if (!hermesEnabled()) {
    return frameJson(req, { error: 'Hermes Agent integration is not enabled. Set MAGNUS_HERMES_ENABLED=true to enable it.' }, 503);
  }
  const frameBase = `${PROXY_BASE}/${FRAME_SEGMENT}/${frame.grant}`;

  let installation: HermesInstallation | null;
  try {
    installation = chooseHermesInstallation(await loadHermesInstallations(), grant.installationId, null, null)
      .installation as HermesInstallation | null;
  } catch (err) {
    const correlationId = crypto.randomUUID();
    console.error(`[hermes-target:${correlationId}] installation inventory failed`, err);
    return frameJson(req, { success: false, error: 'control_api_unavailable' }, 502);
  }
  if (!installation) return frameJson(req, { success: false, error: 'installation_not_found' }, 404);
  const state = frameSessionState(grant);
  const storedSessionToken = state.hermesTokens.get(installation.id);
  const search = swapFrameToken(upstreamSearchParams(req), storedSessionToken);

  const headers: Record<string, string> = {};
  const accept = req.headers.get('accept');
  if (accept) headers['accept'] = accept;
  const contentType = req.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  // The page only knows the placeholder; the real token is this session's server-side copy.
  const authorization = req.headers.get('authorization');
  if (storedSessionToken) headers['authorization'] = `Bearer ${storedSessionToken}`;
  else if (authorization && !authorization.includes(FRAME_TOKEN_PLACEHOLDER)) headers['authorization'] = authorization;

  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const bodyText = await req.text().catch(() => '');
    if (bodyText) body = bodyText;
  }

  try {
    const upstream = await requestHermesDashboardOverSsh({
      installation,
      req,
      upstreamPath,
      search,
      body,
      headers,
    });
    const upstreamContentType = String(upstream.headers['content-type'] ?? 'application/octet-stream');

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers['location'];
      if (typeof location === 'string') {
        const response = new NextResponse(null, { status: upstream.status, headers: frameHeaders(req) });
        response.headers.set('location', rewriteRedirectLocation(req, installation, frameBase, location));
        return response;
      }
    }

    if (upstreamContentType.includes('text/') || upstreamContentType.includes('javascript') || upstreamContentType.includes('json')) {
      const text = upstream.body.toString('utf-8');
      // Only a page this session fetched with its own grant refreshes this session's copy.
      const token = upstreamContentType.includes('html') ? dashboardSessionToken(text) : null;
      if (token && token !== FRAME_TOKEN_PLACEHOLDER) state.hermesTokens.set(installation.id, token);
      const shouldRewrite = upstreamContentType.includes('html') || upstreamContentType.includes('javascript') || upstreamContentType.includes('json') || upstreamContentType.includes('css');
      let output = withoutSessionToken(text, token ?? storedSessionToken);
      if (shouldRewrite) output = rewriteDashboardText(output, frameBase);
      if (upstreamContentType.includes('html')) output = injectFrameCompat(output);
      return new NextResponse(output, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: frameHeaders(req, upstreamContentType),
      });
    }

    return new NextResponse(new Uint8Array(upstream.body), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: frameHeaders(req, upstreamContentType),
    });
  } catch (err: unknown) {
    const correlationId = crypto.randomUUID();
    console.error(`[hermes-http:${correlationId}] dashboard proxy failed`, err);
    const response = frameJson(req, { success: false, error: 'hermes_proxy_unavailable', correlationId }, 502);
    response.headers.set('x-correlation-id', correlationId);
    return response;
  }
}

/** CORS preflight from the sandboxed (opaque-origin) dashboard. */
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
