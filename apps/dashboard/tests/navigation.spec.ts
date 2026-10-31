import { test, expect } from '@playwright/test';

test.describe('Sidebar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible({
      timeout: 10_000,
    });
  });

  const navItems = [
    { label: 'Nodes', href: '/nodes' },
    { label: 'Commands', href: '/commands' },
    { label: 'Operations', href: '/governor/operations' },
    { label: 'Rollouts', href: '/rollouts' },
    { label: 'Incidents', href: '/incidents' },
    { label: 'Cron Jobs', href: '/cron' },
    { label: 'Files', href: '/files' },
    { label: 'Logs', href: '/logs' },
    { label: 'Audit', href: '/audit' },
    { label: 'Webhooks', href: '/webhooks' },
  ];

  for (const item of navItems) {
    test(`"${item.label}" link navigates to ${item.href}`, async ({ page }) => {
      const link = page.locator(`nav a[href="${item.href}"]`);
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(item.href, { timeout: 10_000 });
    });
  }
});

const hermesEnabled = process.env['MAGNUS_HERMES_ENABLED']?.trim().toLowerCase() === 'true';
const securityConsoleUrl = process.env['MAGNUS_SECURITY_CONSOLE_URL']?.trim() || null;

test.describe('Hermes Agent Sidebar Navigation', () => {
  test.skip(!hermesEnabled, 'Hermes Agent integration is not enabled');
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible({
      timeout: 10_000,
    });
  });

  const orchestraNavItems = [
    { label: 'Overview', href: '/orchestra', heading: 'Hermes Agents' },
    { label: 'Installations', href: '/orchestra/installations', heading: 'Hermes Installations' },
    { label: 'Profiles', href: '/orchestra/profiles', heading: 'Hermes Profiles' },
    { label: 'Drift Cockpit', href: '/hermes-drift', heading: 'Hermes drift cockpit' },
    { label: 'Proxy Security', href: '/hermes-security', heading: 'Hermes proxy security' },
    { label: 'Web Gateway', href: '/orchestra/web-gateway', heading: 'Web Gateway' },
  ];

  for (const item of orchestraNavItems) {
    test(`Hermes Agent "${item.label}" link navigates to ${item.href}`, async ({ page }) => {
      const link = page.locator(`nav a[href="${item.href}"]`);
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(item.href, { timeout: 10_000 });
      await expect(page.getByRole('heading', { name: item.heading, level: 1 })).toBeVisible({ timeout: 15_000 });
    });
  }
});

test.describe('Codex Agent Sidebar Navigation', () => {
  const codexNavItems = [
    { href: '/codex', heading: 'Codex Agents' },
    { href: '/codex/installations', heading: 'Codex Installations' },
  ];

  for (const item of codexNavItems) {
    test(`Codex Agent link navigates to ${item.href}`, async ({ page }) => {
      await page.goto(item.href);
      await expect(page).toHaveURL(item.href, { timeout: 10_000 });
      await expect(page.getByRole('heading', { name: item.heading })).toBeVisible();
    });
  }
});

test.describe('Optional integrations', () => {
  test('Hermes Agent pages explain how to enable the integration', async ({ page }) => {
    test.skip(hermesEnabled, 'Hermes Agent integration is enabled');
    await page.goto('/');
    await expect(page.locator('nav a[href="/orchestra"]')).toHaveCount(0);
    await page.goto('/orchestra');
    await expect(page.getByText('Hermes Agent integration not enabled')).toBeVisible();
  });

  test('Security pages explain how to connect a console', async ({ page }) => {
    test.skip(securityConsoleUrl !== null, 'Security console is configured');
    await page.goto('/');
    await expect(page.locator('nav a[href="/security-fusion"]')).toHaveCount(0);
    await page.goto('/security-fusion');
    await expect(page.getByText('Security console not configured')).toBeVisible();
  });

  for (const route of ['/security-fusion/cases', '/security-fusion/cases/case-1', '/security-fusion/evidence']) {
    test(`${route} is not found without a security console`, async ({ request }) => {
      test.skip(securityConsoleUrl !== null, 'Security console is configured');
      const response = await request.get(route, { maxRedirects: 0 });
      expect(response.status()).toBe(404);
    });
  }

  test('Security nav links to the configured console', async ({ page }) => {
    test.skip(securityConsoleUrl === null, 'Security console is not configured');
    await page.goto('/security-fusion');
    await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible();
    await expect(page.locator(`nav a[href="${securityConsoleUrl!.replace(/\/+$/, '')}"]`)).toHaveCount(1);
  });
});

test.describe('Legacy Route Redirects', () => {
  test('/skills serves the Magnus skill catalogue', async ({ page }) => {
    await page.goto('/skills');
    await expect(page).toHaveURL('/skills', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
  });
});

test.describe('Retired Governor Navigation', () => {
  test('Governor links are absent from the sidebar', async ({ page }) => {
    await page.goto('/');
    for (const href of [
      '/governor/chat',
      '/governor/history',
      '/governor/visibility',
      '/governor/skills',
      '/governor/dashboards',
    ]) {
      await expect(page.locator(`nav a[href="${href}"]`)).toHaveCount(0);
    }
  });

  for (const route of [
    '/governor/visibility',
    '/governor/skills',
    '/governor/dashboards',
  ]) {
    test(`${route} is removed`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).toBe(404);
    });
  }
});
