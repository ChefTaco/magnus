import { test, expect } from '@playwright/test';
import path from 'node:path';

/**
 * Opt-in visual review: full-page screenshots of the showcase routes at desktop
 * and phone widths, with and without reduced motion. Not a pixel-baseline test
 * (live fleet data would make baselines flaky).
 *
 *   UI_REVIEW=1 PLAYWRIGHT_BASE_URL=... npx playwright test --project=chromium tests/visual-review.spec.ts
 *
 * Screenshots land in test-results/ui-review/ (override with UI_REVIEW_DIR).
 */

const enabled = process.env['UI_REVIEW'] === '1';
const outDir = process.env['UI_REVIEW_DIR'] ?? path.resolve(import.meta.dirname, '../test-results/ui-review');

const ROUTES: Array<{ name: string; path: string | (() => Promise<string | null>); ready: string }> = [
  { name: 'overview', path: '/', ready: 'overview-hero' },
  { name: 'mission-control', path: '/mission-control', ready: 'mission-control-page' },
  { name: 'nodes', path: '/nodes', ready: '' },
  { name: 'fleet-map', path: '/fleet-map', ready: 'fleet-map-view-toggle' },
  { name: 'security-fusion', path: '/security-fusion', ready: '' },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

test.describe('visual review', () => {
  test.skip(!enabled, 'Set UI_REVIEW=1 to capture review screenshots');

  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    for (const viewport of VIEWPORTS) {
      test(`${viewport.name} · ${reducedMotion}`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ reducedMotion });

        const routes = [...ROUTES];
        await page.goto('/nodes');
        const firstNode = await page.getByRole('main').locator('a[href^="/nodes/"]').first().getAttribute('href').catch(() => null);
        if (firstNode) routes.splice(3, 0, { name: 'node-detail', path: firstNode, ready: 'node-cockpit' });

        for (const route of routes) {
          await page.goto(route.path as string);
          if (route.ready) await expect(page.getByTestId(route.ready).first()).toBeVisible({ timeout: 15_000 });
          await page.waitForTimeout(2000); // let data load and gauges/meters finish their entry transition (SSE keeps the network busy)
          await page.screenshot({
            path: path.join(outDir, `${route.name}-${viewport.name}-${reducedMotion === 'reduce' ? 'reduced' : 'motion'}.png`),
            fullPage: true,
          });

          if (reducedMotion === 'reduce') {
            const scanline = await page.evaluate(() => getComputedStyle(document.body, '::after').animationName);
            expect(scanline).toBe('none');
            if (route.name === 'fleet-map') await expect(page.getByTestId('fleet-map-fps')).toContainText('static');
          }
        }
      });
    }
  }
});
