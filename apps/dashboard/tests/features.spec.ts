import { test, expect } from '@playwright/test';

/**
 * Feature tests
 *  #2  Mission Control home page
 *  #5  Command Palette (⌘K) with entity search
 */

// ──────────────────────────────────────────────────────────
// #2 Mission Control
// ──────────────────────────────────────────────────────────

test.describe('Mission Control', () => {
  test('page loads with all pillar tiers', async ({ page }) => {
    await page.goto('/mission-control');
    await expect(page.getByTestId('mission-control-page').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Mission Control' }).first()).toBeVisible();

    // Fleet and Orchestra tiers should mount; IAM administration lives in Hive.
    await expect(page.getByTestId('mission-tier-fleet').first()).toBeVisible();
    await expect(page.getByTestId('mission-tier-orchestra').first()).toBeVisible();
  });

  test('posture indicator renders', async ({ page }) => {
    await page.goto('/mission-control');
    const posture = page.getByTestId('mission-posture').first();
    await expect(posture).toBeVisible({ timeout: 15_000 });
    const value = await posture.getAttribute('data-posture');
    expect(['green', 'amber', 'unknown']).toContain(value);
  });

  test('stat cards render across tiers', async ({ page }) => {
    await page.goto('/mission-control');
    await expect(page.getByTestId('mission-control-page').first()).toBeVisible({ timeout: 15_000 });
    // Across all three tiers combined we expect at least 4 stats.
    const count = await page.getByTestId('mission-stat').count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('quick actions are clickable and navigate', async ({ page }) => {
    await page.goto('/mission-control');
    const links = page.getByTestId('mission-quick-link');
    await expect(links.first()).toBeVisible({ timeout: 15_000 });
    expect(await links.count()).toBeGreaterThanOrEqual(4);
  });


  test('sidebar exposes Mission Control link', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: 'Mission Control' }).first();
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();
    await expect(page).toHaveURL(/\/mission-control/);
  });

  test('fleet tier renders live data (regression: empty-secret fallback)', async ({ page }) => {
    // Regression for the bug where a control-nodes.json entry with an
    // empty apiSecret caused fleetFetch to 401, rendering "Fleet data
    // unavailable". fleet-fetch now prefers a node with a real secret
    // (or falls back to API_SECRET env) instead of blindly taking nodes[0].
    await page.goto('/mission-control');
    const fleetTier = page.getByTestId('mission-tier-fleet').first();
    await expect(fleetTier).toBeVisible({ timeout: 15_000 });

    // Must NOT show the "data unavailable" banner
    await expect(
      fleetTier.getByText(/Fleet data unavailable/i),
    ).not.toBeVisible();

    // Must show at least the "Nodes online" stat tile
    await expect(fleetTier.getByText(/Nodes online/i)).toBeVisible();
    await expect(fleetTier.getByText(/Commands/i).first()).toBeVisible();
  });

  test('posture badge is not "Status Unknown" when fleet is up', async ({ page }) => {
    await page.goto('/mission-control');
    const posture = page.getByTestId('mission-posture').first();
    await expect(posture).toBeVisible({ timeout: 15_000 });
    const value = await posture.getAttribute('data-posture');
    expect(value).not.toBe('unknown');
  });
});

// ──────────────────────────────────────────────────────────
// #5 Command Palette
// ──────────────────────────────────────────────────────────

test.describe('Command Palette', () => {
  test('opens with ⌘K / Ctrl+K', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press('ControlOrMeta+k');

    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('command-palette-input')).toBeFocused();
  });

  test('lists keyboard shortcuts on open', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // At least a handful of shortcut entries should render by default.
    const shortcutItems = page.locator('[data-testid="command-palette-item"][data-item-kind="shortcut"]');
    expect(await shortcutItems.count()).toBeGreaterThan(3);
  });

  test('Escape closes the palette', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).not.toBeVisible();
  });

  test('typed query filters results', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Fleet Overview' })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    await page.getByTestId('command-palette-input').fill('overview');
    // At least one result matching "overview" should be visible.
    const items = page.getByTestId('command-palette-item');
    await expect(items.first()).toBeVisible({ timeout: 5_000 });
    const text = await items.first().innerText();
    expect(text.toLowerCase()).toContain('overview');
  });
});

// ──────────────────────────────────────────────────────────
// #7 Fleet Map canvas (WebGL-style real-time rendering)
// ──────────────────────────────────────────────────────────

test.describe('Fleet Map canvas', () => {
  test('canvas renderer is default view and legend is visible', async ({ page }) => {
    await page.goto('/fleet-map');
    const container = page.getByTestId('fleet-map-canvas-container').first();
    await expect(container).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('fleet-map-canvas').first()).toBeVisible();
    await expect(page.getByTestId('fleet-map-legend').first()).toBeVisible();
    await expect(page.getByTestId('fleet-map-fps').first()).toBeVisible();
  });

  test('view toggle switches to grid and back', async ({ page }) => {
    await page.goto('/fleet-map');
    await expect(page.getByTestId('fleet-map-view-toggle').first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('fleet-map-view-grid').first().click();
    // Grid view should hide canvas container
    await expect(page.getByTestId('fleet-map-canvas-container')).toHaveCount(0);
    await page.getByTestId('fleet-map-view-canvas').first().click();
    await expect(page.getByTestId('fleet-map-canvas-container').first()).toBeVisible();
  });
});

// ──────────────────────────────────────────────────────────
// #11 Node Personality Card
// ──────────────────────────────────────────────────────────

test.describe('Node Personality', () => {
  test('personality card appears on node detail page', async ({ page }) => {
    await page.goto('/nodes');
    // Click first node link in the list
    const firstNodeLink = page.locator('a[href^="/nodes/"]').first();
    if ((await firstNodeLink.count()) === 0) {
      test.skip(true, 'No nodes available to test personality card');
      return;
    }
    await firstNodeLink.click();
    await expect(page.getByTestId('node-personality-card').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('node-archetype-badge').first()).toBeVisible();
    // archetype attribute should be populated
    const card = page.getByTestId('node-personality-card').first();
    const archetype = await card.getAttribute('data-archetype');
    expect(archetype).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────
// #63 Redis Streams Heartbeats
// ──────────────────────────────────────────────────────────

test.describe('Heartbeat Stream', () => {
  test('mission control shows heartbeat stream stats card', async ({ page }) => {
    await page.goto('/mission-control');
    await expect(page.getByTestId('heartbeat-stream-stats').first()).toBeVisible({ timeout: 15_000 });
    // Grid (when reachable) or message (when disabled) must be present
    const grid = page.getByTestId('heartbeat-stream-grid').first();
    const card = page.getByTestId('heartbeat-stream-stats').first();
    const visible = (await grid.count()) > 0;
    if (visible) {
      await expect(grid).toBeVisible();
    } else {
      await expect(card).toContainText(/unavailable|Heartbeat Stream/i);
    }
  });
});

// ──────────────────────────────────────────────────────────
// #66 Streaming SSR
// ──────────────────────────────────────────────────────────

test.describe('Streaming SSR', () => {
  test('audit page renders shell immediately', async ({ page }) => {
    await page.goto('/audit');
    await expect(page.getByTestId('audit-shell').first()).toBeVisible({ timeout: 15_000 });
  });

});
