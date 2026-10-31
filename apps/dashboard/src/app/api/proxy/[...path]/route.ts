import { verifyLocalSession } from '@/lib/local-sessions';
import { hiveCredential } from '@/lib/hive-login';
import type { SessionPayload } from '@/lib/auth';
import { type NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { validateProxyTarget } from '../allowed-targets';
import { COOKIE_NAME, getSecretKey, sessionVerificationOptions } from '@/lib/auth-constants';
import { controlApiFetch } from '@/lib/control-api-fetch';
import { resolveProxyTarget } from '@/lib/proxy-target';

/**
 * Server-side proxy for Control Node API calls.
 *
 * Control API TLS uses normal host trust or the private CA configured by
 * CONTROL_API_CA_PATH. Certificate validation is never bypassed.
 *
 * Usage:
 *   fetch('/api/proxy/nodes', {
 *     credentials: 'same-origin',
 *     headers: { 'x-proxy-target': 'https://remote-host:4000' },
 *   })
 *   → proxied to  https://remote-host:4000/api/v1/nodes
 */

async function hasValidDashboardSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;

  try {
    const { payload } = await jwtVerify(token, getSecretKey(), sessionVerificationOptions());
    return await verifyLocalSession(payload as unknown as SessionPayload);
  } catch {
    return false;
  }
}

async function proxyHandler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  if (!(await hasValidDashboardSession(req))) {
    return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 });
  }

  const { path } = await params;
  // Native EventSource cannot attach the per-request x-proxy-target header,
  // and the local controller intentionally has no browser-visible URL. Treat
  // an absent or blank selector as the server-owned canonical target; the
  // resolved target still passes through the same SSRF allow-list below.
  const targetBase = resolveProxyTarget(
    req.headers.get('x-proxy-target'),
    process.env['CONTROL_API_URL'],
  );

  if (!targetBase) {
    return NextResponse.json(
      { success: false, error: 'Missing x-proxy-target header and CONTROL_API_URL fallback' },
      { status: 400 },
    );
  }

  const limitBytes = Number(process.env['DASHBOARD_PROXY_BODY_LIMIT_BYTES'] ?? 1_048_576);
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    return NextResponse.json(
      { success: false, error: `Request body exceeds ${limitBytes} bytes` },
      { status: 413 },
    );
  }

  // ── SSRF protection: validate target against configured control nodes ──
  const check = await validateProxyTarget(targetBase);
  if (!check.allowed) {
    return NextResponse.json(
      { success: false, error: `Proxy target denied: ${check.reason}` },
      { status: 403 },
    );
  }

  // Reconstruct path + query string
  const apiPath = path.join('/');
  const search = req.nextUrl.searchParams.toString();
  // Docs routes are mounted at /api/docs/, not /api/v1/docs/
  const prefix = apiPath.startsWith('docs/') || apiPath === 'docs' ? '/api/' : '/api/v1/';
  const targetUrl = `${check.baseUrl}${prefix}${apiPath}${search ? `?${search}` : ''}`;

  // Forward relevant headers
  const headers: Record<string, string> = {};
  const forwardedKeys = ['content-type', 'x-idempotency-key', 'accept', 'x-trace-id'];
  for (const key of forwardedKeys) {
    const val = req.headers.get(key);
    if (val) headers[key] = val;
  }

  // Browser-supplied API/bearer credentials are intentionally ignored. The
  // canonical API secret is injected only for CONTROL_API_URL's exact origin;
  // other configured targets must own a stored server-side credential.
  const { payload } = await jwtVerify(
    req.cookies.get(COOKIE_NAME)!.value,
    getSecretKey(),
    sessionVerificationOptions(),
  );
  try {
    const delegated = await hiveCredential(payload as unknown as SessionPayload, check.baseUrl);
    Object.assign(
      headers,
      delegated ? { Authorization: `Bearer ${delegated}` } : check.credentialHeaders,
    );
  } catch {
    return NextResponse.json({ error: 'Delegated session unavailable' }, { status: 401 });
  }

  // Build fetch options
  const init: RequestInit = {
    method: req.method,
    headers,
    // Next.js: don't cache proxy responses
    cache: 'no-store',
    // Never replay server credentials to a redirect target.
    redirect: 'manual',
  };

  // Forward body for methods that have one
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      const body = await req.text();
      if (body) init.body = body;
    } catch {
      // no body — fine
    }
  }

  try {
    const ardentAction = /^ardent\/installations\/[A-Za-z0-9._-]{1,128}\/profiles\/[A-Za-z0-9_-]{1,64}\/action$/.test(apiPath) && req.method === 'POST';
    let timeoutMs: number | undefined;
    if (ardentAction && typeof init.body === 'string') {
      let value: unknown = null;
      try { value = JSON.parse(init.body) as unknown; } catch { /* Control API returns the validation error. */ }
      const action = value && typeof value === 'object' && 'action' in value ? value.action : null;
      timeoutMs = action === 'package-install' ? 610_000 : typeof action === 'string' && action.startsWith('service-') ? 120_000 : 50_000;
    }
    const upstream = await controlApiFetch(targetUrl, init, timeoutMs ? { timeoutMs } : undefined);
    if (upstream.status >= 300 && upstream.status < 400) {
      return NextResponse.json(
        { success: false, error: 'control_api_redirect_forbidden' },
        { status: 502 },
      );
    }

    // SSE responses must be streamed through — do NOT buffer via arrayBuffer()
    const contentType = upstream.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return new NextResponse(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no', // disable nginx buffering if reverse-proxied
        },
      });
    }

    const body = await upstream.arrayBuffer();

    return new NextResponse(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch (err: unknown) {
    const correlationId = crypto.randomUUID();
    console.error(`[control-api-proxy:${correlationId}] upstream request failed`, err);
    return NextResponse.json(
      { success: false, error: 'control_api_unavailable', correlationId },
      { status: 502, headers: { 'x-correlation-id': correlationId } },
    );
  }
}

export const GET = proxyHandler;
export const POST = proxyHandler;
export const PUT = proxyHandler;
export const PATCH = proxyHandler;
export const DELETE = proxyHandler;
