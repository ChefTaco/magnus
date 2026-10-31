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
test('named viewer reads Security Fusion metadata but cannot mutate or read evidence', async ({
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
  expect((await page.request.get('/api/proxy/security-fusion/cases')).status()).toBe(200);
  expect((await page.request.get('/api/proxy/security-fusion/evidence')).status()).toBe(403);
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
