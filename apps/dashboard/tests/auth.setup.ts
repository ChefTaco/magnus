import { test as setup, expect } from '@playwright/test';
import path from 'node:path';

const authFile = path.join(import.meta.dirname, '.auth/user.json');

setup('authenticate', async ({ page }) => {
  const username = process.env['TEST_USERNAME'];
  const password = process.env['TEST_PASSWORD'];
  if (!username || !password) {
    throw new Error('Playwright auth requires TEST_USERNAME and TEST_PASSWORD.');
  }

  await page.goto('/login');

  // Fill credentials and submit.
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Wait for redirect to dashboard
  await expect(page).toHaveURL('/', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible({ timeout: 15_000 });

  // Save signed-in state for reuse by all browser projects
  await page.context().storageState({ path: authFile });
});
