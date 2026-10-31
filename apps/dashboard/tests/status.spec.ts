import { test, expect } from '@playwright/test';

test.describe('Fleet Overview (Dashboard)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('displays page heading and subtitle', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible();
    await expect(
      main.getByText(/^Real-time status of your Magnus fleet$/).first(),
    ).toBeVisible();
  });

  test('renders all four stat cards', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(main.getByText('Total Nodes')).toBeVisible({ timeout: 10_000 });
    await expect(main.getByText('Active Commands')).toBeVisible();
    // "Cron Jobs" also appears in sidebar — scope to main
    await expect(main.getByText('Cron Jobs').first()).toBeVisible();
    await expect(main.getByText('System Health')).toBeVisible();
  });

  test('stat cards display node count from seeded data', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(main.getByText('Total Nodes')).toBeVisible({ timeout: 10_000 });
    // Wait for stats API to respond — "Loading…" transitions to "X online" once data arrives
    await expect(main.getByText(/\d+ online/i)).toBeVisible({ timeout: 15_000 });
  });

  test('shows Recent Commands section', async ({ page }) => {
    await expect(page.getByRole('main').getByRole('heading', { name: 'Recent Commands' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('shows Recent Activity section', async ({ page }) => {
    await expect(page.getByRole('main').getByText('Recent Activity')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('shows Quick Actions section with four links', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Quick Actions' }).first()).toBeVisible({ timeout: 10_000 });

    // Scope links to main to avoid sidebar duplicates (e.g. "Cron Jobs")
    const manageNodes = main.getByRole('link', { name: /Manage Nodes/i });
    await expect(manageNodes).toBeVisible();
    await expect(manageNodes).toHaveAttribute('href', '/nodes');

    const runCommand = main.getByRole('link', { name: /Run Command/i });
    await expect(runCommand).toBeVisible();
    await expect(runCommand).toHaveAttribute('href', '/commands');

    const cronJobs = main.getByRole('link', { name: /Cron Jobs/i });
    await expect(cronJobs).toBeVisible();
    await expect(cronJobs).toHaveAttribute('href', '/cron');

    const editFiles = main.getByRole('link', { name: /Edit Files/i });
    await expect(editFiles).toBeVisible();
    await expect(editFiles).toHaveAttribute('href', '/files');
  });

  test('refresh button reloads stats', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(main.getByText('Total Nodes')).toBeVisible({ timeout: 10_000 });

    // Page-level Refresh button (not header icon)
    await main.getByRole('button', { name: 'Refresh' }).click();

    await expect(main.getByText('Total Nodes')).toBeVisible({ timeout: 10_000 });
  });
});
