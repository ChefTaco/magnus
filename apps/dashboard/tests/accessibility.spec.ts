import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

// Automated WCAG 2.1 A and AA checks (axe-core) over the main console pages. Serious and critical
// findings fail the run; minor and moderate ones are printed so they stay visible.
const pages = [
  '/',
  '/mission-control',
  '/nodes',
  '/nodes/browser-ci-node',
  '/application-operations',
  '/fleet-readiness',
  '/fleet-timeline',
  '/fleet-map',
  '/commands',
  '/anomalies',
  '/anomalies/remediation',
  '/governor/operations',
  '/rollouts',
  '/incidents',
  '/cron',
  '/files',
  '/logs',
  '/audit',
  '/webhooks',
  '/retention',
  '/api-docs',
  '/security-fusion',
  '/ardent',
  '/ardent/installations',
  '/ardent/profiles',
  '/codex',
  '/codex/installations',
];

// Entry transitions (fades, gauges) would otherwise be scanned mid-animation.
test.use({ contextOptions: { reducedMotion: 'reduce' } });

async function blockingViolations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const describe = (violation: (typeof violations)[number]) =>
    `${violation.impact} ${violation.id}: ${violation.help}\n` +
    violation.nodes.slice(0, 5).map((node) => `    ${node.target.join(' ')}`).join('\n');
  const minor = violations.filter((violation) => violation.impact === 'minor' || violation.impact === 'moderate');
  if (minor.length) console.log(`${new URL(page.url()).pathname}\n  ${minor.map(describe).join('\n  ')}`);
  return violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical').map(describe);
}

/**
 * Gives the page time to render its data, not just its loading state. A page whose fleet probe
 * outlasts the wait (the harness node never answers) is scanned as it stands: that is a state
 * users see too.
 */
async function settle(page: Page) {
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('main').getByText(/^Loading/)).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('/login has no serious accessibility violations', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible();
    expect(await blockingViolations(page)).toEqual([]);
  });
});

for (const path of pages) {
  test(`${path} has no serious accessibility violations`, async ({ page }) => {
    await page.goto(path);
    await settle(page);
    expect(await blockingViolations(page)).toEqual([]);
  });
}

test('the command palette has no serious accessibility violations', async ({ page }) => {
  await page.goto('/');
  await settle(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  expect(await blockingViolations(page)).toEqual([]);
});
