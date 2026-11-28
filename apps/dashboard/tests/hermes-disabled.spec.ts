import { test, expect } from '@playwright/test';

/**
 * The browser harness's second console (playwright.ci.config.ts, project ci-hermes-off) runs
 * without the Hermes Agent integration: its navigation, pages and proxies say so instead of
 * reaching the installation the main console serves.
 */
test.beforeAll(async ({ request }) => {
  // The harness starts both consoles; Playwright waits only for the first.
  await expect.poll(async () => (await request.get('/login').catch(() => null))?.status() ?? 0, { timeout: 60_000 }).toBe(200);
});

test('Hermes Agent pages explain how to enable the integration', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('nav a[href="/orchestra"]')).toHaveCount(0);
  await page.goto('/orchestra');
  // Scoped to main: during client navigation the streamed page can briefly render a second copy.
  await expect(page.getByRole('main').getByText('Hermes Agent integration not enabled')).toBeVisible();
});

test('the Hermes dashboard proxy answers 503 without the integration', async ({ page }) => {
  await page.goto('/');
  const response = await page.request.get('/api/hermes/dashboard');
  expect(response.status()).toBe(503);
  expect(await response.text()).toContain('MAGNUS_HERMES_ENABLED=true');
});
