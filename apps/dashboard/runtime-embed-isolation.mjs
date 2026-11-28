/**
 * Isolation for the third-party dashboards the console proxies (the Hermes dashboard and the
 * deprecated Hive Router admin UI).
 *
 * Their pages are served from the console's own host, so without isolation a script flaw in
 * either would run with full console authority. Every proxied response therefore carries a
 * `sandbox` Content Security Policy without `allow-same-origin`: the browser gives the page an
 * opaque origin, so its script cannot read console cookies, storage or pages, and the console's
 * cross-site checks refuse its requests.
 *
 * An opaque-origin page cannot send the console session cookie either, so the proxy hands it a
 * frame grant instead: a signed, path-scoped capability that reaches only that one dashboard
 * (and, for Hermes, one installation), lives no longer than the console session that minted it
 * and dies with it on sign-out. Proxied URLs carry the grant as a path segment:
 * `<base>/_frame/<grant>/<upstream path>`.
 *
 * Plain ESM so the Next.js proxy (middleware), the route handlers and the TLS wrapper's
 * WebSocket bridge share one definition.
 */
import { createHmac } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { readDashboardEnvironment } from './runtime-environment.mjs';
import { verifyLocalSession } from './runtime-local-sessions.mjs';
import { resolveSessionSecret } from './runtime-session-secret.mjs';

/** Proxy base path of each embedded dashboard. */
export const EMBEDDED_DASHBOARDS = Object.freeze({
  hermes: '/api/hermes/dashboard',
  router: '/api/hive-router/dashboard',
});

/** Path segment that introduces a frame grant. */
export const FRAME_SEGMENT = '_frame';

const GRANT_AUDIENCE = 'magnus-embedded-dashboard';
const GRANT_KEY_LABEL = 'magnus-embedded-dashboard-grant/v1';

/** `sandbox` attribute for the console's `<iframe>`: scripts run, but in an opaque origin. */
export const EMBED_IFRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';

/**
 * Response policy for every proxied dashboard response. `sandbox` applies even when the page
 * is opened in its own tab; popups inherit it (no `allow-popups-to-escape-sandbox`).
 */
export const EMBED_CONTENT_SECURITY_POLICY = [
  `sandbox ${EMBED_IFRAME_SANDBOX} allow-modals`,
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

function grantKey(env = process.env) {
  // Derived, so a grant can never verify as a session cookie and the reverse.
  return createHmac('sha256', resolveSessionSecret(env)).update(GRANT_KEY_LABEL).digest();
}

function grantIssuer() {
  return String(readDashboardEnvironment('SESSION_ISSUER'));
}

/**
 * Mint a frame grant for one embedded dashboard from a verified console session.
 * @param {{ app: 'hermes' | 'router', installationId?: string | null, session: { username: string, sessionId?: string, provider?: string, exp: number } }} input
 */
export async function mintFrameGrant({ app, installationId = null, session }) {
  if (!Object.hasOwn(EMBEDDED_DASHBOARDS, app)) throw new Error(`Unknown embedded dashboard: ${app}`);
  // Named (Hive) sessions delegate through the Control API only; they never reach these proxies.
  if (session.provider === 'hive' || !session.sessionId) throw new Error('A local console session is required');
  const claims = { app, u: session.username, sid: session.sessionId, ...(installationId ? { ins: installationId } : {}) };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(grantIssuer())
    .setAudience(GRANT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(session.exp)
    .sign(grantKey());
}

/**
 * Verify a frame grant for `app`. Returns its scope, or null when the grant is invalid, expired,
 * minted for another dashboard, or its console session has ended.
 * @param {string} token
 * @param {'hermes' | 'router'} app
 * @returns {Promise<{ app: string, username: string, sessionId: string, installationId: string | null } | null>}
 */
export async function verifyFrameGrant(token, app) {
  if (typeof token !== 'string' || !token || token.length > 2048) return null;
  try {
    const { payload } = await jwtVerify(token, grantKey(), {
      algorithms: ['HS256'],
      issuer: grantIssuer(),
      audience: GRANT_AUDIENCE,
    });
    if (payload['app'] !== app || typeof payload['u'] !== 'string' || typeof payload['sid'] !== 'string') return null;
    const installationId = typeof payload['ins'] === 'string' ? payload['ins'] : null;
    if (!(await verifyLocalSession({ username: payload['u'], sessionId: payload['sid'] }))) return null;
    return { app, username: payload['u'], sessionId: payload['sid'], installationId };
  } catch {
    return null;
  }
}

/**
 * Split a request path into an embedded dashboard frame path, or return null.
 * @param {string} pathname
 */
export function parseFramePath(pathname) {
  for (const [app, base] of Object.entries(EMBEDDED_DASHBOARDS)) {
    const prefix = `${base}/${FRAME_SEGMENT}/`;
    if (!pathname.startsWith(prefix)) continue;
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    const grant = slash === -1 ? rest : rest.slice(0, slash);
    if (!grant) return null;
    return {
      app,
      base,
      grant,
      frameBase: `${prefix}${grant}`,
      upstreamPath: slash === -1 ? '/' : rest.slice(slash),
    };
  }
  return null;
}

/**
 * Split a catch-all route's segments (`[[...path]]`) into a grant and the upstream segments.
 * @param {string[] | undefined} segments
 * @returns {{ grant: string, rest: string[] } | null}
 */
export function splitFrameSegments(segments) {
  if (!segments || segments[0] !== FRAME_SEGMENT || !segments[1]) return null;
  return { grant: segments[1], rest: segments.slice(2) };
}

/**
 * Whether a cookie-authenticated request may mint a frame grant. Only the console itself (a
 * same-origin page) or the operator (a typed or bookmarked address) may: a sandboxed dashboard
 * navigating to the entry URL is a cross-site request, so it cannot mint a grant for another
 * installation. Clients without Fetch Metadata (curl, older browsers) are allowed.
 * @param {{ get(name: string): string | null }} headers
 */
export function frameEntryAllowed(headers) {
  if (headers.get('origin') === 'null') return false;
  const site = headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

/**
 * Apply the isolation headers to a proxied dashboard response. An opaque-origin page sends
 * `Origin: null`; the dashboards fetch with credentials, so CORS must name `null` exactly.
 * These responses carry no console credential: the grant in the URL is the only authority.
 * @param {Headers} headers
 * @param {string | null} requestOrigin
 */
export function applyFrameHeaders(headers, requestOrigin) {
  headers.set('content-security-policy', EMBED_CONTENT_SECURITY_POLICY);
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'SAMEORIGIN');
  headers.delete('set-cookie');
  if (requestOrigin === 'null') {
    headers.set('access-control-allow-origin', 'null');
    headers.set('access-control-allow-credentials', 'true');
  }
  headers.append('vary', 'Origin');
  return headers;
}

/**
 * Answer a CORS preflight for a frame path.
 * @param {{ get(name: string): string | null }} requestHeaders
 */
export function framePreflightHeaders(requestHeaders) {
  const headers = applyFrameHeaders(new Headers(), requestHeaders.get('origin'));
  headers.set('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE');
  const asked = requestHeaders.get('access-control-request-headers');
  if (asked && /^[A-Za-z0-9-]+(\s*,\s*[A-Za-z0-9-]+)*$/.test(asked) && asked.length <= 1024) {
    headers.set('access-control-allow-headers', asked);
  }
  headers.set('access-control-max-age', '600');
  return headers;
}

/**
 * Inline script that keeps sandboxed pages working: in an opaque origin `localStorage`,
 * `sessionStorage` and `document.cookie` throw, so give the page per-document stand-ins.
 */
export const FRAME_COMPAT_SCRIPT = '<script>(function(){'
  + 'function m(){var d=Object.create(null);return{get length(){return Object.keys(d).length},'
  + 'key:function(i){var k=Object.keys(d);return i<k.length?k[i]:null},'
  + 'getItem:function(k){k=String(k);return k in d?d[k]:null},'
  + 'setItem:function(k,v){d[String(k)]=String(v)},'
  + 'removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)}}}'
  + "['localStorage','sessionStorage'].forEach(function(n){try{void window[n].length}catch(e){"
  + 'try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(_){}}});'
  + "try{void document.cookie}catch(e){try{Object.defineProperty(document,'cookie',"
  + "{get:function(){return''},set:function(){},configurable:true})}catch(_){}}"
  + '})();</script>';

/**
 * Insert {@link FRAME_COMPAT_SCRIPT} before any of the page's own scripts.
 * @param {string} html
 */
export function injectFrameCompat(html) {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + FRAME_COMPAT_SCRIPT + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + FRAME_COMPAT_SCRIPT + html.slice(doctype[0].length);
  return FRAME_COMPAT_SCRIPT + html;
}
