import { test, expect } from '@playwright/test';

test.describe('Codex Agent fleet UI', () => {
  test('overview exposes version and OAuth fleet posture', async ({ page }) => {
    await page.goto('/codex');
    await expect(page.getByRole('heading', { name: 'Codex Agents' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('main').getByText('Codex Installed').first()).toBeVisible();
    await expect(page.getByRole('main').getByText('OAuth Healthy').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fleet Posture' })).toBeVisible();
    await expect(page.getByText(/not installed|agent unreachable/i)).toHaveCount(0);
  });

  test('installations exposes ChatGPT OAuth actions without API-key login', async ({ page }) => {
    await page.goto('/codex/installations');
    await expect(page.getByRole('heading', { name: 'Codex Installations' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Checking installations...')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByText(/^\d+ managed nodes · \d+ Codex installations · \d+ authenticated with ChatGPT OAuth$/)).toBeVisible();
    await expect(page.getByText('Codex CLI was not detected on this node.')).toHaveCount(0);
    await expect(page.getByText('API-key credentials are not used by this Magnus flow.').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /API key/i })).toHaveCount(0);
  });
});
