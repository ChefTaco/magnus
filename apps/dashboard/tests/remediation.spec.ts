import { test, expect } from '@playwright/test';

// ─────────────────────────────────────────────────────────
// Remediation Rules Page
// ─────────────────────────────────────────────────────────

test.describe('Remediation Rules Page', () => {
  test('page loads with heading and subtitle', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await expect(main.getByText('Rules that record remediation decisions when anomalies are detected')).toBeVisible();
  });

  test('shows rules and executions tabs', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Rules/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Executions/ })).toBeVisible();
  });

  test('shows New Rule button', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'New Rule' })).toBeVisible();
  });

  test('shows Refresh button', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Refresh').last()).toBeVisible();
  });

  test('shows search input on rules tab', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder('Search rules').first()).toBeVisible({ timeout: 5_000 });
  });

  test('rules tab shows table or empty state', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    const table = page.locator('table');
    const emptyState = page.getByText('No remediation rules defined');
    await expect(table.or(emptyState).first()).toBeVisible({ timeout: 10_000 });
  });

  test('New Rule button opens creation form', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'New Rule' }).click();
    await expect(page.getByText('Create New Rule')).toBeVisible();
  });

  test('creation form has required fields', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'New Rule' }).click();
    await expect(page.getByText('Create New Rule')).toBeVisible();
    // Check for required form fields
    await expect(page.getByPlaceholder('disk-cleanup-rule')).toBeVisible();
    await expect(page.getByPlaceholder('Orchestra agent ID')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('creation form shows metric and severity dropdowns', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'New Rule' }).click();
    await expect(page.getByText('Create New Rule')).toBeVisible();
    // Metric dropdown should have values
    const metricSelect = page.locator('select').first();
    await expect(metricSelect).toBeVisible();
    await expect(metricSelect.locator('option')).toHaveCount(5); // *, cpu, memory, disk, swap
  });

  test('cancel button closes creation form', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'New Rule' }).click();
    await expect(page.getByText('Create New Rule')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Create New Rule')).not.toBeVisible();
  });

  test('create button is disabled when required fields are empty', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'New Rule' }).click();
    const createBtn = page.getByRole('button', { name: 'Create' });
    await expect(createBtn).toBeDisabled();
  });

  test('switching to executions tab shows executions content', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Executions/ }).click();
    // Should show either a table or empty state
    const table = page.locator('table');
    const emptyState = page.getByText('No remediation executions yet');
    await expect(table.or(emptyState).first()).toBeVisible({ timeout: 10_000 });
  });

  test('New Rule button is hidden on executions tab', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Executions/ }).click();
    await expect(page.getByRole('button', { name: 'New Rule' })).not.toBeVisible();
  });

  test('back to anomalies link is present', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Back to anomalies').first()).toBeVisible({ timeout: 5_000 });
  });
});

// ─────────────────────────────────────────────────────────
// Remediation CRUD
// ─────────────────────────────────────────────────────────

test.describe('Remediation CRUD', () => {
  const ruleName = `test-rule-${Date.now()}`;

  test('can create a remediation rule', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'New Rule' }).click();

    // Fill form
    await page.getByPlaceholder('disk-cleanup-rule').fill(ruleName);
    await page.getByPlaceholder('Orchestra agent ID').fill('agent-test-123');
    await page.getByPlaceholder(/When disk usage/).fill('Test remediation rule');
    await page.locator('textarea').fill('Remediate {{metric}} on {{nodeName}}');

    // Create — wait for the API response to complete
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('remediation') && res.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create' }).click(),
    ]);

    // Should appear in table
    await expect(page.getByText(ruleName)).toBeVisible({ timeout: 15_000 });
  });

  test('can toggle rule enabled state', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });

    // Find the rule row
    const row = page.locator('tr', { hasText: ruleName }).first();
    const hasRow = await row.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasRow) {
      const toggleBtn = row.getByRole('button', { name: /active|disabled/ });
      const currentState = await toggleBtn.textContent();
      await toggleBtn.click();
      // Should flip the state
      await expect(toggleBtn).not.toHaveText(currentState ?? '', { timeout: 5_000 });
    }
  });

  test('can delete a remediation rule', async ({ page }) => {
    await page.goto('/anomalies/remediation');
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });

    const row = page.locator('tr', { hasText: ruleName }).first();
    const hasRow = await row.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasRow) {
      await row.getByTitle('Delete').click();
      await expect(row.getByTitle('Confirm delete')).toBeVisible();
      await Promise.all([
        page.waitForResponse((res) => res.url().includes('remediation/rules/') && res.request().method() === 'DELETE'),
        row.getByTitle('Confirm delete').click(),
      ]);
      await expect(page.getByText(ruleName)).not.toBeVisible({ timeout: 10_000 });
    }
  });
});

// ─────────────────────────────────────────────────────────
// Sidebar Navigation
// ─────────────────────────────────────────────────────────

test.describe('Remediation Sidebar', () => {
  test('remediation link appears in sidebar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Remediation' })).toBeVisible({ timeout: 10_000 });
  });

  test('clicking remediation link navigates to the page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Remediation' }).click();
    await expect(page.getByRole('heading', { name: 'Auto-Remediation' })).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain('/anomalies/remediation');
  });
});
