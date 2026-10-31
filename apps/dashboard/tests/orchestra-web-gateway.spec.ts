import { expect, test } from '@playwright/test';

test.describe('Orchestra Web Gateway', () => {
  test.skip(process.env['MAGNUS_HERMES_ENABLED']?.trim().toLowerCase() !== 'true', 'Hermes Agent integration is not enabled');
  test('renders the Hermes gateway launch surface', async ({ page }) => {
    await page.goto('/orchestra/web-gateway');
    await expect(page.getByRole('heading', { name: 'Web Gateway', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Gateway Target' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hermes Web Gateway' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Launch' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Connect Frame' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText('Application error');
  });

  test('connects the selected inventory-bound Hermes frame', async ({ page }) => {
    await page.goto('/orchestra/web-gateway');
    // PLAYWRIGHT_HERMES_INSTALLATION selects an installation by visible text; otherwise use the first one.
    const wanted = process.env['PLAYWRIGHT_HERMES_INSTALLATION'];
    const options = page.getByLabel('Installation').locator('option');
    const installationId = await (wanted ? options.filter({ hasText: wanted }) : options).first().getAttribute('value');
    expect(installationId).toBeTruthy();
    await page.getByLabel('Installation').selectOption(installationId!);
    const connect = page.getByRole('button', { name: 'Connect Frame' }).first();
    await expect(connect).toBeEnabled({ timeout: 15_000 });
    await connect.click();
    const frame = page.frameLocator('iframe[title="Hermes Web Gateway"]');
    await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator('body')).not.toContainText(/destination_denied|Bad Gateway|proxy_unavailable/i);
  });
});
