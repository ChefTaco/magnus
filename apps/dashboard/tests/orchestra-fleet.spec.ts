import { test, expect } from '@playwright/test';

test.describe('Hermes Agent fleet UI', () => {
  test.skip(process.env['MAGNUS_HERMES_ENABLED']?.trim().toLowerCase() !== 'true', 'Hermes Agent integration is not enabled');
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible({ timeout: 15_000 });
  });

  test('Overview page shows Hermes runtime posture', async ({ page }) => {
    await page.goto('/orchestra');
    await expect(page.getByRole('heading', { name: 'Hermes Agents' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Dashboard Tunnels').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Installation Inventory' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Profile Posture' })).toHaveCount(0);
    await expect(page.getByText('Default Profiles')).toHaveCount(0);
  });

  test('Installations page shows Hermes installation actions', async ({ page }) => {
    await page.goto('/orchestra/installations');
    await expect(page.getByRole('heading', { name: 'Hermes Installations' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Loading installation inventory...')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(/not detected|installed/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Hermes Update/i }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Gateway Restart/i }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /deploy/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /detect/i })).toHaveCount(0);
    await expect(page.locator('select')).toHaveCount(0);
  });

  test('Profiles page groups remote config and profiles by installation', async ({ page }) => {
    await page.goto('/orchestra/profiles');
    await expect(page.getByRole('heading', { name: 'Hermes Profiles' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Loading profiles...')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Config' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /enable api/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /new profile|describe|delete/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'Config' }).first().click();
    await expect(page.getByRole('dialog', { name: /config/i })).toBeVisible();
    await expect(page.getByLabel('Hermes config YAML')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Save Config/i })).toBeVisible();
  });

  test('Legacy /hermes/* URLs redirect to /orchestra/*', async ({ page }) => {
    await page.goto('/hermes/installations');
    await expect(page).toHaveURL(/\/orchestra\/installations/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Hermes Installations' })).toBeVisible({ timeout: 15_000 });
  });
});
