import { test, expect } from '@playwright/test';

// ─────────────────────────────────────────────────────────
// P1 Features: Dashboard UX improvements
// ─────────────────────────────────────────────────────────

test.describe('P1: Webhooks pages', () => {
  test('webhook list page renders', async ({ page }) => {
    await page.goto('/webhooks');
    await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible({ timeout: 15_000 });
  });

  test('new webhook form has event toggles and type selector', async ({ page }) => {
    await page.goto('/webhooks/new');
    await expect(page.getByRole('heading', { name: 'New Webhook' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder('My Webhook').first()).toBeVisible();
    await expect(page.getByPlaceholder('https://example.com/webhook').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'node.offline' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'command.failed' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'ai.anomaly' }).first()).toBeVisible();
    await expect(page.locator('select').first()).toBeVisible({ timeout: 15_000 });
  });
});
