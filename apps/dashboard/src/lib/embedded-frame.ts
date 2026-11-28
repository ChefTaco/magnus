/**
 * Route-handler side of the embedded dashboard isolation (`runtime-embed-isolation.mjs`): the
 * cookie-authenticated entry that mints a frame grant, and the authorization of frame requests.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { COOKIE_NAME, verifySessionToken, type SessionPayload } from '@/lib/auth';
import {
  EMBEDDED_DASHBOARDS,
  FRAME_RECONNECT_PAGE,
  FRAME_SEGMENT,
  applyFrameHeaders,
  frameGrantDecision,
  mintFrameGrant,
  type EmbeddedDashboard,
  type FrameGrant,
} from '../../runtime-embed-isolation.mjs';

/** JSON answer on a frame path, with the isolation headers (the sandboxed page reads it). */
export function frameJson(req: NextRequest, body: unknown, status: number): NextResponse {
  const headers = applyFrameHeaders(new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' }), req.headers.get('origin'));
  return new NextResponse(JSON.stringify(body), { status, headers });
}

/** The console session of a cookie-authenticated request, or a 401 response. */
export async function requireConsoleSession(req: NextRequest): Promise<SessionPayload | NextResponse> {
  const sessionToken = req.cookies.get(COOKIE_NAME)?.value;
  const session = sessionToken ? await verifySessionToken(sessionToken) : null;
  return session ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function frameUrl(req: NextRequest, app: EmbeddedDashboard, grant: string, path: string[], search: string): URL {
  const url = req.nextUrl.clone();
  url.pathname = `${EMBEDDED_DASHBOARDS[app]}/${FRAME_SEGMENT}/${grant}/${path.join('/')}`;
  url.search = search;
  return url;
}

/**
 * Answer an entry request from a verified console session: a redirect into the frame, or, with
 * `?mint=json` (the console frame renewing its grant), the new grant as JSON.
 */
export async function enterFrame(req: NextRequest, input: {
  app: EmbeddedDashboard;
  session: SessionPayload;
  installationId?: string | null;
  path: string[];
  search: string;
}): Promise<NextResponse> {
  const grant = await mintFrameGrant({ app: input.app, installationId: input.installationId ?? null, session: input.session });
  const params = new URLSearchParams(input.search);
  const json = params.get('mint') === 'json';
  params.delete('mint');
  const url = frameUrl(req, input.app, grant, input.path, params.toString());
  const response = json
    ? NextResponse.json({ grant, frameUrl: `${url.pathname}${url.search}` })
    : NextResponse.redirect(url, 307);
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

/**
 * Authorize a frame request by its grant alone. A navigation with an expired grant is re-minted
 * (307 to the same path with a new grant) when it also carries the console cookie of the same
 * session, as a reload of a tab does; inside the console frame, whose reloads carry no cookie, the
 * frame is asked to renew it instead. Anything else expired or invalid gets 401.
 */
export async function authorizeFrame(req: NextRequest, input: {
  app: EmbeddedDashboard;
  grant: string;
  rest: string[];
}): Promise<FrameGrant | NextResponse> {
  const decision = await frameGrantDecision({
    grant: input.grant,
    app: input.app,
    method: req.method,
    headers: req.headers,
    upstreamPath: `/${input.rest.join('/')}`,
  });
  if (decision.action === 'allow') return decision.grant;
  if (decision.action === 'remint') {
    const sessionToken = req.cookies.get(COOKIE_NAME)?.value;
    const session = sessionToken ? await verifySessionToken(sessionToken) : null;
    if (session && session.sessionId === decision.grant.sessionId && session.username === decision.grant.username) {
      const grant = await mintFrameGrant({ app: input.app, installationId: decision.grant.installationId, session });
      const response = new NextResponse(null, {
        status: 307,
        headers: applyFrameHeaders(new Headers({ 'cache-control': 'no-store' }), req.headers.get('origin')),
      });
      response.headers.set('location', frameUrl(req, input.app, grant, input.rest, req.nextUrl.search).toString());
      return response;
    }
    // Inside the console frame a reload carries no console cookie: let the frame renew it.
    if (req.headers.get('sec-fetch-dest') === 'iframe') {
      const headers = applyFrameHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }), req.headers.get('origin'));
      return new NextResponse(FRAME_RECONNECT_PAGE, { status: 401, headers });
    }
    return frameJson(req, { error: 'frame_grant_expired' }, 401);
  }
  return frameJson(req, { error: decision.error }, 401);
}
