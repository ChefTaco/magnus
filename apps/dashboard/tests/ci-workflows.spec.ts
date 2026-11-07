import { test, expect } from '@playwright/test';
import { SignJWT } from 'jose';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
test('real login, node read, failed mutation feedback and durable rollout controls', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('ci-admin');
  await page.getByLabel('Password', { exact: true }).fill('ci-only-browser-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.goto('/nodes/browser-ci-node');
  await expect(page.getByText('Browser CI node', { exact: true }).first()).toBeVisible();
  await page.goto('/application-operations');
  // Next.js may retain a hidden streamed copy outside the active main landmark.
  // Scope to the operator-visible form instead of matching hidden labels globally.
  const operations = page.getByRole('main');
  const maintenance = operations.locator('form').filter({
    has: page.getByRole('button', { name: 'Create maintenance window', exact: true }),
  });
  await maintenance.getByLabel('Node ID', { exact: true }).fill('browser-ci-node');
  await maintenance.getByLabel('Reason', { exact: true }).fill('Browser validation');
  await maintenance.getByLabel('Minutes', { exact: true }).fill('10081');
  // Send an invalid API mutation through the real session/proxy and assert the API contract.
  const failed = await page.request.post('/api/proxy/ops/maintenance', {
    data: {
      reason: 'short',
      nodeIds: ['browser-ci-node'],
      startsAt: new Date().toISOString(),
      endsAt: 'invalid',
    },
  });
  expect(failed.status()).toBe(400);
  const storage = operations.locator('section').filter({
    has: page.getByRole('heading', { name: 'Storage evidence', exact: true }),
  });
  await storage.getByLabel('Mount', { exact: true }).fill('/unsupported');
  await storage.getByRole('button', { name: 'Investigate mount', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /^Error:/ })).toBeVisible();
  await page.goto('/rollouts');
  await page.getByTitle('Pause', { exact: true }).first().click();
  await expect(page.getByText('paused', { exact: true })).toBeVisible();
  await page.getByTitle('Resume', { exact: true }).first().click();
  await expect(page.getByText('running', { exact: true })).toBeVisible();
  page.on('dialog', (d) => d.accept());
  await page.getByTitle('Abort', { exact: true }).first().click();
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
  const copiedCookie = (await page.context().cookies()).find(cookie => cookie.name === 'magnus_session')!;
  await page.getByTitle('Sign Out', { exact: true }).click();
  await expect(page).toHaveURL('/login');
  expect((await page.request.get('/api/auth/me', { headers: { Cookie: `${copiedCookie.name}=${copiedCookie.value}` } })).status()).toBe(401);
});
test('named viewer reads fleet metadata while retired security routes point to Cindertrace', async ({
  page,
  context,
}) => {
  const secret = 'ci-only-session-secret-0123456789abcdef0123456789';
  const sid = randomBytes(32).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 300;
  const access = await new SignJWT({ userId: 'browser-viewer', username: 'viewer', role: 'VIEWER' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode('ci-only-api-jwt-0123456789abcdef0123456789'));
  const cipher = createCipheriv(
    'aes-256-gcm',
    createHash('sha256').update('magnus:hive-session:v1\0').update(secret).digest(),
    Buffer.alloc(12),
  );
  cipher.setAAD(Buffer.from(sid));
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({ accessToken: access, userId: 'browser-viewer', expiresAt: exp }),
    ),
    cipher.final(),
  ]);
  const redis = new Redis(process.env['UI_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:55440');
  await redis.set(
    `magnus:hive:session:${sid}`,
    Buffer.concat([Buffer.alloc(12), cipher.getAuthTag(), encrypted]).toString('base64url'),
    'EX',
    300,
  );
  await redis.quit();
  const session = await new SignJWT({
    username: 'viewer',
    userId: 'browser-viewer',
    role: 'VIEWER',
    provider: 'hive',
    sessionId: sid,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('magnus-dashboard')
    .setAudience('magnus-dashboard-session')
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
  await context.addCookies([
    { name: 'magnus_session', value: session, url: 'http://localhost:55442', httpOnly: true },
  ]);
  expect((await page.request.get('/api/proxy/nodes')).status()).toBe(200);
  expect((await page.request.post('/api/proxy/rollouts/browser-ci-rollout/resume')).status()).toBe(
    403,
  );
  for (const resource of ['cases', 'evidence']) {
    const retired = await page.request.get(`/api/proxy/security-fusion/${resource}`);
    expect(retired.status()).toBe(410);
    expect((await retired.json()).error).toMatchObject({ code: 'SECURITY_FUSION_MOVED' });
  }
  expect((await page.request.get('/api/control-nodes')).status()).toBe(403);
});

test('named operator attribution survives the proxy and logout revokes delegated access', async ({
  page,
  context,
}) => {
  const secret = 'ci-only-session-secret-0123456789abcdef0123456789';
  const sid = randomBytes(32).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 300;
  const access = await new SignJWT({ userId: 'browser-operator', username: 'operator', role: 'OPERATOR' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode('ci-only-api-jwt-0123456789abcdef0123456789'));
  const cipher = createCipheriv(
    'aes-256-gcm',
    createHash('sha256').update('magnus:hive-session:v1\0').update(secret).digest(),
    Buffer.alloc(12),
  );
  cipher.setAAD(Buffer.from(sid));
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({ accessToken: access, userId: 'browser-operator', expiresAt: exp }),
    ),
    cipher.final(),
  ]);
  const redis = new Redis(process.env['UI_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:55440');
  await redis.set(
    `magnus:hive:session:${sid}`,
    Buffer.concat([Buffer.alloc(12), cipher.getAuthTag(), encrypted]).toString('base64url'),
    'EX',
    300,
  );
  await redis.quit();
  const session = await new SignJWT({
    username: 'operator',
    userId: 'browser-operator',
    role: 'OPERATOR',
    provider: 'hive',
    sessionId: sid,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('magnus-dashboard')
    .setAudience('magnus-dashboard-session')
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
  await context.addCookies([
    { name: 'magnus_session', value: session, url: 'http://localhost:55442', httpOnly: true },
  ]);
  const response = await page.request.post('/api/proxy/ops/maintenance', { data: {
    reason: 'Synthetic named operator acceptance', nodeIds: ['browser-ci-node'],
    startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString(),
  } });
  expect(response.status()).toBe(201);
  const window = (await response.json()).data;
  expect(window.actorId).toBe('browser-operator');
  const audit = await page.request.get('/api/proxy/audit?action=maintenance.create&actorId=browser-operator');
  expect((await audit.json()).data).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: 'browser-operator', targetId: window.id })]));
  expect((await page.request.post(`/api/proxy/ops/maintenance/${window.id}/cancel`)).status()).toBe(200);
  expect((await page.request.post('/api/auth/logout')).status()).toBe(200);
  // Replaying the old signed cookie cannot revive the revoked server-side token.
  await context.addCookies([{name:'magnus_session',value:session,url:'http://localhost:55442',httpOnly:true}]);
  expect((await page.request.get('/api/proxy/nodes')).ok()).toBe(false);
});
test('agent upgrade dialog greys out agents that cannot upgrade themselves', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('ci-admin');
  await page.getByLabel('Password', { exact: true }).fill('ci-only-browser-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL('/');
  // The fixture is a same-major prerelease behind this server's stable release.
  await expect(page.getByTestId('update-banner')).toContainText(/agents? behind the server/);
  await page.goto('/nodes');
  await page.getByRole('main').getByRole('button', { name: 'Upgrade Agents', exact: true }).click();
  const candidates = page.getByTestId('agent-upgrade-candidates');
  await expect(candidates.getByLabel('Upgrade Browser CI upgradable')).toBeEnabled();
  await expect(candidates.getByLabel('Upgrade Browser CI upgradable')).toBeChecked();
  await expect(candidates.getByLabel('Upgrade Browser CI node', { exact: true })).toBeDisabled();
  await expect(candidates).toContainText('agent version unknown');
  await expect(page.getByTestId('agent-upgrade-start')).toBeEnabled();
  await candidates.getByLabel('Upgrade Browser CI upgradable').uncheck();
  await expect(page.getByTestId('agent-upgrade-start')).toHaveText('Upgrade 0 agents');
  await expect(page.getByTestId('agent-upgrade-start')).toBeDisabled();
  await candidates.getByLabel('Upgrade Browser CI upgradable').check();
  // Check reports on every selected node and starts nothing. The fixture agent answers no preflight, and stays selectable.
  await page.getByTestId('agent-upgrade-check-button').click();
  const report = page.getByTestId('agent-upgrade-check');
  await expect(report).toContainText('Browser CI upgradable', { timeout: 30_000 });
  await expect(report).toContainText(/preflight (unreachable|unavailable)/);
  await expect(page.getByTestId('agent-upgrade-run')).toHaveCount(0);
});

test('major agent upgrades explain the manual path and keep controls reachable', async ({ page }) => {
  const nodes = Array.from({ length: 18 }, (_, index) => ({
    nodeId: `major-node-${index}`, name: `Major fixture ${index}`, version: '1.1.12',
    eligible: false, code: 'MAJOR_VERSION', layout: 'versioned', upgrade: null,
    reason: '1.1.12 -> 2.1.2 crosses a major version; upgrade this node by hand',
  }));
  await page.route('**/api/proxy/agents/upgrade/eligibility', route => route.fulfill({ json: {
    success: true, data: { version: '2.1.2', serverVersion: '2.1.2', upgradesEnabled: true, disabledReason: null, nodes,
      latestRun: { id: 'major-fixture-run', version: '1.1.12', status: 'succeeded', startedAt: '', finishedAt: '', concurrency: 1,
        message: 'Upgraded to 1.1.12', nodes: nodes.map(node => ({ ...node, from: '1.1.7', state: 'confirmed', detail: null })) } },
  } }));
  await page.route('**/api/proxy/system/updates', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.agents.behind = nodes.map(({ nodeId, name, version }) => ({ nodeId, name, version }));
    body.data.agents.expected = '2.1.2';
    body.data.agents.fixCommand = 'magnus-server agents upgrade';
    await route.fulfill({ json: body });
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill('ci-admin');
  await page.getByLabel('Password', { exact: true }).fill('ci-only-browser-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL('/');
  const banner = page.getByTestId('update-banner');
  await expect(banner).toContainText('18 agents require a manual major-version upgrade');
  await expect(banner).not.toContainText('magnus-server agents upgrade');
  await banner.getByRole('link', { name: 'Review agent upgrades' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upgrade agents' });
  await expect(dialog.getByTestId('agent-upgrade-major-notice')).toContainText('18 agents require a manual major-version upgrade to 2.1.2');
  await expect(dialog.getByTestId('agent-upgrade-empty')).toBeVisible();
  await expect(dialog.getByLabel('Upgrade Major fixture 0', { exact: true })).toBeDisabled();
  await expect(dialog.getByTestId('agent-upgrade-start')).toBeDisabled();
  await expect(dialog.locator('details')).not.toHaveAttribute('open');
  await expect(dialog.locator('summary')).toContainText('Previous rollout to 1.1.12');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    const bounds = await dialog.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByTestId('agent-upgrade-check-button').scrollIntoViewIfNeeded();
    await expect(dialog.getByTestId('agent-upgrade-check-button')).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  }
  await dialog.locator('summary').click();
  await expect(dialog.locator('details')).toHaveAttribute('open', '');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
