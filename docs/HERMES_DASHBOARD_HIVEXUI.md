# Hosting the Hermes dashboard in HiveXUI

Design note. Nothing here is built yet. It records what the standalone Magnus console does today to
embed the Hermes dashboard safely, and what [HiveXUI](https://github.com/ChefTaco/HiveXUI) would
need to host the dashboard instead, so the console's proxy can go when the console is deprecated.

## Today: the Magnus console

The console (`apps/dashboard`) proxies the dashboard of one Hermes installation over SSH from its own
host. Because the pages come from the console's host, they are isolated from it
(`runtime-embed-isolation.mjs`):

- **Sandbox.** Every proxied response carries `Content-Security-Policy: sandbox allow-scripts
  allow-forms allow-popups allow-downloads allow-modals; connect-src 'self'` without
  `allow-same-origin`, and the Web Gateway frame has the matching `sandbox` attribute. The dashboard
  runs in an opaque origin: its script cannot read the console's cookies, storage or pages, also
  when the dashboard is opened in its own tab, popups inherit the sandbox, and its fetches and
  sockets cannot reach another host.
- **Frame grant.** An opaque-origin page cannot send the console session cookie, so the entry URL
  (`/api/hermes/dashboard?installationId=…`, console session required, only from the console itself
  or a typed address) redirects to `/api/hermes/dashboard/_frame/<grant>/…`. The grant is a JWT
  signed with a key derived from `SESSION_SECRET`, scoped to one dashboard and one installation.
  Because it sits in the URL, where access logs, history and the page's own script can see it, it
  lives 10 minutes (never past the console session) and stops working as soon as that session
  ends. Frame requests and the WebSocket bridge are authorized by the grant alone; console cookies
  are neither read nor set on them.
- **Renewal.** Five minutes before a grant expires, the page asks the console frame for a new one
  (`postMessage`, echoing its grant); the console mints it with its cookie (`?mint=json` on the entry
  URL) and posts it back, and the page sends its later requests, sockets and link navigations with
  it (`src/lib/frame-grant-relay.ts` and the compatibility script). A reload in a tab carries the
  console cookie and is re-minted directly, and a dashboard in its own tab reloads itself (at most
  once a minute) when a call is refused with `frame_grant_expired`. A reload inside the frame,
  which carries no cookie, gets a page that asks the console frame every 3 seconds until it gets a
  grant or a refusal. An expired grant alone reaches nothing but the dashboard's static build
  files, so a URL copied from a log or the history is useless.
- **Paths.** The static-file exemption and the forwarded request use one path: the decoded
  segments, each re-encoded, refused outright when a segment is `.`, `..` or empty or holds a slash,
  backslash or NUL, and refused for the exemption when it holds any `%`. The router request is
  built with the WHATWG URL parser and must normalise to exactly the router base plus that path, so
  double-encoded traversals (`%252e%252e`) cannot turn an asset path into an API call.
- **Open sockets.** The WebSocket bridge checks the grant at the upgrade and then re-checks the
  console session every 30 seconds, closing the socket (a PTY included) once the session is signed
  out, revoked or its credentials change. It does not close a socket when the grant that opened it
  expires: renewal changes the URLs of later requests, not the socket already open.
- **Console API refusal.** The console's middleware refuses every `/api` request with
  `Origin: null`, and every cross-site or same-site `/api` request that is not a navigation, so the
  sandboxed page cannot call a console API with the browser's credentials (state changes were
  already refused).
- **Credentials stay server-side.** The Hermes session token the dashboard injects into its HTML is
  kept in the console process per console session and installation, and the page sees a
  placeholder instead (`magnus-frame`); the proxy sends the real token as the upstream bearer and
  swaps it into the `token` parameter of sockets and downloads. The router's cookies are kept per
  console session too. Signing out clears both; signing out everywhere clears that user's sessions
  only. The browser never holds a console-scoped credential
  or the dashboard's own token.
- **Compatibility.** The proxy rewrites the dashboard's root-relative URLs onto the frame path and
  adds per-document stand-ins for `localStorage`, `sessionStorage` and `document.cookie`, which throw
  in an opaque origin. Dashboard preferences (theme, language, collapsed panels) therefore last only
  until the frame reloads, and clipboard writes from the frame may be refused.

`tests/embedded-isolation.spec.ts` proves this in a browser against the deprecated router admin
proxy, which shares the mechanism; the route and bridge unit tests cover the Hermes specifics.

## What HiveXUI needs

### 1. A separate origin for the dashboard

Serve the dashboard from an origin of its own, for example `https://hermes-frame.example.com`, not
from HiveXUI's origin and not from a sibling that shares HiveXUI's cookies (no `Domain=` cookies on
the parent domain). With a distinct origin the frame can keep `allow-same-origin`, so the dashboard
gets real storage and clipboard, and still has no HiveXUI authority. Keep the response `sandbox`
policy without `allow-top-navigation`, set `frame-ancestors` on the dashboard origin to HiveXUI's
origin, and add that origin to HiveXUI's `frame-src`. One origin per installation
(`<installation>.hermes-frame.example.com`) would also isolate dashboards from each other; a shared
origin needs the grant to carry the installation, as today.

If a separate origin is not available, reuse today's model on HiveXUI's origin: opaque-origin
sandbox, path grant and a middleware that refuses `Origin: null` and cross-site API requests.

### 2. Transport through the fleet gateway

HiveXUI holds no SSH key. The dashboard's HTTP and WebSocket traffic should go through the
[fleet gateway](../services/fleet-gateway/README.md), which already holds the restricted SSH key and
carries the browser terminal. It needs a dashboard forwarder with the checks the console's proxy has
now:

- the destination comes from the Control API's Hermes inventory, never from the browser
  (`resolveApprovedHermesSshTarget`, `resolveHermesDashboardForwardTarget`);
- host keys pinned per installation and node; mismatches recorded as security events;
- managed SSH work admission, bounded bodies and responses, WebSocket backpressure limits and the
  WebSocket path allowlist (`hermesWebsocketPathAllowed`);
- metadata-only auditing (no request bodies, no terminal contents).

### 3. Authorization from the Oathweave session

- HiveXUI asks the Control API (or the gateway) for a dashboard grant for one installation. Decide the
  role: the dashboard includes a PTY on the node, so `OPERATOR` or `ADMIN` rather than any signed-in
  user, and recent identity verification like the terminal.
- Grants are short-lived (minutes) and renewable while the HiveXUI session lasts, bound to the
  Oathweave session and revoked with it; each grant is audited (`hermes.dashboard.open`, with the
  installation and the actor).
- The gateway sets its own `HttpOnly`, `Secure`, `SameSite=Strict` cookie on the dashboard origin
  from the grant (one redirect), so the dashboard needs no path grant and no URL rewriting.

### 4. Let Hermes address itself

Send `X-Forwarded-Prefix` (Hermes injects it as `window.__HERMES_BASE_PATH__`) or serve the dashboard
at the root of its origin, instead of rewriting HTML and JavaScript with regular expressions as the
console does. Keep the Hermes session token server-side and inject it as the upstream bearer; never
store it in the browser on HiveXUI's origin. Hermes's gated mode (its own sign-in, `hermes_session_at`
cookie and WebSocket tickets) then works unchanged on the dashboard origin.

### 5. Tests

Port the browser probe in `tests/embedded-isolation.spec.ts`: from inside the frame, try to read
HiveXUI's cookies and storage, reach the parent page, call HiveXUI and Control API endpoints with the
browser's credentials, and open another installation's dashboard; all must fail, while the
dashboard's own API and WebSocket work.

## Retiring the console proxy

Once HiveXUI hosts the dashboard, the console's Hermes proxy (`src/app/api/hermes/dashboard`), its
WebSocket bridge in `server-tls.mjs`, `src/lib/embedded-frame.ts`, `src/lib/frame-grant-relay.ts`
and `runtime-embed-isolation.mjs` go with the standalone console. The router admin
proxy (`/api/hive-router/dashboard`) is removed separately in the next major.
