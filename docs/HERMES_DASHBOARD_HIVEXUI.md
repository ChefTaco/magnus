# Hosting the Hermes dashboard in HiveXUI

Design note. Nothing here is built yet. It records what the standalone Magnus console does today to
embed the Hermes dashboard safely, and what [HiveXUI](https://github.com/ChefTaco/HiveXUI) would
need to host the dashboard instead, so the console's proxy can go when the console is deprecated.

## Today: the Magnus console

The console (`apps/dashboard`) proxies the dashboard of one Hermes installation over SSH from its own
host. Because the pages come from the console's host, they are isolated from it
(`runtime-embed-isolation.mjs`):

- **Sandbox.** Every proxied response carries `Content-Security-Policy: sandbox allow-scripts
  allow-forms allow-popups allow-downloads allow-modals` without `allow-same-origin`, and the Web
  Gateway frame has the matching `sandbox` attribute. The dashboard runs in an opaque origin: its
  script cannot read the console's cookies, storage or pages, also when the dashboard is opened in
  its own tab, and popups inherit the sandbox.
- **Frame grant.** An opaque-origin page cannot send the console session cookie, so the entry URL
  (`/api/hermes/dashboard?installationId=…`, console session required, only from the console itself
  or a typed address) redirects to `/api/hermes/dashboard/_frame/<grant>/…`. The grant is a JWT
  signed with a key derived from `SESSION_SECRET`, scoped to one dashboard and one installation, and
  valid only while the console session that minted it is: it expires with the session and dies on
  sign-out. Frame requests and the WebSocket bridge are authorized by the grant alone; console
  cookies are neither read nor set on them.
- **Console API refusal.** The console's middleware refuses every `/api` request with
  `Origin: null`, and every cross-site or same-site `/api` request that is not a navigation, so the
  sandboxed page cannot call a console API with the browser's credentials (state changes were
  already refused).
- **Credentials stay server-side.** The Hermes session token the dashboard injects into its HTML is
  kept in the console process and sent as the bearer for frame requests. The browser never holds a
  console-scoped credential for the dashboard.
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
WebSocket bridge in `server-tls.mjs`, the `/dashboard-plugins` and `/kanban` rewrites in
`next.config.ts` and `runtime-embed-isolation.mjs` go with the standalone console. The router admin
proxy (`/api/hive-router/dashboard`) is removed separately in the next major.
