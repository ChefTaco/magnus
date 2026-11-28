import { createServer, type Server } from 'node:http';
import { test, expect, type Page } from '@playwright/test';

/**
 * A proxied third-party dashboard must not act with console authority. The harness points the
 * (deprecated) router admin proxy at a fixture served here, whose page script tries everything
 * a compromised dashboard would: read the console session cookie and storage, reach the parent
 * console page, call console APIs with the browser's credentials, and mint a new grant. The
 * Hermes dashboard proxy shares the same isolation (runtime-embed-isolation.mjs).
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

let server: Server;
const routerCookies: string[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    routerCookies.push(String(req.headers.cookie ?? ''));
    if (req.url === '/api/login') {
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

function expectIsolated(result: Record<string, unknown>, seen: Map<string, number[]>): void {
  expect(result['origin']).toBe('null');
  expect(String(result['cookie'])).not.toContain('magnus_session');
  // The stand-in storage keeps sandboxed pages working without touching the console's.
  expect(result['storage']).toBe('v');
  const attempts = result['attempts'] as Record<string, string>;
  for (const name of ['nodes', 'me', 'write', 'regrant']) expect(attempts[name], name).toBe('blocked');
  expect(attempts['writeNoCors']).toBe('opaque');
  // What reached the console was refused before any handler ran.
  for (const [path, statuses] of seen) {
    for (const status of statuses) expect([401, 403], `${path} answered ${status}`).toContain(status);
  }
  for (const path of ['/api/proxy/nodes', '/api/auth/me', '/api/proxy/commands', '/api/hive-router/dashboard']) {
    expect(seen.get(path)?.length ?? 0, `${path} reached the console`).toBeGreaterThan(0);
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
  expectIsolated(result, seen);
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
  expectIsolated(result, seen);
  // The console itself is unaffected.
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
});
