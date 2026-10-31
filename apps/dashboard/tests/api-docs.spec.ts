import { test, expect } from '@playwright/test';

test.describe('API Docs Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/api-docs');
    await expect(page.getByRole('heading', { name: 'API Documentation' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('loads Fleet API docs without error', async ({ page }) => {
    await page.getByRole('button', { name: 'Load Fleet API Docs' }).click();

    // Wait for spec to load — should show spec info, not an error
    await expect(page.locator('[class*="bg-red"]')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Raw JSON')).toBeVisible({ timeout: 15_000 });
  });
});
