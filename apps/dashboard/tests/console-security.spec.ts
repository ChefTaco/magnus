import { test, expect } from '@playwright/test';

const origin = 'http://localhost:55442';

test('the console refuses cross-site state changes and announces login errors', async ({ page, request }) => {
  // A foreign Origin is refused before the password is looked at.
  const forged = await request.post('/api/auth/login', {
    headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
    data: { username: 'ci-admin', password: 'ci-only-browser-password' },
  });
  expect(forged.status()).toBe(403);
  expect(await forged.json()).toEqual({ error: 'cross_site_request_refused' });

  // A wrong password is reported through an alert region.
  await page.goto('/login');
  await page.getByLabel('Username').fill('ci-admin');
  await page.getByLabel('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid credentials');

  await page.getByLabel('Password', { exact: true }).fill('ci-only-browser-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL('/');

  // Pages carry the console-wide policy.
  const home = await page.request.get('/');
  const policy = home.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("object-src 'none'");

  // With a valid session cookie, a cross-site proxy write is still refused; a same-origin one is not.
  const crossSite = await page.request.post('/api/proxy/nodes', { headers: { origin: 'https://evil.example.com' }, data: {} });
  expect(crossSite.status()).toBe(403);
  const sameSite = await page.request.post('/api/proxy/nodes', { headers: { origin }, data: {} });
  expect(await sameSite.text()).not.toContain('cross_site_request_refused');

  // The command palette is announced as a modal dialog.
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});
