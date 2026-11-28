/**
 * Isolation for the third-party dashboards the console proxies (the Hermes dashboard and the
 * deprecated Hive Router admin UI).
 *
 * Their pages are served from the console's own host, so without isolation a script flaw in
 * either would run with full console authority. Every proxied response therefore carries a
 * `sandbox` Content Security Policy without `allow-same-origin`: the browser gives the page an
 * opaque origin, so its script cannot read console cookies, storage or pages, and the console's
 * cross-site checks refuse its requests. `connect-src 'self'` keeps its fetches and sockets on
 * this host.
 *
 * An opaque-origin page cannot send the console session cookie either, so the proxy hands it a
 * frame grant instead: a signed, path-scoped capability that reaches only that one dashboard
 * (and, for Hermes, one installation). Proxied URLs carry it as a path segment,
 * `<base>/_frame/<grant>/<upstream path>`, so it lands in access logs and browser history; it is
 * therefore short-lived ({@link FRAME_GRANT_TTL_SECONDS}), never outlives its console session and
 * stops working on sign-out. The console frame renews it through `postMessage`
 * ({@link FRAME_COMPAT_SCRIPT}, `src/lib/frame-grant-relay.ts`); a reload with an expired grant
 * and the console cookie is re-minted ({@link frameGrantDecision}).
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

/** Lifetime of one frame grant. The console frame renews it well before it ends. */
export const FRAME_GRANT_TTL_SECONDS = 10 * 60;

/** How often an open Hermes WebSocket re-checks that its console session still exists. */
export const FRAME_SESSION_RECHECK_MS = 30_000;

/**
 * What the sandboxed Hermes page sees instead of the dashboard's real session token. The proxy
 * and the WebSocket bridge swap it for the real one, which never leaves the server.
 */
export const FRAME_TOKEN_PLACEHOLDER = 'magnus-frame';

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
  "connect-src 'self'",
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

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Mint a frame grant for one embedded dashboard from a verified console session.
 * @param {{ app: 'hermes' | 'router', installationId?: string | null, session: { username: string, sessionId?: string, provider?: string, exp: number } }} input
 */
export async function mintFrameGrant({ app, installationId = null, session }) {
  if (!Object.hasOwn(EMBEDDED_DASHBOARDS, app)) throw new Error(`Unknown embedded dashboard: ${app}`);
  // Named (Hive) sessions delegate through the Control API only; they never reach these proxies.
  if (session.provider === 'hive' || !session.sessionId) throw new Error('A local console session is required');
  const claims = {
    app,
    u: session.username,
    sid: session.sessionId,
    sexp: session.exp,
    ...(installationId ? { ins: installationId } : {}),
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(grantIssuer())
    .setAudience(GRANT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.min(session.exp, nowSeconds() + FRAME_GRANT_TTL_SECONDS))
    .sign(grantKey());
}

/**
 * Verify a frame grant for `app`. Returns its scope, or null when the grant is forged, minted for
 * another dashboard, or its console session has ended or expired. An expired grant is returned
 * (with `expired: true`) only when `allowExpired` is set, for the narrow uses in
 * {@link frameGrantDecision}.
 * @param {string} token
 * @param {'hermes' | 'router'} app
 * @param {{ allowExpired?: boolean }} [options]
 */
export async function verifyFrameGrant(token, app, { allowExpired = false } = {}) {
  if (typeof token !== 'string' || !token || token.length > 2048) return null;
  let payload;
  let expired = false;
  try {
    ({ payload } = await jwtVerify(token, grantKey(), {
      algorithms: ['HS256'],
      issuer: grantIssuer(),
      audience: GRANT_AUDIENCE,
    }));
  } catch (error) {
    // The signature is checked before the claims, so an expired grant's payload is authentic.
    if (!allowExpired || error?.code !== 'ERR_JWT_EXPIRED' || !error.payload) return null;
    payload = error.payload;
    if (payload['iss'] !== grantIssuer() || payload['aud'] !== GRANT_AUDIENCE) return null;
    expired = true;
  }
  try {
    if (payload['app'] !== app || typeof payload['u'] !== 'string' || typeof payload['sid'] !== 'string') return null;
    const sessionExpiresAt = typeof payload['sexp'] === 'number' ? payload['sexp'] : Number(payload['exp']);
    if (!(sessionExpiresAt > nowSeconds())) return null;
    const installationId = typeof payload['ins'] === 'string' ? payload['ins'] : null;
    if (!(await verifyLocalSession({ username: payload['u'], sessionId: payload['sid'] }))) return null;
    return {
      app,
      username: payload['u'],
      sessionId: payload['sid'],
      installationId,
      expired,
      expiresAt: Number(payload['exp']),
      sessionExpiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the console session behind a grant still exists. Throws when the session store cannot
 * be read, so callers can tell "signed out" from "Redis briefly unavailable".
 * @param {{ username: string, sessionId: string }} grant
 */
export async function frameSessionAlive(grant) {
  return verifyLocalSession({ username: grant.username, sessionId: grant.sessionId });
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
 * Static build files a page may still load with an expired grant (lazily imported chunks, fonts,
 * images): they carry no data and no authority. Everything else needs a current grant.
 * @param {string} upstreamPath
 */
export function frameStaticAsset(upstreamPath) {
  if (upstreamPath.includes('..')) return false;
  return /^\/(?:assets|fonts-terminal)\/[^?#]+$/.test(upstreamPath)
    || upstreamPath === '/favicon.ico'
    || /^\/dashboard-plugins\/[^?#]+\.(?:js|mjs|css|map|svg|png|woff2?)$/.test(upstreamPath);
}

/**
 * Decide a frame request: `allow` with a current grant (or an expired one for a static asset),
 * `remint` for a navigation with an expired grant (the route re-mints it when the request also
 * carries the console cookie for the same session), otherwise `refuse`.
 * @param {{ grant: string, app: 'hermes' | 'router', method: string, headers: { get(name: string): string | null }, upstreamPath: string }} request
 */
export async function frameGrantDecision({ grant, app, method, headers, upstreamPath }) {
  const verified = await verifyFrameGrant(grant, app, { allowExpired: true });
  if (!verified) return { action: 'refuse', error: 'frame_grant_invalid', grant: null };
  if (!verified.expired) return { action: 'allow', grant: verified };
  const read = method === 'GET' || method === 'HEAD';
  if (read && frameStaticAsset(upstreamPath)) return { action: 'allow', grant: verified };
  if (read && headers.get('sec-fetch-mode') === 'navigate') return { action: 'remint', grant: verified };
  return { action: 'refuse', error: 'frame_grant_expired', grant: verified };
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
 * Replace the sandboxed page's placeholder `token` query parameter (Hermes sends its session
 * token that way on WebSockets and downloads) with the real token kept on the server.
 * @param {string} search  `URLSearchParams` text, with or without the leading `?`
 * @param {string | null | undefined} token
 */
export function swapFrameToken(search, token) {
  const params = new URLSearchParams(search);
  if (token && params.get('token') === FRAME_TOKEN_PLACEHOLDER) params.set('token', token);
  return params.toString();
}

// ── Server-side state per console session ───────────────────────────────────
// The Hermes session tokens and router cookies the sandboxed pages cannot hold. On globalThis
// under a registered symbol, so every route bundle and the TLS wrapper share one copy.

const STATE = Symbol.for('magnus.embeddedDashboardState');
const MAX_STATE_SESSIONS = 256;

/** @returns {Map<string, { expiresAt: number, hermesTokens: Map<string, string>, routerCookies: Map<string, string> }>} */
function stateStore() {
  const holder = /** @type {Record<symbol, any>} */ (globalThis);
  return (holder[STATE] ??= new Map());
}

function purgeExpiredState(store) {
  const now = nowSeconds();
  for (const [sessionId, entry] of store) if (entry.expiresAt <= now) store.delete(sessionId);
}

/**
 * The server-side state of one console session's embedded dashboards, created on first use.
 * @param {{ sessionId: string, sessionExpiresAt: number }} grant
 */
export function frameSessionState(grant) {
  const store = stateStore();
  purgeExpiredState(store);
  let entry = store.get(grant.sessionId);
  if (entry) {
    store.delete(grant.sessionId);
  } else {
    entry = { expiresAt: grant.sessionExpiresAt, hermesTokens: new Map(), routerCookies: new Map() };
    while (store.size >= MAX_STATE_SESSIONS) store.delete(store.keys().next().value);
  }
  entry.expiresAt = Math.max(entry.expiresAt, grant.sessionExpiresAt);
  store.set(grant.sessionId, entry);
  return entry;
}

/**
 * The state of a console session, or null; never creates one.
 * @param {string} sessionId
 */
export function peekFrameSessionState(sessionId) {
  const entry = stateStore().get(sessionId);
  return entry && entry.expiresAt > nowSeconds() ? entry : null;
}

/**
 * Forget a console session's dashboard state on sign-out; without an id, every session's.
 * @param {string} [sessionId]
 */
export function clearFrameSessionState(sessionId) {
  if (sessionId === undefined) stateStore().clear();
  else stateStore().delete(sessionId);
}

/**
 * Inline script for every sandboxed page:
 * - in an opaque origin `localStorage`, `sessionStorage` and `document.cookie` throw, so give the
 *   page per-document stand-ins;
 * - renew the frame grant before it expires: ask the console frame (`postMessage` to the parent,
 *   echoing the current grant) and, once a new one arrives, send every later fetch, XHR,
 *   WebSocket and EventSource with it. In its own tab there is no console frame; the page then
 *   reloads (re-minted with the console cookie) when its API calls start failing.
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
  + "var g=(location.pathname.match(/\\/_frame\\/([^/?#]+)/)||[])[1];if(!g)return;"
  + "function x(t){try{return JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp||0}catch(e){return 0}}"
  + "function s(u){return typeof u==='string'?u.replace(/(\\/_frame\\/)[^/?#]+/,'$1'+g):u}"
  + 'var F=window.fetch;if(F)window.fetch=function(i,o){'
  + "if(typeof i==='string')i=s(i);else if(i instanceof URL)i=s(i.href);"
  + 'else if(i instanceof Request&&s(i.url)!==i.url)i=new Request(s(i.url),i);return F.call(this,i,o)};'
  + 'var O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){'
  + 'var a=[].slice.call(arguments);a[1]=s(String(a[1]));return O.apply(this,a)};'
  + "['WebSocket','EventSource'].forEach(function(n){var C=window[n];if(!C)return;"
  + 'var P=function(u,p){return arguments.length>1?new C(s(String(u)),p):new C(s(String(u)))};'
  + "P.prototype=C.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){if(k in C)P[k]=C[k]});"
  + 'window[n]=P});'
  // Links baked with an older grant follow the current one.
  + "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');"
  + 'if(a&&a.href&&s(a.href)!==a.href)a.href=s(a.href)},true);'
  + 'if(window.parent===window)return;'
  + "window.addEventListener('message',function(e){var d=e.data;"
  + "if(e.source!==window.parent||!d||d.type!=='magnus-frame-grant'||typeof d.grant!=='string')return;"
  + "g=d.grant;try{history.replaceState(history.state,'',s(location.href))}catch(_){}"
  + "window.dispatchEvent(new Event('magnus:frame-grant'))});"
  + "function r(){if(x(g)*1000-Date.now()<" + String(FRAME_GRANT_TTL_SECONDS * 500) + ')'
  + "window.parent.postMessage({type:'magnus-frame-refresh',grant:g},'*')}"
  + 'r();setInterval(r,15000)'
  + '})();</script>';

/**
 * Page for a navigation inside the console frame whose grant has expired (the frame's own
 * reload carries no console cookie): ask the console frame for a new grant, then load the same
 * address with it. Without a console frame to answer, it stays on the notice.
 */
export const FRAME_RECONNECT_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Reconnecting</title>'
  + '<script>(function(){var g=(location.pathname.match(/\\/_frame\\/([^/?#]+)/)||[])[1];'
  + "if(!g||window.parent===window)return;window.addEventListener('message',function(e){var d=e.data;"
  + "if(e.source!==window.parent||!d||d.type!=='magnus-frame-grant'||typeof d.grant!=='string')return;"
  + "location.replace(location.href.replace(/(\\/_frame\\/)[^/?#]+/,'$1'+d.grant))});"
  + "window.parent.postMessage({type:'magnus-frame-refresh',grant:g},'*')})();</script></head>"
  + '<body><p>The dashboard session expired. Reconnecting; if nothing happens, reconnect the frame from the console.</p></body></html>';

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
