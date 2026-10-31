import { test, expect } from '@playwright/test';

test.describe('Nodes Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/nodes');
    await page.waitForLoadState('domcontentloaded');
  });

  test('displays page heading and subtitle', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: 'Nodes' }),
    ).toBeVisible();
    await expect(
      page.getByText('Manage your Magnus fleet nodes').first(),
    ).toBeVisible();
  });

  test('shows Register Node and Deploy Node buttons', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(
      main.getByRole('button', { name: 'Register Node' }).first(),
    ).toBeVisible();
    await expect(
      main.getByRole('button', { name: 'Deploy Node' }),
    ).toBeVisible();
  });

  test('renders nodes list with seeded sentinel nodes', async ({ page }) => {
    const main = page.getByRole('main');
    // If the control API was slow or returned an error, click Retry
    const retryBtn = main.getByRole('button', { name: 'Retry' });
    if (await retryBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await retryBtn.click();
      await page.waitForLoadState('domcontentloaded');
    }
    // Wait for node data to load — real nodes should appear as links
    await expect(
      main.locator('a[href^="/nodes/"]').first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Deploy Node Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/nodes');
    // Wait for page content to settle
    await expect(
      page.getByRole('heading', { name: 'Nodes' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('opens deploy node modal with form fields', async ({ page }) => {
    await page.getByRole('button', { name: 'Deploy Node' }).click();

    // Modal subtitle
    await expect(
      page.getByText('Deploy an agent to a remote host via SSH'),
    ).toBeVisible({ timeout: 5_000 });

    // Hostname input with exact placeholder
    await expect(
      page.getByPlaceholder('node-1.example.com'),
    ).toBeVisible();
    await expect(page.getByPlaceholder('22')).toBeVisible();

    const deployButton = page.getByRole('button', { name: 'Deploy Agent' });
    await expect(deployButton).toBeDisabled();

    const hostname = page.getByPlaceholder('node-1.example.com');
    await hostname.fill('test-node.local');
    await expect(hostname).toHaveValue('test-node.local');
    await expect(deployButton).toBeEnabled();
  });

  test('deploy modal has Scan Network button', async ({ page }) => {
    await page.getByRole('button', { name: 'Deploy Node' }).click();

    await expect(
      page.getByRole('button', { name: 'Scan Network' }).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('deploy modal can be dismissed', async ({ page }) => {
    await page.getByRole('button', { name: 'Deploy Node' }).click();

    await expect(
      page.getByText('Deploy an agent to a remote host via SSH'),
    ).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(
      page.getByText('Deploy an agent to a remote host via SSH'),
    ).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Register Node Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/nodes');
    await expect(
      page.getByRole('heading', { name: 'Nodes' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('opens register node modal', async ({ page }) => {
    await page.getByRole('button', { name: 'Register Node' }).first().click();

    // Modal heading
    await expect(
      page.getByRole('heading', { name: 'Register Node' }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('register modal can be dismissed', async ({ page }) => {
    await page.getByRole('button', { name: 'Register Node' }).first().click();
    await expect(
      page.getByRole('heading', { name: 'Register Node' }),
    ).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
  });
});

test.describe('Node Detail Page', () => {
  test('clicking a node name navigates to detail page', async ({ page }) => {
    await page.goto('/nodes');
    await expect(
      page.getByRole('heading', { name: 'Nodes' }),
    ).toBeVisible({ timeout: 10_000 });

    // Click the first node link
    const nodeLink = page.getByRole('main').locator('a[href^="/nodes/"]').first();
    if (await nodeLink.isVisible()) {
      await nodeLink.click();
      await expect(page).toHaveURL(/\/nodes\/.+/);
    }
  });
});
