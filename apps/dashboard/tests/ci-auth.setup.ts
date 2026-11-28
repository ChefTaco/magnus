import { test as setup, expect } from '@playwright/test';
import path from 'node:path';

// Signs in once as the harness administrator for the specs that reuse a session.
setup('sign in as the CI administrator', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('ci-admin');
  await page.getByLabel('Password', { exact: true }).fill('ci-only-browser-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible();
  await page.context().storageState({ path: path.join(import.meta.dirname, '.auth/ci-admin.json') });
});
