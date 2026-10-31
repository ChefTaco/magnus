import { test, expect } from '@playwright/test';

const TEST_USER = process.env['TEST_USERNAME'] ?? 'admin';
const TEST_PASS = process.env['TEST_PASSWORD'] ?? '';

test.describe('Login', () => {
  // These tests run WITHOUT stored auth (fresh browser context)
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('login page renders brand and form', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: 'MAGNUS' })).toBeVisible();
    await expect(page.getByText('Fleet Management System')).toBeVisible();
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByText('Secure access required')).toBeVisible();
  });

  test('rejects invalid credentials', async ({ page }) => {
    await page.goto('/login');

    await page.locator('#username').fill('baduser');
    await page.locator('#password').fill('badpass');
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Should show an error and stay on login
    await expect(
      page.getByText(/invalid|unauthorized|failed/i),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('authenticates with valid credentials and redirects to dashboard', async ({
    page,
  }) => {
    await page.goto('/login');

    await page.locator('#username').fill(TEST_USER);
    await page.locator('#password').fill(TEST_PASS);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page).toHaveURL('/', { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible();
  });

  test('button shows loading state during authentication', async ({ page }) => {
    await page.goto('/login');

    await page.locator('#username').fill(TEST_USER);
    await page.locator('#password').fill(TEST_PASS);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // The button text changes to "Authenticating..." while submitting
    await expect(
      page.getByRole('button', { name: 'Authenticating...' }),
    ).toBeVisible();
  });
});

test.describe('Logout', () => {
  test('sign out returns to login page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible();

    // Click the Sign Out button in the header (icon-only, title attr)
    await page.getByTitle('Sign Out').click();

    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
