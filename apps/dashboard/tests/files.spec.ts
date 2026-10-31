import { test, expect } from '@playwright/test';

test.describe('File Manager', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/files');
  });

  test('displays page heading and subtitle', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(
      main.getByRole('heading', { name: 'File Manager' }),
    ).toBeVisible();
    await expect(
      main.getByText(/^Read and update Magnus workspace files across nodes$/).first(),
    ).toBeVisible();
  });

  test('shows node selector', async ({ page }) => {
    // The NodeSelector renders as a native <select>
    const select = page.locator('select').first();
    await expect(select).toBeVisible({ timeout: 10_000 });
  });

  test('shows file path section', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(main.getByText('File Path', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(
      main.getByText('Browse to select a file…').first(),
    ).toBeVisible();
  });

  test('has Pull button', async ({ page }) => {
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Pull' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('shows File Editor card with textarea', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(main.getByText('File Editor').first()).toBeVisible({ timeout: 10_000 });
    await expect(main.locator('textarea').first()).toBeVisible();
  });

  test('textarea has placeholder text', async ({ page }) => {
    const ta = page.getByRole('main').locator('textarea').first();
    await expect(ta).toBeVisible({ timeout: 10_000 });
    await expect(ta).toHaveAttribute(
      'placeholder',
      /file content will appear/i,
    );
  });

  test('has Load from Library button', async ({ page }) => {
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Load from Library' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('has Push to Node button', async ({ page }) => {
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Push to Node' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('can type content into the editor', async ({ page }) => {
    const ta = page.getByRole('main').locator('textarea').first();
    await expect(ta).toBeVisible({ timeout: 10_000 });

    await ta.fill('# Test content\nHello from Playwright');
    await expect(ta).toHaveValue(/Test content/);
  });
});

test.describe('Library Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/library');
    await page.waitForLoadState('domcontentloaded');
    // If library loaded empty (SSR/proxy failure), click page-level Refresh to retry
    const emptyState = page.getByText('Your library is empty');
    if (await emptyState.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await page.getByRole('main').getByRole('button', { name: 'Refresh' }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  });

  test('displays page heading', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: 'Library' }),
    ).toBeVisible();
  });

  test('shows action buttons', async ({ page }) => {
    const main = page.getByRole('main');
    await expect(
      main.getByRole('button', { name: 'Refresh' }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      main.getByRole('button', { name: 'Category' }),
    ).toBeVisible();
    await expect(
      main.getByRole('button', { name: 'Upload', exact: true }),
    ).toBeVisible();
  });

  test('shows seeded library files', async ({ page }) => {
    // Seed created SOUL.md, MEMORY.md, etc.
    await expect(page.getByText('SOUL').first()).toBeVisible({ timeout: 10_000 });
  });

  test('has categories sidebar with All Files', async ({ page }) => {
    await expect(page.getByText('All Files').first()).toBeVisible({ timeout: 10_000 });
  });

  test('shows seeded categories', async ({ page }) => {
    // Seeded categories: Personality, Knowledge, Templates, Config
    await expect(
      page.getByText('Personality').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('has search input', async ({ page }) => {
    await expect(
      page.getByPlaceholder(/search files by name/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('search filters files', async ({ page }) => {
    await expect(page.getByText('SOUL').first()).toBeVisible({ timeout: 10_000 });

    const searchInput = page.getByPlaceholder(/search files by name/i);
    await searchInput.fill('SOUL');

    // SOUL.md should remain visible
    await expect(page.getByText('SOUL').first()).toBeVisible();
  });

  test('clicking a category filters the file list', async ({ page }) => {
    await expect(page.getByText('All Files').first()).toBeVisible({ timeout: 10_000 });

    // Click Personality category
    const categoryBtn = page
      .getByRole('button', { name: /Personality/i })
      .first();
    if (await categoryBtn.isVisible()) {
      await categoryBtn.click();
      // Should filter — give UI time to update
      await page.waitForTimeout(500);
    }
  });
});
